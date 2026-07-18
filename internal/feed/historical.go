package feed

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/scmhub/ibapi"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

type HistoricalOptions struct {
	Symbol          string
	Start           time.Time
	End             time.Time
	UseRTH          bool
	RequestInterval time.Duration
}

type historicalResponse struct {
	trades []ibapi.HistoricalTickLast
	quotes []ibapi.HistoricalTickBidAsk
	err    error
}

type historicalWrapper struct {
	ibapi.Wrapper
	ready     chan struct{}
	closed    chan struct{}
	readyOnce sync.Once
	closeOnce sync.Once

	mu     sync.Mutex
	reqID  int64
	kind   string
	trades []ibapi.HistoricalTickLast
	quotes []ibapi.HistoricalTickBidAsk
	result chan historicalResponse
}

func newHistoricalWrapper() *historicalWrapper {
	return &historicalWrapper{ready: make(chan struct{}), closed: make(chan struct{})}
}

func (w *historicalWrapper) NextValidID(int64) { w.readyOnce.Do(func() { close(w.ready) }) }
func (w *historicalWrapper) ConnectionClosed() { w.closeOnce.Do(func() { close(w.closed) }) }

func (w *historicalWrapper) begin(reqID int64, kind string) <-chan historicalResponse {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.reqID = reqID
	w.kind = kind
	w.trades = w.trades[:0]
	w.quotes = w.quotes[:0]
	w.result = make(chan historicalResponse, 1)
	return w.result
}

func (w *historicalWrapper) HistoricalTicksLast(reqID int64, ticks []ibapi.HistoricalTickLast, done bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if reqID != w.reqID || w.kind != "TRADES" || w.result == nil {
		return
	}
	w.trades = append(w.trades, ticks...)
	if done {
		w.result <- historicalResponse{trades: append([]ibapi.HistoricalTickLast(nil), w.trades...)}
		w.result = nil
	}
}

func (w *historicalWrapper) HistoricalTicksBidAsk(reqID int64, ticks []ibapi.HistoricalTickBidAsk, done bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if reqID != w.reqID || w.kind != "BID_ASK" || w.result == nil {
		return
	}
	w.quotes = append(w.quotes, ticks...)
	if done {
		w.result <- historicalResponse{quotes: append([]ibapi.HistoricalTickBidAsk(nil), w.quotes...)}
		w.result = nil
	}
}

func (w *historicalWrapper) Error(reqID ibapi.TickerID, _ int64, code int64, message, _ string) {
	if isIBKRNotice(code) {
		log.Printf("IBKR historical notice req=%d code=%d message=%q", reqID, code, message)
		return
	}
	log.Printf("IBKR historical error req=%d code=%d message=%q", reqID, code, message)
	w.mu.Lock()
	defer w.mu.Unlock()
	if int64(reqID) == w.reqID && w.result != nil {
		w.result <- historicalResponse{err: fmt.Errorf("IBKR %d: %s", code, message)}
		w.result = nil
	}
}

func DownloadHistorical(ctx context.Context, cfg config.IBKRConfig, database *storage.Database, options HistoricalOptions) error {
	if options.End.Before(options.Start) || options.End.Equal(options.Start) {
		return fmt.Errorf("historical end must be after start")
	}
	symbol := tape.NormalizeSymbol(options.Symbol)
	if symbol == "" {
		return fmt.Errorf("invalid historical symbol %q", options.Symbol)
	}
	if options.RequestInterval <= 0 {
		options.RequestInterval = 11 * time.Second
	}
	wrapper := newHistoricalWrapper()
	client := ibapi.NewEClient(wrapper)
	clientID := cfg.ClientID + 1
	log.Printf("IBKR historical connecting target=%s:%d client_id=%d", cfg.Host, cfg.Port, clientID)
	if err := client.Connect(cfg.Host, cfg.Port, clientID); err != nil {
		return err
	}
	defer client.Disconnect()
	connectTimeout, _ := time.ParseDuration(cfg.ConnectTimeout)
	select {
	case <-wrapper.ready:
	case <-wrapper.closed:
		return fmt.Errorf("IBKR historical connection closed during startup")
	case <-time.After(connectTimeout):
		return fmt.Errorf("IBKR historical startup timed out after %s", connectTimeout)
	case <-ctx.Done():
		return ctx.Err()
	}

	contract := &ibapi.Contract{
		Symbol: symbol, SecType: cfg.SecurityType, Exchange: cfg.Exchange,
		PrimaryExchange: cfg.PrimaryExchange, Currency: cfg.Currency,
	}
	startUS, endUS := options.Start.UnixMicro(), options.End.UnixMicro()
	if err := database.DeleteRange(ctx, symbol, "historical", "ibkr", startUS, endUS); err != nil {
		return fmt.Errorf("clear historical range: %w", err)
	}

	tradeCount, err := downloadHistoricalTrades(ctx, client, wrapper, database, contract, options)
	if err != nil {
		return err
	}
	quoteCount, err := downloadHistoricalQuotes(ctx, client, wrapper, database, contract, options)
	if err != nil {
		return err
	}
	log.Printf("IBKR historical complete symbol=%s trades=%d quotes=%d database=%s", symbol, tradeCount, quoteCount, database.Path())
	return nil
}

func downloadHistoricalTrades(ctx context.Context, client *ibapi.EClient, wrapper *historicalWrapper, database *storage.Database, contract *ibapi.Contract, options HistoricalOptions) (int, error) {
	cursor := options.Start.UTC()
	reqID := int64(700001)
	total := 0
	lastPrice := 0.0
	lastSide := int8(0)
	for !cursor.After(options.End) {
		result, err := requestHistoricalPage(ctx, client, wrapper, reqID, contract, cursor, "TRADES", options.UseRTH)
		if err != nil {
			return total, err
		}
		if len(result.trades) == 0 {
			break
		}
		records := make([]storage.TradeRecord, 0, len(result.trades))
		lastSecond := int64(0)
		for _, tick := range result.trades {
			if tick.Time > options.End.Unix() {
				continue
			}
			side := lastSide
			if lastPrice > 0 {
				if tick.Price > lastPrice {
					side = 1
				} else if tick.Price < lastPrice {
					side = -1
				}
			}
			lastPrice = tick.Price
			if side != 0 {
				lastSide = side
			}
			records = append(records, storage.TradeRecord{
				Symbol: options.Symbol, EventUS: tick.Time * 1e6, ExchangeTimeMS: tick.Time * 1000,
				Price: tick.Price, Size: tick.Size.Float(), Class: tape.Between, Side: side,
				Exchange: tick.Exchange, Conditions: tick.SpecialConditions, Source: "historical",
				Provider: "ibkr",
			})
			lastSecond = tick.Time
		}
		if len(records) > 0 {
			if err := database.InsertTrades(ctx, records); err != nil {
				return total, err
			}
			total += len(records)
		}
		log.Printf("IBKR historical trades symbol=%s cursor=%s page=%d total=%d", options.Symbol, cursor.Format(time.RFC3339), len(records), total)
		if len(result.trades) < 1000 || lastSecond == 0 || lastSecond >= options.End.Unix() {
			break
		}
		cursor = time.Unix(lastSecond+1, 0).UTC()
		reqID++
		if !sleepContext(ctx, options.RequestInterval) {
			return total, ctx.Err()
		}
	}
	return total, nil
}

func downloadHistoricalQuotes(ctx context.Context, client *ibapi.EClient, wrapper *historicalWrapper, database *storage.Database, contract *ibapi.Contract, options HistoricalOptions) (int, error) {
	cursor := options.Start.UTC()
	reqID := int64(800001)
	total := 0
	for !cursor.After(options.End) {
		result, err := requestHistoricalPage(ctx, client, wrapper, reqID, contract, cursor, "BID_ASK", options.UseRTH)
		if err != nil {
			return total, err
		}
		if len(result.quotes) == 0 {
			break
		}
		records := make([]storage.QuoteRecord, 0, len(result.quotes))
		lastSecond := int64(0)
		for _, tick := range result.quotes {
			if tick.Time > options.End.Unix() {
				continue
			}
			records = append(records, storage.QuoteRecord{
				Symbol: options.Symbol, EventUS: tick.Time * 1e6, Bid: tick.PriceBid, Ask: tick.PriceAsk,
				BidSize: tick.SizeBid.Float(), AskSize: tick.SizeAsk.Float(), Source: "historical",
				Provider: "ibkr",
			})
			lastSecond = tick.Time
		}
		if len(records) > 0 {
			if err := database.InsertQuotes(ctx, records); err != nil {
				return total, err
			}
			total += len(records)
		}
		log.Printf("IBKR historical quotes symbol=%s cursor=%s page=%d total=%d", options.Symbol, cursor.Format(time.RFC3339), len(records), total)
		if len(result.quotes) < 1000 || lastSecond == 0 || lastSecond >= options.End.Unix() {
			break
		}
		cursor = time.Unix(lastSecond+1, 0).UTC()
		reqID++
		if !sleepContext(ctx, options.RequestInterval*2) {
			return total, ctx.Err()
		}
	}
	return total, nil
}

func requestHistoricalPage(ctx context.Context, client *ibapi.EClient, wrapper *historicalWrapper, reqID int64, contract *ibapi.Contract, cursor time.Time, kind string, useRTH bool) (historicalResponse, error) {
	result := wrapper.begin(reqID, kind)
	client.ReqHistoricalTicks(reqID, contract, cursor.Format("20060102-15:04:05"), "", 1000, kind, useRTH, false, nil)
	timer := time.NewTimer(2 * time.Minute)
	defer timer.Stop()
	select {
	case response := <-result:
		return response, response.err
	case <-wrapper.closed:
		return historicalResponse{}, fmt.Errorf("IBKR historical connection closed")
	case <-timer.C:
		return historicalResponse{}, fmt.Errorf("IBKR historical request %d timed out", reqID)
	case <-ctx.Done():
		return historicalResponse{}, ctx.Err()
	}
}
