package server

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

//go:embed web/*
var webFS embed.FS

type Server struct {
	cfg            config.Config
	store          *tape.Store
	feed           feed.Feed
	upgrader       websocket.Upgrader
	rvolMu         sync.Mutex
	rvolCache      map[string]rvolHistoryCache
	rvolMinuteBars func(context.Context, string, time.Time, int) ([]storage.MinuteBar, error)
	dailyBars      func(context.Context, string, time.Time, int) ([]storage.MinuteBar, error)
	dailyMu        sync.Mutex
	dailyCache     map[string]dailyHistoryCache
	panelDataMu    sync.Mutex
	panelDataCache map[string]panelDataCacheEntry
	now            func() time.Time
	liveChart      bool
	liveXtra       bool

	recorder       *storage.Database
	rewindPane     bool
	processStartUS int64
	symbolActiveMu sync.RWMutex
	symbolActiveUS map[string]int64
	uiEventMu      sync.Mutex
	uiEventAt      map[string]time.Time
	mode           string
	externalMu     sync.Mutex
	external       externalReplayState
	uiAudio        uiAudioState
	// externalControlMu serializes whole control operations. externalMu only
	// guards the state struct itself and must never be held across a rebuild.
	externalControlMu sync.Mutex
}

type rvolHistoryCache struct {
	throughUS int64
	bars      []storage.MinuteBar
}

type dailyHistoryCache struct {
	through string
	bars    []storage.MinuteBar
}

type streamMessage struct {
	Type         string                `json:"type"`
	Symbol       string                `json:"symbol,omitempty"`
	Snapshot     *tape.Snapshot        `json:"snapshot,omitempty"`
	Trades       []tape.Trade          `json:"trades,omitempty"`
	Quote        *tape.Quote           `json:"quote,omitempty"`
	History      []string              `json:"history,omitempty"`
	Status       *tape.FeedStatus      `json:"status,omitempty"`
	Display      *config.DisplayConfig `json:"display,omitempty"`
	Audio        *config.AudioConfig   `json:"audio,omitempty"`
	ReplayConfig *config.ReplayConfig  `json:"replay_config,omitempty"`
	Dropped      uint64                `json:"dropped,omitempty"`
	ServerTimeMS int64                 `json:"server_time_ms,omitempty"`
	MarketChart  bool                  `json:"market_chart,omitempty"`
	Xtra         bool                  `json:"xtra,omitempty"`
	Rewind       *config.RewindConfig  `json:"rewind,omitempty"`
	RewindPane   bool                  `json:"rewind_pane,omitempty"`
}

func New(cfg config.Config, store *tape.Store, source feed.Feed, liveChart ...bool) *Server {
	started := time.Now()
	server := &Server{
		cfg: cfg, store: store, feed: source,
		rvolCache: make(map[string]rvolHistoryCache), dailyCache: make(map[string]dailyHistoryCache), panelDataCache: make(map[string]panelDataCacheEntry), now: time.Now,
		uiEventAt: make(map[string]time.Time), processStartUS: started.UnixMicro(),
		symbolActiveUS: map[string]int64{store.Active(): started.UnixMicro()},
		upgrader: websocket.Upgrader{
			ReadBufferSize: 4096, WriteBufferSize: 64 * 1024,
			CheckOrigin: sameOrigin,
		},
	}
	server.liveChart = len(liveChart) > 0 && liveChart[0]
	server.liveXtra = len(liveChart) > 1 && liveChart[1]
	if source, ok := source.(interface {
		RVOLMinuteBars(context.Context, string, time.Time, int) ([]storage.MinuteBar, error)
	}); ok {
		server.rvolMinuteBars = source.RVOLMinuteBars
	}
	if source, ok := source.(interface {
		DailyBars(context.Context, string, time.Time, int) ([]storage.MinuteBar, error)
	}); ok {
		server.dailyBars = source.DailyBars
	}
	return server
}

// AttachRecorder wires the recording database so Live Rewind can backfill a
// sequence range the in-memory ring has overwritten, and so display changes are
// captured on the receipt timeline. Reads use their own connection pool.
func (s *Server) AttachRecorder(recorder *storage.Database) {
	s.recorder = recorder
}

// ReserveRewindPane keeps the second pane slot present from startup so entering
// a rewind never reflows the live tape, rolling rows, or time and sales.
func (s *Server) ReserveRewindPane(reserve bool) {
	s.rewindPane = reserve && s.cfg.Rewind.Enabled
}

func (s *Server) Serve(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/ticker", s.handleTicker)
	mux.HandleFunc("/api/tape/range", s.handleTapeRange)
	mux.HandleFunc("/api/ui-event", s.handleUIEvent)
	mux.HandleFunc("/api/replay", s.handleReplay)
	mux.HandleFunc("/api/external-replay/status", s.handleExternalReplayStatus)
	mux.HandleFunc("/api/external-replay/control", s.handleExternalReplayControl)
	mux.HandleFunc("/api/external-replay/ui", s.handleExternalReplayUI)
	mux.HandleFunc("/api/historical/coverage/check", s.handleCoverageCheck)
	mux.HandleFunc("/api/render", s.handleRender)
	mux.HandleFunc("/api/rvol-history", s.handleRVOLHistory)
	mux.HandleFunc("/api/daily-history", s.handleDailyHistory)
	mux.HandleFunc("/api/panel-data/daily-bars", s.handlePanelDailyBars)
	mux.HandleFunc("/api/panel-data/rth-context", s.handlePanelRTHContext)
	mux.HandleFunc("/ws", s.handleWebSocket)

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		return err
	}
	assets := http.FileServer(http.FS(sub))
	mux.Handle("/", securityHeaders(assets))

	httpServer := &http.Server{
		Addr: s.cfg.App.Addr, Handler: mux,
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		err := <-errCh
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (s *Server) SetMode(mode string) { s.mode = strings.ToLower(mode) }

func (s *Server) handleRender(w http.ResponseWriter, r *http.Request) {
	replay, ok := s.feed.(*feed.Replay)
	if !ok {
		http.Error(w, "start the application in render mode", http.StatusConflict)
		return
	}
	if r.Method == http.MethodGet {
		query := r.URL.Query()
		if query.Get("kind") == "config" {
			writeJSON(w, http.StatusOK, map[string]any{"audio": s.cfg.Audio, "display": s.cfg.Display})
			return
		}
		if query.Get("kind") != "audio" {
			http.Error(w, "unknown render resource", http.StatusBadRequest)
			return
		}
		startUS, err := parseInt64Query(query.Get("start_us"))
		if err != nil {
			http.Error(w, "invalid start_us", http.StatusBadRequest)
			return
		}
		endUS, err := parseInt64Query(query.Get("end_us"))
		if err != nil {
			http.Error(w, "invalid end_us", http.StatusBadRequest)
			return
		}
		events, err := replay.RenderAudioEvents(
			r.Context(), query.Get("symbol"), strings.ToLower(query.Get("source")),
			strings.ToLower(query.Get("provider")), startUS, endUS,
		)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"events": events})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	var request struct {
		Action   string  `json:"action"`
		Symbol   string  `json:"symbol"`
		Source   string  `json:"source"`
		Provider string  `json:"provider"`
		StartUS  int64   `json:"start_us"`
		EndUS    int64   `json:"end_us"`
		WarmupUS int64   `json:"warmup_us"`
		TargetUS int64   `json:"target_us"`
		Speed    float64 `json:"speed"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	var (
		lastSeq uint64
		err     error
	)
	switch strings.ToLower(request.Action) {
	case "prepare":
		err = replay.PrepareRender(feed.ReplayRequest{
			Symbol: request.Symbol, Source: request.Source, Provider: request.Provider,
			StartUS: request.StartUS, EndUS: request.EndUS, Speed: request.Speed,
		}, request.WarmupUS)
		if err == nil {
			snapshot := s.store.Snapshot(request.Symbol, 1)
			if len(snapshot.Trades) > 0 {
				lastSeq = snapshot.Trades[len(snapshot.Trades)-1].Seq
			}
		}
	case "step":
		lastSeq, err = replay.StepRender(request.TargetUS)
	default:
		err = fmt.Errorf("unknown render action %q", request.Action)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	snapshot := s.store.Snapshot(s.store.Active(), 1)
	writeJSON(w, http.StatusOK, map[string]any{
		"last_seq": lastSeq, "replay": replay.Status(), "quote": snapshot.Quote,
	})
}

func parseInt64Query(value string) (int64, error) {
	return strconv.ParseInt(value, 10, 64)
}

func (s *Server) handleRVOLHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	mode := strings.ToLower(s.store.Status().Mode)
	if mode != "live" {
		http.Error(w, "RVOL history warmup is available only for the IBKR live feed", http.StatusConflict)
		return
	}
	if s.rvolMinuteBars == nil {
		http.Error(w, "IBKR live history is unavailable", http.StatusServiceUnavailable)
		return
	}
	symbol := tape.NormalizeSymbol(r.URL.Query().Get("symbol"))
	if symbol == "" {
		symbol = s.store.Active()
	}
	through := s.now().UTC().Truncate(time.Minute)
	throughUS := through.UnixMicro()

	// Serialize cache misses so several browser tabs opened at the bell still
	// produce only one small aggregate request. This mutex is never used by the
	// feed or WebSocket path, so the tape remains independent of REST latency.
	s.rvolMu.Lock()
	defer s.rvolMu.Unlock()
	entry, cached := s.rvolCache[symbol]
	if !cached || entry.throughUS != throughUS {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		// Keep enough one-minute history for both the RVOL baseline and the
		// compact full-session day map in the tape chart.
		limit := 960
		if s.liveXtra {
			// A full current extended session plus the complete prior session is
			// needed for the optional chart reference levels.
			limit = 2200
		}
		bars, err := s.rvolMinuteBars(ctx, symbol, through, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		entry = rvolHistoryCache{throughUS: throughUS, bars: append([]storage.MinuteBar(nil), bars...)}
		s.rvolCache[symbol] = entry
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"symbol": symbol, "provider": "ibkr", "through_us": entry.throughUS, "bars": entry.bars,
	})
}

func (s *Server) handleDailyHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.dailyBars == nil {
		http.Error(w, "daily history is unavailable for this feed", http.StatusServiceUnavailable)
		return
	}
	symbol := tape.NormalizeSymbol(r.URL.Query().Get("symbol"))
	if symbol == "" {
		symbol = s.store.Active()
	}
	through := s.now().UTC()
	cacheKey := through.Format("2006-01-02")
	s.dailyMu.Lock()
	defer s.dailyMu.Unlock()
	entry, cached := s.dailyCache[symbol]
	if !cached || entry.through != cacheKey {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		bars, err := s.dailyBars(ctx, symbol, through, 90)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		entry = dailyHistoryCache{through: cacheKey, bars: append([]storage.MinuteBar(nil), bars...)}
		s.dailyCache[symbol] = entry
	}
	writeJSON(w, http.StatusOK, map[string]any{"symbol": symbol, "provider": "ibkr", "bars": entry.bars})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	symbol := s.store.Active()
	snapshot := s.store.Snapshot(symbol, 1)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "symbol": symbol, "status": snapshot.Status,
		"quote": snapshot.Quote, "last_trade": snapshot.Trades,
	})
}

func (s *Server) handleTicker(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	var request struct {
		Symbol string `json:"symbol"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	symbol := tape.NormalizeSymbol(request.Symbol)
	if symbol == "" {
		http.Error(w, "ticker must be 1-16 letters, digits, dot, or hyphen", http.StatusBadRequest)
		return
	}
	// Manual symbol changes and external cues share one operation lock. Without
	// it, a cue that was already rebuilding could publish and reattach after this
	// manual action had detached, taking control back from the operator.
	s.externalControlMu.Lock()
	defer s.externalControlMu.Unlock()
	s.detachExternalForManualAction()
	s.store.Activate(symbol)
	s.noteSymbolActive(symbol, s.now().UnixMicro())
	s.feed.SetSymbol(symbol)
	s.recordUIEvent(storage.UIEventRecord{Symbol: symbol, Kind: storage.UIEventSymbol, ValueText: symbol})
	writeJSON(w, http.StatusOK, map[string]any{"symbol": symbol, "history": s.store.Symbols()})
}

// handleTapeRange answers the Live Rewind buffer's gap requests. A client that
// fell behind the ring reports LAGGED, which would otherwise leave a hole in the
// rewind buffer during exactly the spike worth rewinding into. The ring answers
// whatever it still holds under one bounded read; storage answers the rest.
func (s *Server) handleTapeRange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.cfg.Rewind.Enabled {
		http.Error(w, "live rewind is disabled", http.StatusConflict)
		return
	}
	mode := strings.ToLower(s.store.Status().Mode)
	if mode != "live" && mode != "demo" {
		http.Error(w, "live rewind is available only for the IBKR live feed", http.StatusConflict)
		return
	}
	query := r.URL.Query()
	symbol := tape.NormalizeSymbol(query.Get("symbol"))
	if symbol == "" {
		symbol = s.store.Active()
	}
	seqFrom, fromErr := strconv.ParseUint(query.Get("seq_from"), 10, 64)
	seqTo, toErr := strconv.ParseUint(query.Get("seq_to"), 10, 64)
	if fromErr != nil || toErr != nil || seqFrom < 1 || seqTo < seqFrom {
		http.Error(w, "seq_from and seq_to must describe an ascending range starting at 1", http.StatusBadRequest)
		return
	}
	// One response stays within the batch bound the WebSocket path already uses;
	// the client pages through anything larger.
	limit := s.cfg.Tape.WebSocketMaxBatch
	requestedTo := seqTo
	if seqTo-seqFrom+1 > uint64(limit) {
		seqTo = seqFrom + uint64(limit) - 1
	}

	residentFrom := seqFrom
	ring, quote, oldest, newest, more := s.store.Range(symbol, seqFrom, seqTo, limit)
	if oldest > residentFrom {
		residentFrom = oldest
	}
	trades := ring
	served := "ring"
	// Anything below the ring floor has to come from the recording. Demo mode
	// keeps no recording, so it is ring-only by construction.
	if residentFrom > seqFrom && s.recorder != nil {
		storedTo := residentFrom - 1
		if storedTo > seqTo {
			storedTo = seqTo
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		stored, err := s.recorder.TradesByRingSeq(ctx, symbol, seqFrom, storedTo, s.processStartUS, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		served = "database"
		if len(ring) > 0 {
			served = "mixed"
		}
		trades = append(stored, ring...)
		if len(trades) > limit {
			trades = trades[:limit]
		}
	}
	if trades == nil {
		trades = []tape.Trade{}
	}
	// Completeness describes contiguous events actually served, judged against
	// what the client asked for rather than against the batch-bounded window this
	// response could cover. Serving nothing is never complete: a range above the
	// newest sequence has not happened yet, and one below the ring floor that
	// storage could not answer is a hole the caller must be told about.
	var lastSeq uint64
	contiguous := true
	for i, trade := range trades {
		if i > 0 && trade.Seq != trades[i-1].Seq+1 {
			contiguous = false
			break
		}
		lastSeq = trade.Seq
	}
	complete := len(trades) > 0 && contiguous && !more && trades[0].Seq == seqFrom && lastSeq >= requestedTo
	payload := map[string]any{
		"type": "trades", "symbol": symbol, "trades": trades, "quote": quote,
		"seq_from": seqFrom, "seq_to": lastSeq, "ring_oldest": oldest, "ring_newest": newest,
		"served": served, "complete": complete, "contiguous": contiguous,
	}
	if !complete {
		next := seqFrom
		if lastSeq >= seqFrom && contiguous {
			next = lastSeq + 1
		}
		payload["next_seq_from"] = next
	}
	writeJSON(w, http.StatusOK, payload)
}

// handleUIEvent records a display change the browser owns. Symbol changes are
// recorded where they arrive, in handleTicker.
func (s *Server) handleUIEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	var request struct {
		Kind   string  `json:"kind"`
		Symbol string  `json:"symbol"`
		Value  float64 `json:"value"`
		Text   string  `json:"text"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if request.Kind != storage.UIEventTickSize {
		http.Error(w, "kind must be tick_size", http.StatusBadRequest)
		return
	}
	symbol := tape.NormalizeSymbol(request.Symbol)
	if symbol == "" {
		symbol = s.store.Active()
	}
	// A dragged control must not turn into a write storm.
	if !s.allowUIEvent(request.Kind) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.recordUIEvent(storage.UIEventRecord{
		Symbol: symbol, Kind: request.Kind, ValueNum: request.Value, ValueText: request.Text,
	})
	writeJSON(w, http.StatusOK, map[string]any{"recorded": s.recorder != nil})
}

func (s *Server) allowUIEvent(kind string) bool {
	now := s.now()
	s.uiEventMu.Lock()
	defer s.uiEventMu.Unlock()
	if last, ok := s.uiEventAt[kind]; ok && now.Sub(last) < 250*time.Millisecond {
		return false
	}
	s.uiEventAt[kind] = now
	return true
}

func (s *Server) recordUIEvent(record storage.UIEventRecord) {
	// Only the live IBKR session owns this timeline. Replay and render read it.
	if s.recorder == nil || strings.ToLower(s.store.Status().Mode) != "live" {
		return
	}
	receivedUS := s.now().UnixMicro()
	record.EventUS = receivedUS
	record.ReceivedUS = receivedUS
	record.Source = "live"
	record.Provider = "ibkr"
	s.recorder.RecordUIEvent(record)
}

func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request) {
	replay, ok := s.feed.(*feed.Replay)
	if !ok {
		http.Error(w, "start the application in replay mode", http.StatusConflict)
		return
	}
	if r.Method == http.MethodGet {
		symbol := tape.NormalizeSymbol(r.URL.Query().Get("symbol"))
		if symbol == "" {
			symbol = s.store.Active()
		}
		source := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("source")))
		if source == "" {
			source = s.cfg.Replay.Source
		}
		provider := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("provider")))
		if provider == "" {
			provider = s.cfg.Replay.Provider
		}
		dataRange, err := replay.DataRange(r.Context(), symbol, source, provider)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		replayStatus := replay.Status()
		if dataRange.Trades == 0 || dataRange.StartUS <= 0 {
			writeJSON(w, http.StatusOK, map[string]any{
				"range": dataRange, "replay": replayStatus,
				"chart_bars": []storage.MinuteBar{}, "chart_end_us": int64(0),
			})
			return
		}
		chartEndUS := replayStatus.PositionUS
		if replayStatus.Symbol != symbol || chartEndUS <= 0 {
			chartEndUS = dataRange.StartUS
		}
		chartStartUS := replayChartDayStart(chartEndUS, dataRange.StartUS, s.cfg.App.Timezone)
		chartStartUS = s.extendChartStartWithCachedBars(r.Context(), symbol, source, provider, chartStartUS, chartEndUS)
		chartBars, err := replay.MinuteBars(r.Context(), symbol, source, provider, chartStartUS, chartEndUS)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"range": dataRange, "replay": replayStatus,
			"chart_bars": chartBars, "chart_end_us": chartEndUS,
		})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	var request struct {
		Action   string  `json:"action"`
		Symbol   string  `json:"symbol"`
		Source   string  `json:"source"`
		Provider string  `json:"provider"`
		StartUS  int64   `json:"start_us"`
		EndUS    int64   `json:"end_us"`
		TargetUS int64   `json:"target_us"`
		Speed    float64 `json:"speed"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	// Keep detach plus the requested transport action atomic with respect to an
	// external cue/sync/detach operation.
	s.externalControlMu.Lock()
	defer s.externalControlMu.Unlock()
	s.detachExternalForManualAction()
	var err error
	switch strings.ToLower(request.Action) {
	case "start":
		err = replay.Start(feed.ReplayRequest{Symbol: request.Symbol, Source: request.Source, Provider: request.Provider, StartUS: request.StartUS, EndUS: request.EndUS, Speed: request.Speed})
	case "pause":
		err = replay.Pause()
	case "resume":
		err = replay.Resume()
	case "seek":
		err = replay.SeekTo(request.TargetUS)
	case "stop":
		replay.Stop()
	default:
		err = fmt.Errorf("unknown replay action %q", request.Action)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, replay.Status())
}

// extendChartStartWithCachedBars reaches back to compact minute bars that have
// no detailed prints, which is the whole point of caching them: a replay that
// only downloaded the regular session still gets its premarket context, and with
// -xtra it gets the previous session behind the reference levels. Detailed
// prints are unaffected; only the chart window moves.
func (s *Server) extendChartStartWithCachedBars(ctx context.Context, symbol, source, provider string, chartStartUS, chartEndUS int64) int64 {
	if s.recorder == nil || source != "historical" || provider == "" || provider == "all" || chartEndUS <= 0 {
		return chartStartUS
	}
	// Five calendar days always contains the previous trading session, including
	// a long weekend or a holiday. Without -xtra there are no prior-session
	// levels to draw, so the window stays inside the current session's premarket.
	lookback := 12 * time.Hour
	if s.liveXtra {
		lookback = 5 * 24 * time.Hour
	}
	lookbackUS := chartStartUS - int64(lookback/time.Microsecond)
	firstUS, _, count, err := s.recorder.MinuteBarRange(ctx, symbol, provider, lookbackUS, chartEndUS)
	if err != nil || count == 0 || firstUS <= 0 || firstUS >= chartStartUS {
		return chartStartUS
	}
	return firstUS
}

func replayChartDayStart(positionUS, dataStartUS int64, timezone string) int64 {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return dataStartUS
	}
	position := time.UnixMicro(positionUS).In(location)
	dayStart := time.Date(position.Year(), position.Month(), position.Day(), 0, 0, 0, 0, location).UnixMicro()
	if dayStart > dataStartUS {
		return dayStart
	}
	return dataStartUS
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(4096)
	_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	batchEvery, _ := time.ParseDuration(s.cfg.Tape.WebSocketBatch)
	batchTicker := time.NewTicker(batchEvery)
	statusTicker := time.NewTicker(time.Second)
	pingTicker := time.NewTicker(20 * time.Second)
	defer batchTicker.Stop()
	defer statusTicker.Stop()
	defer pingTicker.Stop()

	symbol := s.store.Active()
	seq, err := s.writeSnapshot(conn, symbol)
	if err != nil {
		return
	}
	lastQuote := s.store.Snapshot(symbol, 0).Quote
	generation := s.store.Generation(symbol)
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case <-batchTicker.C:
			active := s.store.Active()
			if active != symbol {
				symbol = active
				seq, err = s.writeSnapshot(conn, symbol)
				if err != nil {
					return
				}
				generation = s.store.Generation(symbol)
				lastQuote = s.store.Snapshot(symbol, 0).Quote
				continue
			}
			if current := s.store.Generation(symbol); current != generation {
				seq, err = s.writeSnapshot(conn, symbol)
				if err != nil {
					return
				}
				generation = current
				lastQuote = s.store.Snapshot(symbol, 0).Quote
				continue
			}
			for drain := 0; drain < 8; drain++ {
				trades, quote, dropped, more, current := s.store.Since(symbol, seq, s.cfg.Tape.WebSocketMaxBatch)
				// The tape was replaced between the generation check above and
				// this read. Sending its contents as deltas would deliver a whole
				// reconstruction print by print; the next tick sends a snapshot.
				if current != generation {
					break
				}
				quoteChanged := quote != lastQuote
				if len(trades) == 0 && dropped == 0 && !quoteChanged {
					break
				}
				if len(trades) > 0 {
					seq = trades[len(trades)-1].Seq
				}
				if err := writeWebSocketJSON(conn, streamMessage{
					Type: "trades", Symbol: symbol, Trades: trades, Quote: &quote, Dropped: dropped,
				}); err != nil {
					return
				}
				lastQuote = quote
				if !more {
					break
				}
			}
		case <-statusTicker.C:
			status := s.store.Status()
			if err := writeWebSocketJSON(conn, streamMessage{
				Type: "status", Symbol: symbol, Status: &status, History: s.store.Symbols(), ServerTimeMS: s.streamTimeMS(),
			}); err != nil {
				return
			}
		case <-pingTicker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (s *Server) writeSnapshot(conn *websocket.Conn, symbol string) (uint64, error) {
	snapshot := s.store.Snapshot(symbol, s.cfg.Tape.SnapshotTrades)
	message := streamMessage{
		Type: "snapshot", Symbol: symbol, Snapshot: &snapshot,
		Display: &s.cfg.Display, Audio: &s.cfg.Audio, ReplayConfig: &s.cfg.Replay,
		ServerTimeMS: s.streamTimeMS(), MarketChart: s.liveChart, Xtra: s.liveXtra,
		Rewind: &s.cfg.Rewind, RewindPane: s.rewindPane,
	}
	if err := writeWebSocketJSON(conn, message); err != nil {
		return 0, err
	}
	if len(snapshot.Trades) == 0 {
		return 0, nil
	}
	return snapshot.Trades[len(snapshot.Trades)-1].Seq, nil
}

// streamTimeMS follows the replay timeline so receipt-time rolling windows
// survive pause, seek, and browser reload. Live feeds use the server clock.
func (s *Server) streamTimeMS() int64 {
	if replay, ok := s.feed.(*feed.Replay); ok {
		if position := replay.Status().PositionUS; position > 0 {
			return position / 1000
		}
	}
	return time.Now().UnixMilli()
}

func writeWebSocketJSON(conn *websocket.Conn, value any) error {
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return conn.WriteJSON(value)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	wanted := "//" + r.Host
	return strings.Contains(origin, wanted)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", fmt.Sprintf("default-src 'self'; connect-src 'self' ws://%s wss://%s; script-src 'self'; style-src 'self'; worker-src 'self' blob:", r.Host, r.Host))
		next.ServeHTTP(w, r)
	})
}
