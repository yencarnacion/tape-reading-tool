package feed

import (
	"context"
	"fmt"
	"log"
	"net"
	"sort"
	"sync"
	"time"

	"github.com/scmhub/ibapi"
	"tape-reading-tool/internal/config"
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
}

type subscription struct {
	symbol  string
	tradeID int64
	quoteID int64
	used    uint64
}

type ibWrapper struct {
	ibapi.Wrapper
	feed *IBKR
}

func NewIBKR(cfg config.IBKRConfig, store *tape.Store) *IBKR {
	return &IBKR{
		cfg: cfg, store: store, commands: make(chan string, 32),
		reqSymbols: make(map[int64]string), subs: make(map[string]*subscription), nextReqID: 1000,
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

	for ctx.Err() == nil {
		f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "connecting", Message: fmt.Sprintf("%s:%d", f.cfg.Host, f.cfg.Port)})
		if err := probe(ctx, f.cfg.Host, f.cfg.Port, connectTimeout); err != nil {
			f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "waiting", Message: err.Error()})
			if !sleepContext(ctx, reconnect) {
				return
			}
			continue
		}

		wrapper := &ibWrapper{feed: f}
		client := ibapi.NewEClient(wrapper)
		if err := client.Connect(f.cfg.Host, f.cfg.Port, f.cfg.ClientID); err != nil {
			f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "waiting", Message: err.Error()})
			if !sleepContext(ctx, reconnect) {
				return
			}
			continue
		}
		f.setClient(client)
		f.resetSubscriptions()
		client.ReqMarketDataType(f.cfg.MarketDataType)
		f.ensureSubscription(f.store.Active())
		f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "live", Connected: true})

		check := time.NewTicker(500 * time.Millisecond)
		connected := true
		for connected {
			select {
			case <-ctx.Done():
				check.Stop()
				_ = client.Disconnect()
				f.setClient(nil)
				f.store.SetStatus(tape.FeedStatus{Mode: "live", State: "stopped"})
				return
			case symbol := <-f.commands:
				f.ensureSubscription(symbol)
			case <-check.C:
				connected = client.IsConnected()
			}
		}
		check.Stop()
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
		return
	}
	if client == nil || !client.IsConnected() {
		f.mu.Unlock()
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
		client.CancelTickByTickData(evicted.tradeID)
		client.CancelMktData(evicted.quoteID)
	}
	contract := &ibapi.Contract{
		Symbol: symbol, SecType: f.cfg.SecurityType, Exchange: f.cfg.Exchange,
		PrimaryExchange: f.cfg.PrimaryExchange, Currency: f.cfg.Currency,
	}
	client.ReqMktData(sub.quoteID, contract, "", false, false, nil)
	client.ReqTickByTickData(sub.tradeID, contract, "AllLast", 0, false)
	log.Printf("IBKR subscribed %s (trade=%d quote=%d)", symbol, sub.tradeID, sub.quoteID)
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
	w.feed.store.AddTrade(symbol, time.Unix(unixTime, 0), time.Now(), price, size.Float())
}

func (w *ibWrapper) TickPrice(reqID ibapi.TickerID, tickType ibapi.TickType, price float64, attrib ibapi.TickAttrib) {
	symbol := w.feed.symbolFor(reqID)
	if symbol == "" {
		return
	}
	switch tickType {
	case ibapi.BID, ibapi.DELAYED_BID:
		w.feed.store.UpdateQuote(symbol, price, 0, -1, -1)
	case ibapi.ASK, ibapi.DELAYED_ASK:
		w.feed.store.UpdateQuote(symbol, 0, price, -1, -1)
	}
}

func (w *ibWrapper) TickSize(reqID ibapi.TickerID, tickType ibapi.TickType, size ibapi.Decimal) {
	symbol := w.feed.symbolFor(reqID)
	if symbol == "" {
		return
	}
	switch tickType {
	case ibapi.BID_SIZE, ibapi.DELAYED_BID_SIZE:
		w.feed.store.UpdateQuote(symbol, 0, 0, size.Float(), -1)
	case ibapi.ASK_SIZE, ibapi.DELAYED_ASK_SIZE:
		w.feed.store.UpdateQuote(symbol, 0, 0, -1, size.Float())
	}
}

func (w *ibWrapper) Error(reqID ibapi.TickerID, errTime, errCode int64, errString, advancedOrderRejectJSON string) {
	if errCode == 2104 || errCode == 2106 || errCode == 2158 {
		return
	}
	log.Printf("IBKR error req=%d code=%d: %s", reqID, errCode, errString)
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
	w.feed.store.SetStatus(tape.FeedStatus{Mode: "live", State: "reconnecting", Message: "IBKR connection closed"})
}

func probe(ctx context.Context, host string, port int, timeout time.Duration) error {
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return fmt.Errorf("TWS/Gateway unavailable: %w", err)
	}
	return conn.Close()
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
