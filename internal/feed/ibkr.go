package feed

import (
	"context"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/scmhub/ibapi"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

type IBKR struct {
	cfg      config.IBKRConfig
	store    *tape.Store
	commands chan string

	mu         sync.RWMutex
	reqSymbols map[int64]string
	subs       map[string]*subscription
	nextReqID  int64
	usage      uint64
	client     *ibapi.EClient
	recorder   *storage.Database

	statsMu sync.Mutex
	stats   map[string]*streamStats
}

type subscription struct {
	symbol  string
	tradeID int64
	quoteID int64
	used    uint64
}

type streamStats struct {
	trades      uint64
	quotes      uint64
	lastTradeAt time.Time
	lastQuoteAt time.Time
}

type ibWrapper struct {
	ibapi.Wrapper
	feed *IBKR

	ready     chan struct{}
	closed    chan struct{}
	readyOnce sync.Once
	closeOnce sync.Once
}

func newIBWrapper(feed *IBKR) *ibWrapper {
	return &ibWrapper{
		feed:   feed,
		ready:  make(chan struct{}),
		closed: make(chan struct{}),
	}
}

func NewIBKR(cfg config.IBKRConfig, store *tape.Store, recorder *storage.Database) *IBKR {
	return &IBKR{
		cfg: cfg, store: store, recorder: recorder, commands: make(chan string, 32),
		reqSymbols: make(map[int64]string), subs: make(map[string]*subscription), nextReqID: 1000,
		stats: make(map[string]*streamStats),
	}
}

func (f *IBKR) SetSymbol(symbol string) {
	symbol = tape.NormalizeSymbol(symbol)
	if symbol == "" {
		return
	}
	select {
	case f.commands <- symbol:
	default:
		// Retain the newest command when rapid ticker changes outpace the socket loop.
		select {
		case <-f.commands:
		default:
		}
		select {
		case f.commands <- symbol:
		default:
		}
	}
}

func (f *IBKR) Run(ctx context.Context) {
	reconnect, _ := time.ParseDuration(f.cfg.ReconnectInterval)
	connectTimeout, _ := time.ParseDuration(f.cfg.ConnectTimeout)
	ibapi.SetLogLevel(2) // warnings and errors only
	attempt := 0

	for ctx.Err() == nil {
		attempt++
		log.Printf("IBKR connection attempt=%d target=%s:%d client_id=%d", attempt, f.cfg.Host, f.cfg.Port, f.cfg.ClientID)
		f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "connecting", Message: fmt.Sprintf("%s:%d", f.cfg.Host, f.cfg.Port)})
		wrapper := newIBWrapper(f)
		client := ibapi.NewEClient(wrapper)
		handshakeStarted := time.Now()
		log.Printf("IBKR API handshake starting; if this line stalls, check API socket version, trusted IPs, and client ID conflicts")
		if err := client.Connect(f.cfg.Host, f.cfg.Port, f.cfg.ClientID); err != nil {
			log.Printf("IBKR API handshake failed after=%s error=%v; retrying_in=%s", time.Since(handshakeStarted).Round(time.Millisecond), err, reconnect)
			f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "waiting", Message: err.Error()})
			if !sleepContext(ctx, reconnect) {
				return
			}
			continue
		}
		log.Printf(
			"IBKR API handshake complete after=%s server_version=%d connection_time=%q",
			time.Since(handshakeStarted).Round(time.Millisecond), client.ServerVersion(), client.TWSConnectionTime(),
		)
		if !waitForIBKRReady(ctx, wrapper, connectTimeout) {
			_ = client.Disconnect()
			f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "waiting", Message: "IBKR API session did not become ready"})
			if !sleepContext(ctx, reconnect) {
				return
			}
			continue
		}
		f.setClient(client)
		f.resetSubscriptions()
		log.Printf("IBKR requesting market_data_type=%d", f.cfg.MarketDataType)
		client.ReqMarketDataType(f.cfg.MarketDataType)
		f.ensureSubscription(f.store.Active())
		f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "live", Connected: true})

		check := time.NewTicker(500 * time.Millisecond)
		diagnostics := time.NewTicker(5 * time.Second)
		connected := true
		for connected {
			select {
			case <-ctx.Done():
				check.Stop()
				diagnostics.Stop()
				log.Printf("IBKR shutdown requested; disconnecting")
				_ = client.Disconnect()
				f.setClient(nil)
				f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "stopped"})
				return
			case symbol := <-f.commands:
				log.Printf("IBKR ticker switch requested symbol=%s", symbol)
				f.ensureSubscription(symbol)
			case <-check.C:
				connected = client.IsConnected()
			case <-diagnostics.C:
				f.logDiagnostics(client)
			}
		}
		check.Stop()
		diagnostics.Stop()
		log.Printf("IBKR client reports disconnected; reconnecting_in=%s", reconnect)
		_ = client.Disconnect()
		f.setClient(nil)
		f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "reconnecting", Message: "IBKR connection closed"})
		if !sleepContext(ctx, reconnect) {
			return
		}
	}
}

func (f *IBKR) setClient(client *ibapi.EClient) {
	f.mu.Lock()
	f.client = client
	f.mu.Unlock()
}

func (f *IBKR) resetSubscriptions() {
	f.mu.Lock()
	f.reqSymbols = make(map[int64]string)
	f.subs = make(map[string]*subscription)
	f.mu.Unlock()
	f.statsMu.Lock()
	f.stats = make(map[string]*streamStats)
	f.statsMu.Unlock()
}

func (f *IBKR) ensureSubscription(symbol string) {
	symbol = tape.NormalizeSymbol(symbol)
	if symbol == "" {
		return
	}
	f.mu.Lock()
	client := f.client
	f.usage++
	if existing := f.subs[symbol]; existing != nil {
		existing.used = f.usage
		f.mu.Unlock()
		log.Printf("IBKR reusing cached subscription symbol=%s trade_req=%d quote_req=%d", symbol, existing.tradeID, existing.quoteID)
		return
	}
	if client == nil || !client.IsConnected() {
		f.mu.Unlock()
		log.Printf("IBKR cannot subscribe symbol=%s: client is not connected", symbol)
		return
	}
	f.nextReqID += 2
	sub := &subscription{symbol: symbol, tradeID: f.nextReqID - 1, quoteID: f.nextReqID, used: f.usage}
	f.subs[symbol] = sub
	f.reqSymbols[sub.tradeID] = symbol
	f.reqSymbols[sub.quoteID] = symbol

	var evicted *subscription
	if len(f.subs) > f.cfg.SubscriptionCache {
		items := make([]*subscription, 0, len(f.subs))
		for _, item := range f.subs {
			if item.symbol != symbol {
				items = append(items, item)
			}
		}
		sort.Slice(items, func(i, j int) bool { return items[i].used < items[j].used })
		if len(items) > 0 {
			evicted = items[0]
			delete(f.subs, evicted.symbol)
			delete(f.reqSymbols, evicted.tradeID)
			delete(f.reqSymbols, evicted.quoteID)
		}
	}
	f.mu.Unlock()

	if evicted != nil {
		log.Printf("IBKR evicting cached subscription symbol=%s trade_req=%d quote_req=%d", evicted.symbol, evicted.tradeID, evicted.quoteID)
		client.CancelTickByTickData(evicted.tradeID)
		client.CancelMktData(evicted.quoteID)
	}
	contract := &ibapi.Contract{
		Symbol: symbol, SecType: f.cfg.SecurityType, Exchange: f.cfg.Exchange,
		PrimaryExchange: f.cfg.PrimaryExchange, Currency: f.cfg.Currency,
	}
	log.Printf(
		"IBKR subscription request symbol=%s sec_type=%s exchange=%s primary_exchange=%q currency=%s quote_req=%d all_last_req=%d",
		symbol, contract.SecType, contract.Exchange, contract.PrimaryExchange, contract.Currency, sub.quoteID, sub.tradeID,
	)
	client.ReqMktData(sub.quoteID, contract, "", false, false, nil)
	client.ReqTickByTickData(sub.tradeID, contract, "AllLast", 0, false)
}

func (f *IBKR) symbolFor(reqID int64) string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.reqSymbols[reqID]
}

func (w *ibWrapper) TickByTickAllLast(reqID int64, tickType int64, unixTime int64, price float64, size ibapi.Decimal, tickAttribLast ibapi.TickAttribLast, exchange, specialConditions string) {
	symbol := w.feed.symbolFor(reqID)
	if symbol == "" {
		return
	}
	now := time.Now()
	first := w.feed.recordTrade(symbol, now)
	trade := w.feed.store.AddTrade(symbol, time.Unix(unixTime, 0), now, price, size.Float())
	if w.feed.recorder != nil {
		w.feed.recorder.RecordTrade(storage.TradeRecord{
			Symbol: symbol, EventUS: trade.ReceivedUS, ReceivedUS: trade.ReceivedUS,
			ExchangeTimeMS: trade.ExchangeTimeMS, Price: trade.Price, Size: trade.Size,
			Class: trade.Class, Side: trade.Side, Bid: trade.Bid, Ask: trade.Ask,
			Exchange: exchange, Conditions: specialConditions, Source: "live",
			Provider: "ibkr",
		})
	}
	if first {
		log.Printf("IBKR first trade symbol=%s req=%d price=%g size=%s exchange=%q tick_type=%d", symbol, reqID, price, size.String(), exchange, tickType)
	}
}

func (w *ibWrapper) TickPrice(reqID ibapi.TickerID, tickType ibapi.TickType, price float64, attrib ibapi.TickAttrib) {
	symbol := w.feed.symbolFor(reqID)
	if symbol == "" {
		return
	}
	now := time.Now()
	var quote tape.Quote
	record := true
	switch tickType {
	case ibapi.BID, ibapi.DELAYED_BID:
		quote = w.feed.store.UpdateQuote(symbol, price, 0, -1, -1)
	case ibapi.ASK, ibapi.DELAYED_ASK:
		quote = w.feed.store.UpdateQuote(symbol, 0, price, -1, -1)
	case ibapi.CLOSE, ibapi.DELAYED_CLOSE:
		w.feed.store.UpdatePreviousClose(symbol, price)
		record = false
	default:
		return
	}
	if record {
		w.feed.recordQuoteSnapshot(symbol, now, quote)
	}
	if w.feed.recordQuote(symbol, now) {
		log.Printf("IBKR first quote symbol=%s req=%d field=%s price=%g", symbol, reqID, ibapi.TickName(tickType), price)
	}
}

func (w *ibWrapper) TickSize(reqID ibapi.TickerID, tickType ibapi.TickType, size ibapi.Decimal) {
	symbol := w.feed.symbolFor(reqID)
	if symbol == "" {
		return
	}
	now := time.Now()
	var quote tape.Quote
	switch tickType {
	case ibapi.BID_SIZE, ibapi.DELAYED_BID_SIZE:
		quote = w.feed.store.UpdateQuote(symbol, 0, 0, size.Float(), -1)
	case ibapi.ASK_SIZE, ibapi.DELAYED_ASK_SIZE:
		quote = w.feed.store.UpdateQuote(symbol, 0, 0, -1, size.Float())
	default:
		return
	}
	w.feed.recordQuoteSnapshot(symbol, now, quote)
}

func (f *IBKR) recordQuoteSnapshot(symbol string, at time.Time, quote tape.Quote) {
	if f.recorder == nil {
		return
	}
	f.recorder.RecordQuote(storage.QuoteRecord{
		Symbol: symbol, EventUS: at.UnixMicro(), ReceivedUS: at.UnixMicro(),
		Bid: quote.Bid, Ask: quote.Ask, BidSize: quote.BidSize, AskSize: quote.AskSize, Source: "live",
		Provider: "ibkr",
	})
}

func (w *ibWrapper) Error(reqID ibapi.TickerID, errTime, errCode int64, errString, advancedOrderRejectJSON string) {
	symbol := w.feed.symbolFor(reqID)
	if isIBKRNotice(errCode) {
		log.Printf("IBKR notice req=%d symbol=%s code=%d message=%q", reqID, symbol, errCode, errString)
		return
	}
	log.Printf("IBKR error req=%d symbol=%s code=%d message=%q", reqID, symbol, errCode, errString)
	current := w.feed.store.Status()
	current.Message = fmt.Sprintf("IBKR %d: %s", errCode, errString)
	if errCode == 1100 || errCode == 1300 {
		current.State = "reconnecting"
		current.Connected = false
	} else if reqID >= 0 {
		current.State = "degraded"
	}
	w.feed.store.SetStatus(current)
}

func (w *ibWrapper) ConnectionClosed() {
	log.Printf("IBKR callback connection_closed")
	w.closeOnce.Do(func() { close(w.closed) })
	w.feed.store.SetStatus(tape.FeedStatus{Mode: "live", State: "reconnecting", Message: "IBKR connection closed"})
}

func (w *ibWrapper) ConnectAck() {
	log.Printf("IBKR callback connect_ack")
}

func (w *ibWrapper) NextValidID(orderID int64) {
	log.Printf("IBKR callback next_valid_id=%d; API session is ready", orderID)
	w.readyOnce.Do(func() { close(w.ready) })
}

func (w *ibWrapper) MarketDataType(reqID ibapi.TickerID, marketDataType int64) {
	log.Printf("IBKR callback market_data_type req=%d symbol=%s type=%d", reqID, w.feed.symbolFor(reqID), marketDataType)
}

func (f *IBKR) recordTrade(symbol string, at time.Time) bool {
	f.statsMu.Lock()
	defer f.statsMu.Unlock()
	stats := f.statsForLocked(symbol)
	stats.trades++
	stats.lastTradeAt = at
	return stats.trades == 1
}

func (f *IBKR) recordQuote(symbol string, at time.Time) bool {
	f.statsMu.Lock()
	defer f.statsMu.Unlock()
	stats := f.statsForLocked(symbol)
	stats.quotes++
	stats.lastQuoteAt = at
	return stats.quotes == 1
}

func (f *IBKR) statsForLocked(symbol string) *streamStats {
	stats := f.stats[symbol]
	if stats == nil {
		stats = &streamStats{}
		f.stats[symbol] = stats
	}
	return stats
}

func (f *IBKR) logDiagnostics(client *ibapi.EClient) {
	symbol := f.store.Active()
	snapshot := f.store.Snapshot(symbol, 1)
	f.statsMu.Lock()
	stats := *f.statsForLocked(symbol)
	f.statsMu.Unlock()
	log.Printf(
		"IBKR heartbeat connected=%v symbol=%s bid=%g ask=%g trades=%d quotes=%d last_trade=%s last_quote=%s recorder_dropped=%d state=%s message=%q",
		client.IsConnected(), symbol, snapshot.Quote.Bid, snapshot.Quote.Ask, stats.trades, stats.quotes,
		formatDiagnosticTime(stats.lastTradeAt), formatDiagnosticTime(stats.lastQuoteAt), f.recorderDropped(), snapshot.Status.State, snapshot.Status.Message,
	)
}

func (f *IBKR) recorderDropped() uint64 {
	if f.recorder == nil {
		return 0
	}
	return f.recorder.Dropped()
}

func formatDiagnosticTime(value time.Time) string {
	if value.IsZero() {
		return "never"
	}
	return value.Format("15:04:05.000")
}

func isIBKRNotice(code int64) bool {
	return code >= 2100 && code <= 2199
}

func waitForIBKRReady(ctx context.Context, wrapper *ibWrapper, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-wrapper.ready:
		return true
	case <-wrapper.closed:
		log.Printf("IBKR API session closed before next_valid_id")
		return false
	case <-timer.C:
		log.Printf("IBKR API session startup timed out after=%s waiting for next_valid_id", timeout)
		return false
	case <-ctx.Done():
		return false
	}
}

func sleepContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
