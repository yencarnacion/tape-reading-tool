package feed

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/marketgateway"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
	"time"
)

// Gateway uses only the configured local adapter, including all chart history.
// It never creates a provider WebSocket or reads a provider credential.
type Gateway struct {
	epoch      atomic.Uint64
	cfg        config.MassiveConfig
	store      *tape.Store
	recorder   *storage.Database
	changed    chan string
	client     *marketgateway.Client
	mu         sync.Mutex
	quoteMS    int64
	dailyMu    sync.Mutex
	dailyCache map[string]gatewayDailyCache
}

func NewGateway(cfg config.MassiveConfig, s *tape.Store, r *storage.Database) *Gateway {
	c, _ := marketgateway.New(cfg.GatewayURL, cfg.GatewayToken)
	return &Gateway{cfg: cfg, store: s, recorder: r, client: c, changed: make(chan string, 1)}
}
func (f *Gateway) SetSymbol(s string) {
	if s = tape.NormalizeSymbol(s); s != "" {
		select {
		case f.changed <- s:
		default:
			select {
			case <-f.changed:
			default:
			}
			select {
			case f.changed <- s:
			default:
			}
		}
	}
}
func (f *Gateway) status(state, msg string, connected bool) {
	f.store.SetStatus(tape.FeedStatus{Epoch: f.epoch.Load(), Mode: "live", Provider: "massive", State: state, Message: msg, Connected: connected})
}
func (f *Gateway) Run(ctx context.Context) {
	if f.client == nil {
		f.status("error", "Configure the market-data gateway", false)
		return
	}
	defer f.client.Close()
	go func() {
		var table tape.ConditionTable
		if f.client.Get(ctx, "/rest/v3/reference/conditions?asset_class=stocks&data_type=trade&limit=1000", &table) == nil {
			tape.SetMassiveConditions(table)
		}
	}()
	defer f.status("stopped", "", false)
	symbol := f.store.Active()
	retry := 250 * time.Millisecond
	for ctx.Err() == nil {
		f.epoch.Add(1)
		f.status("connecting", "Massive via gateway; resynchronizing", false)
		f.mu.Lock()
		f.quoteMS = 0
		f.store.ClearTopOfBook(symbol)
		f.mu.Unlock()
		started := time.Now()
		cycle, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func(s string) { done <- f.cycle(cycle, s) }(symbol)
		select {
		case <-ctx.Done():
			cancel()
			<-done
			return
		case symbol = <-f.changed:
			retry = 250 * time.Millisecond
			cancel()
			<-done
			continue
		case e := <-done:
			cancel()
			f.status("reconnecting", e.Error(), false)
		}
		if time.Since(started) > 5*time.Second {
			retry = 250 * time.Millisecond
		}
		select {
		case <-ctx.Done():
			return
		case symbol = <-f.changed:
			retry = 250 * time.Millisecond
		case <-time.After(retry):
			retry = min(2*time.Second, retry*2)
		}
	}
}
func (f *Gateway) cycle(ctx context.Context, symbol string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	defer func() { cancel(); wg.Wait() }()
	return f.client.Stream(ctx, symbol, "T,Q", func(name string, data json.RawMessage) error {
		switch name {
		case "hello":
			var h marketgateway.Hello
			_ = json.Unmarshal(data, &h)
			f.status(h.Feed, "Massive via gateway · "+h.Feed+" · event timestamps", true)
			wg.Add(1)
			go func() { defer wg.Done(); f.snapshot(ctx, symbol) }()
		case "market":
			var e marketgateway.Event
			if json.Unmarshal(data, &e) != nil {
				return fmt.Errorf("invalid gateway event")
			}
			f.event(symbol, e)
		}
		return nil
	})
}
func (f *Gateway) event(symbol string, e marketgateway.Event) {
	if e.Symbol != symbol || symbol != f.store.Active() || e.EventMS <= 0 {
		return
	}
	received := time.Now()
	if e.Channel == "Q" {
		var q struct {
			Bid float64 `json:"bp"`
			Ask float64 `json:"ap"`
			BS  float64 `json:"bs"`
			AS  float64 `json:"as"`
		}
		if json.Unmarshal(e.Data, &q) != nil {
			return
		}
		f.quote(symbol, e.EventMS, q.Bid, q.Ask, q.BS, q.AS, received)
		return
	}
	if e.Channel != "T" {
		return
	}
	var t massiveStreamTrade
	if json.Unmarshal(e.Data, &t) != nil || t.Price <= 0 {
		return
	}
	conditions := formatConditionCodes(t.Conditions)
	flags := tape.MassiveIntradayFlags(conditions, time.UnixMilli(e.EventMS))
	if t.Size <= 0 {
		flags = tape.RulesPresent
	}
	tr := f.store.AddTradeWithRules(symbol, time.UnixMilli(e.EventMS), received, t.Price, t.Size, flags, conditions)
	if f.recorder != nil {
		f.recorder.RecordTrade(storage.TradeRecord{Symbol: symbol, EventUS: tr.ReceivedUS, ReceivedUS: tr.ReceivedUS, MarketTimeUS: e.EventMS * 1000, RingSeq: tr.Seq, ExchangeTimeMS: e.EventMS, Price: t.Price, Size: t.Size, Class: tr.Class, Side: tr.Side, Bid: tr.Bid, Ask: tr.Ask, Exchange: strconv.Itoa(int(t.Exchange)), Conditions: conditions, Source: "live", Provider: "massive"})
	}
}
func (f *Gateway) quote(symbol string, at int64, bid, ask, bs, as float64, received time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if symbol != f.store.Active() || at < f.quoteMS || at <= 0 || bid <= 0 || ask <= 0 || bid > ask {
		return
	}
	f.quoteMS = at
	f.store.UpdateQuote(symbol, bid, ask, bs, as)
	if f.recorder != nil {
		f.recorder.RecordQuote(storage.QuoteRecord{Symbol: symbol, EventUS: received.UnixMicro(), ReceivedUS: received.UnixMicro(), Bid: bid, Ask: ask, BidSize: bs, AskSize: as, Source: "live", Provider: "massive"})
	}
}
func (f *Gateway) snapshot(ctx context.Context, symbol string) {
	var s struct {
		Ticker struct {
			Prev struct {
				C float64 `json:"c"`
			} `json:"prevDay"`
			Quote struct {
				Bid float64 `json:"p"`
				Ask float64 `json:"P"`
				BS  float64 `json:"s"`
				AS  float64 `json:"S"`
				T   int64   `json:"t"`
			} `json:"lastQuote"`
			Trade massiveStreamTrade `json:"lastTrade"`
		} `json:"ticker"`
	}
	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil || symbol != f.store.Active() {
			return
		}
		if f.client.Get(ctx, "/rest/v2/snapshot/locale/us/markets/stocks/tickers/"+url.PathEscape(symbol), &s) == nil {
			break
		}
		if attempt >= 2 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(250 * time.Millisecond * time.Duration(1<<attempt)):
		}
	}
	if ctx.Err() != nil || symbol != f.store.Active() {
		return
	}
	f.store.UpdatePreviousClose(symbol, s.Ticker.Prev.C)
	tr := s.Ticker.Trade
	tradeMS := marketgateway.Millis(tr.Timestamp)
	if tr.Size > 0 && tradeMS <= time.Now().Add(time.Second).UnixMilli() && tape.UpdatesLastPrice(tape.MassiveTradeFlags(formatConditionCodes(tr.Conditions))) {
		f.store.UpdateLastPrice(symbol, tr.Price, tradeMS)
	}
	q := s.Ticker.Quote
	at := marketgateway.Millis(q.T)
	if time.Now().UnixMilli()-at <= 5000 {
		f.quote(symbol, at, q.Bid, q.Ask, q.BS, q.AS, time.Now())
	}
}
func gatewayBars(bs []marketgateway.Bar) []storage.MinuteBar {
	out := make([]storage.MinuteBar, 0, len(bs))
	for _, b := range bs {
		out = append(out, storage.MinuteBar{TimeUS: b.T * 1000, Open: b.O, High: b.H, Low: b.L, Close: b.C, Volume: b.V, DollarVolume: b.V * b.VW})
	}
	return out
}
func (f *Gateway) RVOLMinuteBars(ctx context.Context, s string, end time.Time, limit int) ([]storage.MinuteBar, error) {
	if tape.NormalizeSymbol(s) == "" || limit < 1 {
		return nil, fmt.Errorf("invalid history request")
	}
	days := 7
	if limit > 5000 {
		days = 14
	}
	bs, e := f.client.Bars(ctx, s, "minute", end.AddDate(0, 0, -days), end)
	if e != nil {
		return nil, e
	}
	out := gatewayBars(bs)
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}

// Build RTH daily ranges from eligible minute aggregates: extended-hours prices
// must not alter the ADR calculation when switching providers.
func (f *Gateway) DailyBars(ctx context.Context, s string, end time.Time, limit int) ([]storage.MinuteBar, error) {
	if tape.NormalizeSymbol(s) == "" || limit < 1 || limit > 365 {
		return nil, fmt.Errorf("invalid daily history request")
	}
	loc, _ := time.LoadLocation("America/New_York")
	et := end.In(loc)
	end = time.Date(et.Year(), et.Month(), et.Day(), 0, 0, 0, 0, loc)
	key := s + "|" + end.Format("2006-01-02")
	f.dailyMu.Lock()
	cached, found := f.dailyCache[key]
	f.dailyMu.Unlock()
	if found && time.Since(cached.at) < time.Hour && len(cached.bars) >= limit {
		return append([]storage.MinuteBar(nil), cached.bars[len(cached.bars)-limit:]...), nil
	}
	bs, e := f.client.Bars(ctx, s, "minute", end.AddDate(0, 0, -limit*2-14), end)
	if e != nil {
		return nil, e
	}
	days := map[string]storage.MinuteBar{}
	keys := []string{}
	for _, b := range bs {
		if b.O <= 0 || b.C <= 0 || b.L <= 0 || b.H < max(b.O, b.C) || b.L > min(b.O, b.C) {
			continue
		}
		at := time.UnixMilli(b.T).In(loc)
		minute := at.Hour()*60 + at.Minute()
		if minute < 570 || minute >= 960 {
			continue
		}
		key := at.Format("2006-01-02")
		v, ok := days[key]
		if !ok {
			keys = append(keys, key)
			v = storage.MinuteBar{TimeUS: time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, loc).UnixMicro(), Open: b.O, High: b.H, Low: b.L}
		}
		v.High = max(v.High, b.H)
		v.Low = min(v.Low, b.L)
		v.Close = b.C
		v.Volume += b.V
		days[key] = v
	}
	sort.Strings(keys)
	if len(keys) > limit {
		keys = keys[len(keys)-limit:]
	}
	out := []storage.MinuteBar{}
	for _, k := range keys {
		out = append(out, days[k])
	}
	f.dailyMu.Lock()
	if f.dailyCache == nil {
		f.dailyCache = make(map[string]gatewayDailyCache)
	}
	for k, v := range f.dailyCache {
		if time.Since(v.at) >= time.Hour {
			delete(f.dailyCache, k)
		}
	}
	if len(f.dailyCache) >= 64 {
		for k := range f.dailyCache {
			delete(f.dailyCache, k)
			break
		}
	}
	if old := f.dailyCache[key]; len(out) > len(old.bars) {
		f.dailyCache[key] = gatewayDailyCache{bars: append([]storage.MinuteBar(nil), out...), at: time.Now()}
	}
	f.dailyMu.Unlock()
	return out, nil
}
func DownloadGatewayBars(ctx context.Context, cfg config.MassiveConfig, db *storage.Database, o HistoricalOptions) error {
	if tape.NormalizeSymbol(o.Symbol) == "" || !o.End.After(o.Start) || o.UseRTH {
		return fmt.Errorf("valid symbol and extended-hours range required")
	}
	c, e := marketgateway.New(cfg.GatewayURL, cfg.GatewayToken)
	if e != nil {
		return e
	}
	defer c.Close()
	bs, e := c.Bars(ctx, o.Symbol, "minute", o.Start, o.End.Add(time.Microsecond))
	if e != nil {
		return e
	}
	bars := gatewayBars(bs)
	if e = db.UpsertMinuteBars(ctx, o.Symbol, "massive", bars); e != nil {
		return e
	}
	return db.MarkCoverage(ctx, storage.Coverage{Symbol: o.Symbol, Provider: "massive", Kind: "minute_bars", StartUS: o.Start.UnixMicro(), EndUS: o.End.UnixMicro(), RowCount: int64(len(bars))})
}

type gatewayDailyCache struct {
	bars []storage.MinuteBar
	at   time.Time
}
