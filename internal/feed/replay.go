package feed

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

type ReplayRequest struct {
	Symbol   string  `json:"symbol"`
	Source   string  `json:"source"`
	Provider string  `json:"provider"`
	StartUS  int64   `json:"start_us"`
	EndUS    int64   `json:"end_us"`
	Speed    float64 `json:"speed"`
}

type ReplayState struct {
	State      string  `json:"state"`
	Symbol     string  `json:"symbol"`
	Source     string  `json:"source"`
	Provider   string  `json:"provider"`
	StartUS    int64   `json:"start_us"`
	EndUS      int64   `json:"end_us"`
	PositionUS int64   `json:"position_us"`
	Speed      float64 `json:"speed"`
	Message    string  `json:"message,omitempty"`
}

type replayCursor struct {
	eventUS int64
	kind    string
	id      int64
	valid   bool
}

type Replay struct {
	database *storage.Database
	store    *tape.Store

	mu         sync.RWMutex
	state      ReplayState
	request    ReplayRequest
	cursor     replayCursor
	resumeUS   int64
	cancel     context.CancelFunc
	generation uint64
}

func NewReplay(database *storage.Database, store *tape.Store, source, provider string, speed float64) *Replay {
	symbol := store.Active()
	return &Replay{
		database: database, store: store,
		state: ReplayState{State: "ready", Symbol: symbol, Source: source, Provider: provider, Speed: speed},
	}
}

func (r *Replay) Run(ctx context.Context) {
	r.setFeedStatus("ready", "choose a recording and press play")
	<-ctx.Done()
	r.stop(false)
}

func (r *Replay) SetSymbol(symbol string) {
	symbol = tape.NormalizeSymbol(symbol)
	if symbol == "" {
		return
	}
	r.mu.Lock()
	r.state.Symbol = symbol
	r.mu.Unlock()
}

func (r *Replay) DataRange(ctx context.Context, symbol, source, provider string) (storage.Range, error) {
	symbol = tape.NormalizeSymbol(symbol)
	if symbol == "" {
		return storage.Range{}, fmt.Errorf("invalid symbol")
	}
	return r.database.DataRange(ctx, symbol, source, provider)
}

func (r *Replay) MinuteBars(ctx context.Context, symbol, source, provider string, startUS, endUS int64) ([]storage.MinuteBar, error) {
	symbol = tape.NormalizeSymbol(symbol)
	if symbol == "" || startUS <= 0 || endUS < startUS {
		return nil, fmt.Errorf("invalid minute chart range")
	}
	return r.database.MinuteBars(ctx, symbol, source, provider, startUS, endUS)
}

func (r *Replay) Status() ReplayState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.state
}

func (r *Replay) Start(request ReplayRequest) error {
	request.Symbol = tape.NormalizeSymbol(request.Symbol)
	if request.Symbol == "" || request.StartUS <= 0 || request.EndUS <= request.StartUS {
		return fmt.Errorf("symbol and a valid start/end range are required")
	}
	if request.Source != "live" && request.Source != "historical" && request.Source != "all" {
		return fmt.Errorf("source must be live, historical, or all")
	}
	if request.Provider != "ibkr" && request.Provider != "massive" && request.Provider != "all" {
		return fmt.Errorf("provider must be ibkr, massive, or all")
	}
	if request.Speed < 0.1 || request.Speed > 20 {
		return fmt.Errorf("speed must be between 0.1 and 20")
	}
	dataRange, err := r.database.DataRange(context.Background(), request.Symbol, request.Source, request.Provider)
	if err != nil {
		return err
	}
	if dataRange.Trades == 0 || request.StartUS > dataRange.EndUS || request.EndUS < dataRange.StartUS {
		return fmt.Errorf("no %s/%s trades for %s in that range", request.Provider, request.Source, request.Symbol)
	}
	r.store.Activate(request.Symbol)
	r.store.Clear(request.Symbol)
	r.launch(request, request.StartUS, replayCursor{}, "replaying")
	return nil
}

func (r *Replay) Pause() error {
	r.mu.Lock()
	if r.state.State != "replaying" {
		r.mu.Unlock()
		return fmt.Errorf("replay is not running")
	}
	if r.cancel != nil {
		r.cancel()
		r.cancel = nil
	}
	r.generation++
	r.state.State = "paused"
	r.state.Message = "paused"
	r.mu.Unlock()
	r.setFeedStatus("paused", "replay paused")
	return nil
}

func (r *Replay) Resume() error {
	r.mu.RLock()
	if r.state.State != "paused" {
		r.mu.RUnlock()
		return fmt.Errorf("replay is not paused")
	}
	request := r.request
	cursor := r.cursor
	fromUS := r.resumeUS
	r.mu.RUnlock()
	if fromUS <= 0 {
		fromUS = request.StartUS
	}
	r.launch(request, fromUS, cursor, "replaying")
	return nil
}

func (r *Replay) Seek(targetUS int64) error {
	r.mu.RLock()
	request := r.request
	r.mu.RUnlock()
	if request.Symbol == "" {
		return fmt.Errorf("start a replay before seeking")
	}
	if targetUS < request.StartUS || targetUS > request.EndUS {
		return fmt.Errorf("seek minute is outside the selected replay range")
	}
	r.store.Clear(request.Symbol)
	r.launch(request, targetUS, replayCursor{}, "replaying")
	return nil
}

func (r *Replay) Stop() {
	r.stop(true)
}

func (r *Replay) stop(updateStatus bool) {
	r.mu.Lock()
	if r.cancel != nil {
		r.cancel()
		r.cancel = nil
	}
	r.generation++
	r.state.State = "stopped"
	r.state.Message = "stopped"
	r.mu.Unlock()
	if updateStatus {
		r.setFeedStatus("stopped", "replay stopped")
	}
}

func (r *Replay) launch(request ReplayRequest, fromUS int64, cursor replayCursor, stateName string) {
	r.mu.Lock()
	if r.cancel != nil {
		r.cancel()
	}
	r.generation++
	generation := r.generation
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.request = request
	r.cursor = cursor
	r.resumeUS = fromUS
	position := fromUS
	if cursor.valid {
		position = cursor.eventUS
	}
	r.state = ReplayState{
		State: stateName, Symbol: request.Symbol, Source: request.Source, Provider: request.Provider,
		StartUS: request.StartUS, EndUS: request.EndUS, PositionUS: position,
		Speed: request.Speed, Message: fmt.Sprintf("%.2fx %s/%s", request.Speed, request.Provider, request.Source),
	}
	r.mu.Unlock()
	r.setFeedStatus("replaying", fmt.Sprintf("%.2fx %s/%s", request.Speed, request.Provider, request.Source))
	go r.play(ctx, generation, request, fromUS, cursor)
}

func (r *Replay) play(ctx context.Context, generation uint64, request ReplayRequest, fromUS int64, cursor replayCursor) {
	rows, err := r.database.Events(ctx, request.Symbol, request.Source, request.Provider, fromUS, request.EndUS)
	if err != nil {
		r.finish(generation, "error", err.Error())
		return
	}
	defer rows.Close()
	var baseEventUS int64
	var baseWall time.Time
	for rows.Next() {
		event, err := storage.ScanEvent(rows)
		if err != nil {
			r.finish(generation, "error", err.Error())
			return
		}
		if cursor.valid && compareEvent(event, cursor) <= 0 {
			continue
		}
		if baseEventUS == 0 {
			baseEventUS = event.EventUS
			baseWall = time.Now()
		}
		due := baseWall.Add(time.Duration(float64(event.EventUS-baseEventUS)/request.Speed) * time.Microsecond)
		if err := waitUntil(ctx, due); err != nil {
			return
		}
		receivedUS := event.ReceivedUS
		if receivedUS <= 0 {
			// Historical APIs do not expose our original local receipt time. Their
			// precise event time is the closest replay clock; live recordings keep
			// the actual server-side microsecond receipt timestamp.
			receivedUS = event.EventUS
		}
		received := time.UnixMicro(receivedUS)
		if event.Kind == "quote" {
			r.store.UpdateQuote(request.Symbol, event.Bid, event.Ask, event.BidSize, event.AskSize)
		} else {
			if !event.ChartEligible {
				r.updatePosition(generation, event)
				continue
			}
			exchangeMS := event.ExchangeTimeMS
			if exchangeMS <= 0 {
				exchangeMS = event.MarketTimeUS / 1000
			}
			if event.Source == "historical" {
				r.store.AddTrade(request.Symbol, time.UnixMilli(exchangeMS), received, event.Price, event.Size)
			} else {
				r.store.AddRecordedTrade(request.Symbol, time.UnixMilli(exchangeMS), received, event.Price, event.Size, event.Class, event.Side, event.Bid, event.Ask)
			}
		}
		r.updatePosition(generation, event)
	}
	if err := rows.Err(); err != nil && !errorsIsCancellation(err) {
		r.finish(generation, "error", err.Error())
		return
	}
	r.finish(generation, "complete", "replay complete")
}

func (r *Replay) updatePosition(generation uint64, event storage.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if generation != r.generation {
		return
	}
	r.cursor = replayCursor{eventUS: event.EventUS, kind: event.Kind, id: event.ID, valid: true}
	r.resumeUS = event.EventUS
	r.state.PositionUS = event.EventUS
}

func (r *Replay) finish(generation uint64, stateName, message string) {
	r.mu.Lock()
	if generation != r.generation {
		r.mu.Unlock()
		return
	}
	r.cancel = nil
	r.state.State = stateName
	r.state.Message = message
	r.mu.Unlock()
	r.setFeedStatus(stateName, message)
}

func (r *Replay) setFeedStatus(stateName, message string) {
	r.store.SetStatus(tape.FeedStatus{Mode: "replay", State: stateName, Connected: stateName != "error", Message: message})
}

func compareEvent(event storage.Event, cursor replayCursor) int {
	if event.EventUS != cursor.eventUS {
		if event.EventUS < cursor.eventUS {
			return -1
		}
		return 1
	}
	eventRank := 1
	if event.Kind == "quote" {
		eventRank = 0
	}
	cursorRank := 1
	if cursor.kind == "quote" {
		cursorRank = 0
	}
	if eventRank != cursorRank {
		return eventRank - cursorRank
	}
	if event.ID < cursor.id {
		return -1
	}
	if event.ID > cursor.id {
		return 1
	}
	return 0
}

func waitUntil(ctx context.Context, due time.Time) error {
	delay := time.Until(due)
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func errorsIsCancellation(err error) bool {
	return err == context.Canceled || err == io.EOF
}
