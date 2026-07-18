package feed

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/massive-com/client-go/v3/rest"
	"github.com/massive-com/client-go/v3/rest/gen"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

type massiveTrade struct {
	Conditions           []int32 `json:"conditions"`
	Exchange             int     `json:"exchange"`
	ParticipantTimestamp int64   `json:"participant_timestamp"`
	Price                float64 `json:"price"`
	SequenceNumber       int64   `json:"sequence_number"`
	SIPTimestamp         int64   `json:"sip_timestamp"`
	Size                 float64 `json:"size"`
}

type massiveQuote struct {
	AskPrice             float64 `json:"ask_price"`
	AskSize              float64 `json:"ask_size"`
	BidPrice             float64 `json:"bid_price"`
	BidSize              float64 `json:"bid_size"`
	ParticipantTimestamp int64   `json:"participant_timestamp"`
	SequenceNumber       int64   `json:"sequence_number"`
	SIPTimestamp         int64   `json:"sip_timestamp"`
}

func DownloadMassiveHistorical(ctx context.Context, cfg config.MassiveConfig, database *storage.Database, options HistoricalOptions) error {
	if cfg.APIKey == "" {
		return fmt.Errorf("MASSIVE_API_KEY is required in .env")
	}
	symbol := tape.NormalizeSymbol(options.Symbol)
	if symbol == "" || !options.End.After(options.Start) {
		return fmt.Errorf("valid symbol, start, and end are required")
	}
	startUS, endUS := options.Start.UnixMicro(), options.End.UnixMicro()
	if err := database.DeleteRange(ctx, symbol, "historical", "massive", startUS, endUS); err != nil {
		return err
	}
	client := rest.NewWithOptions(cfg.APIKey, rest.WithTrace(false), rest.WithPagination(true))
	trades, err := downloadMassiveTrades(ctx, client, database, symbol, options)
	if err != nil {
		return err
	}
	quotes, err := downloadMassiveQuotes(ctx, client, database, symbol, options)
	if err != nil {
		return err
	}
	log.Printf("Massive historical complete symbol=%s trades=%d quotes=%d database=%s", symbol, trades, quotes, database.Path())
	return nil
}

func downloadMassiveTrades(ctx context.Context, client *rest.Client, database *storage.Database, symbol string, options HistoricalOptions) (int, error) {
	start := strconv.FormatInt(options.Start.UnixNano(), 10)
	end := strconv.FormatInt(options.End.UnixNano(), 10)
	order := gen.GetStocksTradesParamsOrderAsc
	sortField := gen.GetStocksTradesParamsSortTimestamp
	limit := 50000
	response, err := client.GetStocksTradesWithResponse(ctx, symbol, &gen.GetStocksTradesParams{
		TimestampGte: &start, TimestampLte: &end, Order: &order, Sort: &sortField, Limit: &limit,
	})
	if err != nil {
		return 0, err
	}
	if err := rest.CheckResponse(response); err != nil {
		return 0, err
	}
	iterator := rest.NewIteratorFromResponse(client, response)
	records := make([]storage.TradeRecord, 0, 4096)
	total := 0
	lastPrice := 0.0
	lastSide := int8(0)
	for iterator.Next() {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		var trade massiveTrade
		if err := decodeMassiveItem(iterator.Item(), &trade); err != nil {
			return total, err
		}
		at := time.Unix(0, trade.SIPTimestamp)
		if options.UseRTH && !isRegularSession(at) {
			continue
		}
		side := lastSide
		if lastPrice > 0 {
			if trade.Price > lastPrice {
				side = 1
			} else if trade.Price < lastPrice {
				side = -1
			}
		}
		lastPrice = trade.Price
		if side != 0 {
			lastSide = side
		}
		records = append(records, storage.TradeRecord{
			Symbol: symbol, EventUS: trade.SIPTimestamp / 1000,
			ExchangeTimeMS: trade.ParticipantTimestamp / 1e6,
			Price:          trade.Price, Size: trade.Size, Class: tape.Between, Side: side,
			Exchange: strconv.Itoa(trade.Exchange), Conditions: formatConditionCodes(trade.Conditions),
			Source: "historical", Provider: "massive",
		})
		if len(records) >= 4096 {
			if err := database.InsertTrades(ctx, records); err != nil {
				return total, err
			}
			total += len(records)
			records = records[:0]
			if total%50000 < 4096 {
				log.Printf("Massive historical trades symbol=%s total=%d", symbol, total)
			}
		}
	}
	if err := iterator.Err(); err != nil {
		return total, err
	}
	if len(records) > 0 {
		if err := database.InsertTrades(ctx, records); err != nil {
			return total, err
		}
		total += len(records)
	}
	return total, nil
}

func downloadMassiveQuotes(ctx context.Context, client *rest.Client, database *storage.Database, symbol string, options HistoricalOptions) (int, error) {
	start := strconv.FormatInt(options.Start.UnixNano(), 10)
	end := strconv.FormatInt(options.End.UnixNano(), 10)
	order := gen.GetStocksQuotesParamsOrderAsc
	sortField := gen.GetStocksQuotesParamsSortTimestamp
	limit := 50000
	response, err := client.GetStocksQuotesWithResponse(ctx, symbol, &gen.GetStocksQuotesParams{
		TimestampGte: &start, TimestampLte: &end, Order: &order, Sort: &sortField, Limit: &limit,
	})
	if err != nil {
		return 0, err
	}
	if err := rest.CheckResponse(response); err != nil {
		return 0, err
	}
	iterator := rest.NewIteratorFromResponse(client, response)
	records := make([]storage.QuoteRecord, 0, 4096)
	total := 0
	for iterator.Next() {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		var quote massiveQuote
		if err := decodeMassiveItem(iterator.Item(), &quote); err != nil {
			return total, err
		}
		at := time.Unix(0, quote.SIPTimestamp)
		if options.UseRTH && !isRegularSession(at) {
			continue
		}
		records = append(records, storage.QuoteRecord{
			Symbol: symbol, EventUS: quote.SIPTimestamp / 1000,
			Bid: quote.BidPrice, Ask: quote.AskPrice, BidSize: quote.BidSize, AskSize: quote.AskSize,
			Source: "historical", Provider: "massive",
		})
		if len(records) >= 4096 {
			if err := database.InsertQuotes(ctx, records); err != nil {
				return total, err
			}
			total += len(records)
			records = records[:0]
			if total%50000 < 4096 {
				log.Printf("Massive historical quotes symbol=%s total=%d", symbol, total)
			}
		}
	}
	if err := iterator.Err(); err != nil {
		return total, err
	}
	if len(records) > 0 {
		if err := database.InsertQuotes(ctx, records); err != nil {
			return total, err
		}
		total += len(records)
	}
	return total, nil
}

func decodeMassiveItem(item map[string]any, target any) error {
	encoded, err := json.Marshal(item)
	if err != nil {
		return err
	}
	return json.Unmarshal(encoded, target)
}

func formatConditionCodes(values []int32) string {
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = strconv.FormatInt(int64(value), 10)
	}
	return strings.Join(parts, ",")
}

func isRegularSession(value time.Time) bool {
	location, _ := time.LoadLocation("America/New_York")
	local := value.In(location)
	if local.Weekday() == time.Saturday || local.Weekday() == time.Sunday {
		return false
	}
	minutes := local.Hour()*60 + local.Minute()
	return minutes >= 9*60+30 && minutes < 16*60
}
