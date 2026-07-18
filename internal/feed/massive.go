package feed

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	massivews "github.com/massive-com/client-go/v3/websocket"
	"github.com/massive-com/client-go/v3/websocket/models"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

type Massive struct {
	cfg      config.MassiveConfig
	store    *tape.Store
	recorder *storage.Database
	commands chan string

	mu     sync.RWMutex
	symbol string
}

func NewMassive(cfg config.MassiveConfig, store *tape.Store, recorder *storage.Database) *Massive {
	return &Massive{cfg: cfg, store: store, recorder: recorder, commands: make(chan string, 32), symbol: store.Active()}
}

func (f *Massive) SetSymbol(symbol string) {
	symbol = tape.NormalizeSymbol(symbol)
	if symbol == "" {
		return
	}
	select {
	case f.commands <- symbol:
	default:
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

func (f *Massive) Run(ctx context.Context) {
	if f.cfg.APIKey == "" {
		f.store.SetStatus(tape.FeedStatus{Mode: "massive", State: "error", Message: "MASSIVE_API_KEY is required in .env"})
		return
	}
	feedType := massivews.RealTime
	if f.cfg.Feed == "delayed" {
		feedType = massivews.Delayed
	}
	client, err := massivews.New(massivews.Config{
		APIKey: f.cfg.APIKey, Feed: feedType, Market: massivews.Stocks,
		ReconnectCallback: func(err error) {
			if err != nil {
				f.store.SetStatus(tape.FeedStatus{Mode: "massive", State: "reconnecting", Message: err.Error()})
				return
			}
			f.store.SetStatus(tape.FeedStatus{Mode: "massive", State: "live", Connected: true})
		},
	})
	if err != nil {
		f.store.SetStatus(tape.FeedStatus{Mode: "massive", State: "error", Message: err.Error()})
		return
	}
	defer client.Close()
	symbol := f.currentSymbol()
	if err := client.Subscribe(massivews.StocksTrades, symbol); err != nil {
		f.fail(err)
		return
	}
	if err := client.Subscribe(massivews.StocksQuotes, symbol); err != nil {
		f.fail(err)
		return
	}
	f.store.SetStatus(tape.FeedStatus{Mode: "massive", State: "connecting", Message: f.cfg.Feed})
	if err := client.Connect(); err != nil {
		f.fail(err)
		return
	}
	f.store.SetStatus(tape.FeedStatus{Mode: "massive", State: "live", Connected: true, Message: f.cfg.Feed})
	log.Printf("Massive WebSocket connected feed=%s symbol=%s", f.cfg.Feed, symbol)

	for {
		select {
		case <-ctx.Done():
			f.store.SetStatus(tape.FeedStatus{Mode: "massive", State: "stopped"})
			return
		case err := <-client.Error():
			if err != nil {
				f.fail(err)
			}
		case next := <-f.commands:
			old := f.currentSymbol()
			if next == old {
				continue
			}
			if err := client.Subscribe(massivews.StocksTrades, next); err != nil {
				f.fail(err)
				continue
			}
			if err := client.Subscribe(massivews.StocksQuotes, next); err != nil {
				f.fail(err)
				continue
			}
			_ = client.Unsubscribe(massivews.StocksTrades, old)
			_ = client.Unsubscribe(massivews.StocksQuotes, old)
			f.mu.Lock()
			f.symbol = next
			f.mu.Unlock()
			log.Printf("Massive ticker switch symbol=%s", next)
		case output, ok := <-client.Output():
			if !ok {
				f.fail(fmt.Errorf("Massive output closed"))
				return
			}
			f.handleOutput(output)
		}
	}
}

func (f *Massive) handleOutput(output any) {
	now := time.Now()
	switch value := output.(type) {
	case models.EquityTrade:
		f.handleTrade(value, now)
	case *models.EquityTrade:
		if value != nil {
			f.handleTrade(*value, now)
		}
	case models.EquityQuote:
		f.handleQuote(value, now)
	case *models.EquityQuote:
		if value != nil {
			f.handleQuote(*value, now)
		}
	}
}

func (f *Massive) handleTrade(value models.EquityTrade, received time.Time) {
	if value.Symbol != f.currentSymbol() || value.Price <= 0 || value.Size < 0 {
		return
	}
	exchangeTime := time.UnixMilli(value.Timestamp)
	trade := f.store.AddTrade(value.Symbol, exchangeTime, received, value.Price, float64(value.Size))
	if f.recorder != nil {
		f.recorder.RecordTrade(storage.TradeRecord{
			Symbol: value.Symbol, EventUS: trade.ReceivedUS, ReceivedUS: trade.ReceivedUS,
			ExchangeTimeMS: trade.ExchangeTimeMS, Price: trade.Price, Size: trade.Size,
			Class: trade.Class, Side: trade.Side, Bid: trade.Bid, Ask: trade.Ask,
			Exchange: strconv.FormatInt(int64(value.Exchange), 10), Conditions: formatConditionCodes(value.Conditions),
			Source: "live", Provider: "massive",
		})
	}
}

func (f *Massive) handleQuote(value models.EquityQuote, received time.Time) {
	if value.Symbol != f.currentSymbol() {
		return
	}
	quote := f.store.UpdateQuote(value.Symbol, value.BidPrice, value.AskPrice, float64(value.BidSize), float64(value.AskSize))
	if f.recorder != nil {
		f.recorder.RecordQuote(storage.QuoteRecord{
			Symbol: value.Symbol, EventUS: received.UnixMicro(), ReceivedUS: received.UnixMicro(),
			Bid: quote.Bid, Ask: quote.Ask, BidSize: quote.BidSize, AskSize: quote.AskSize,
			Source: "live", Provider: "massive",
		})
	}
}

func (f *Massive) currentSymbol() string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.symbol
}

func (f *Massive) fail(err error) {
	log.Printf("Massive error: %v", err)
	f.store.SetStatus(tape.FeedStatus{Mode: "massive", State: "error", Message: err.Error()})
}
