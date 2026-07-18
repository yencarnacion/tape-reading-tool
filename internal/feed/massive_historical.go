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

const massiveHistoricalMaxRetries = 8

type massiveResumePoint struct {
	timestamp int64
	seen      map[string]struct{}
}

func newMassiveResumePoint(timestamp int64) *massiveResumePoint {
	return &massiveResumePoint{timestamp: timestamp, seen: make(map[string]struct{})}
}

// accept makes an inclusive timestamp resume safe. Massive can place more
// than one record at the same SIP nanosecond, so retries request timestamp.gte
// and suppress only records already processed at the resume timestamp.
func (r *massiveResumePoint) accept(timestamp int64, key string) bool {
	if timestamp < r.timestamp {
		return false
	}
	if timestamp > r.timestamp {
		r.timestamp = timestamp
		clear(r.seen)
	}
	if _, exists := r.seen[key]; exists {
		return false
	}
	r.seen[key] = struct{}{}
	return true
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
	records := make([]storage.TradeRecord, 0, 4096)
	total := 0
	lastPrice := 0.0
	lastSide := int8(0)
	resume := newMassiveResumePoint(options.Start.UnixNano())
	consecutiveFailures := 0
	for {
		iterator, err := massiveTradesIterator(ctx, client, symbol, resume.timestamp, options.End.UnixNano())
		if err == nil {
			for iterator.Next() {
				if err := ctx.Err(); err != nil {
					return total, err
				}
				var trade massiveTrade
				if err := decodeMassiveItem(iterator.Item(), &trade); err != nil {
					return total, err
				}
				key := fmt.Sprintf("%d/%d/%d/%g/%g", trade.SequenceNumber, trade.ParticipantTimestamp, trade.Exchange, trade.Price, trade.Size)
				if !resume.accept(trade.SIPTimestamp, key) {
					continue
				}
				consecutiveFailures = 0
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
			err = iterator.Err()
		}
		if err == nil {
			break
		}
		consecutiveFailures++
		if consecutiveFailures > massiveHistoricalMaxRetries {
			return total, fmt.Errorf("Massive historical trades failed after %d retries at %d: %w", massiveHistoricalMaxRetries, resume.timestamp, err)
		}
		delay := massiveHistoricalRetryDelay(consecutiveFailures)
		log.Printf("Massive historical trades retry symbol=%s attempt=%d/%d resume_ns=%d wait=%s error=%v", symbol, consecutiveFailures, massiveHistoricalMaxRetries, resume.timestamp, delay, err)
		if !sleepContext(ctx, delay) {
			return total, ctx.Err()
		}
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
	records := make([]storage.QuoteRecord, 0, 4096)
	total := 0
	resume := newMassiveResumePoint(options.Start.UnixNano())
	consecutiveFailures := 0
	for {
		iterator, err := massiveQuotesIterator(ctx, client, symbol, resume.timestamp, options.End.UnixNano())
		if err == nil {
			for iterator.Next() {
				if err := ctx.Err(); err != nil {
					return total, err
				}
				var quote massiveQuote
				if err := decodeMassiveItem(iterator.Item(), &quote); err != nil {
					return total, err
				}
				key := fmt.Sprintf("%d/%d/%g/%g/%g/%g", quote.SequenceNumber, quote.ParticipantTimestamp, quote.BidPrice, quote.AskPrice, quote.BidSize, quote.AskSize)
				if !resume.accept(quote.SIPTimestamp, key) {
					continue
				}
				consecutiveFailures = 0
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
			err = iterator.Err()
		}
		if err == nil {
			break
		}
		consecutiveFailures++
		if consecutiveFailures > massiveHistoricalMaxRetries {
			return total, fmt.Errorf("Massive historical quotes failed after %d retries at %d: %w", massiveHistoricalMaxRetries, resume.timestamp, err)
		}
		delay := massiveHistoricalRetryDelay(consecutiveFailures)
		log.Printf("Massive historical quotes retry symbol=%s attempt=%d/%d resume_ns=%d wait=%s error=%v", symbol, consecutiveFailures, massiveHistoricalMaxRetries, resume.timestamp, delay, err)
		if !sleepContext(ctx, delay) {
			return total, ctx.Err()
		}
	}
	if len(records) > 0 {
		if err := database.InsertQuotes(ctx, records); err != nil {
			return total, err
		}
		total += len(records)
	}
	return total, nil
}

func massiveTradesIterator(ctx context.Context, client *rest.Client, symbol string, startNS, endNS int64) (*rest.Iterator, error) {
	start := strconv.FormatInt(startNS, 10)
	end := strconv.FormatInt(endNS, 10)
	order := gen.GetStocksTradesParamsOrderAsc
	sortField := gen.GetStocksTradesParamsSortTimestamp
	limit := 50000
	response, err := client.GetStocksTradesWithResponse(ctx, symbol, &gen.GetStocksTradesParams{
		TimestampGte: &start, TimestampLte: &end, Order: &order, Sort: &sortField, Limit: &limit,
	})
	if err != nil {
		return nil, err
	}
	if err := rest.CheckResponse(response); err != nil {
		return nil, err
	}
	return rest.NewIteratorFromResponse(client, response), nil
}

func massiveQuotesIterator(ctx context.Context, client *rest.Client, symbol string, startNS, endNS int64) (*rest.Iterator, error) {
	start := strconv.FormatInt(startNS, 10)
	end := strconv.FormatInt(endNS, 10)
	order := gen.GetStocksQuotesParamsOrderAsc
	sortField := gen.GetStocksQuotesParamsSortTimestamp
	limit := 50000
	response, err := client.GetStocksQuotesWithResponse(ctx, symbol, &gen.GetStocksQuotesParams{
		TimestampGte: &start, TimestampLte: &end, Order: &order, Sort: &sortField, Limit: &limit,
	})
	if err != nil {
		return nil, err
	}
	if err := rest.CheckResponse(response); err != nil {
		return nil, err
	}
	return rest.NewIteratorFromResponse(client, response), nil
}

func massiveHistoricalRetryDelay(attempt int) time.Duration {
	delay := time.Second << min(max(attempt-1, 0), 5)
	return min(delay, 30*time.Second)
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
