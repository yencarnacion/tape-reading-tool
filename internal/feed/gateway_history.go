package feed

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/marketgateway"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
	"time"
)

func DownloadGatewayHistorical(ctx context.Context, cfg config.MassiveConfig, db *storage.Database, o HistoricalOptions) error {
	symbol := tape.NormalizeSymbol(o.Symbol)
	if symbol == "" || !o.End.After(o.Start) {
		return fmt.Errorf("valid symbol, start and end required")
	}
	c, e := marketgateway.New(cfg.GatewayURL, cfg.GatewayToken)
	if e != nil {
		return e
	}
	defer c.Close()
	for _, kind := range []string{"trades", "quotes"} {
		if e = db.InvalidateCoverage(ctx, symbol, "massive", kind, o.Start.UnixMicro(), o.End.UnixMicro()); e != nil {
			return e
		}
	}
	if e = db.DeleteRange(ctx, symbol, "historical", "massive", o.Start.UnixMicro(), o.End.UnixMicro()); e != nil {
		return e
	}
	for _, kind := range []string{"trades", "quotes"} {
		path := fmt.Sprintf("/rest/v3/%s/%s?timestamp.gte=%d&timestamp.lte=%d&sort=timestamp&order=asc&limit=50000", kind, url.PathEscape(symbol), o.Start.UnixNano(), o.End.UnixNano())
		seen := map[string]bool{}
		total := int64(0)
		lastPrice := 0.0
		lastSide := int8(0)
		for page := 0; path != ""; page++ {
			if page >= 10000 || seen[path] {
				return fmt.Errorf("historical pagination limit")
			}
			seen[path] = true
			var v struct {
				Results []json.RawMessage `json:"results"`
				Next    string            `json:"next_url"`
			}
			if e = c.Get(ctx, path, &v); e != nil {
				return e
			}
			trades := []storage.TradeRecord{}
			quotes := []storage.QuoteRecord{}
			for _, raw := range v.Results {
				if kind == "trades" {
					var t massiveTrade
					if json.Unmarshal(raw, &t) != nil {
						return fmt.Errorf("invalid historical trade")
					}
					if t.SIPTimestamp < o.Start.UnixNano() || t.SIPTimestamp > o.End.UnixNano() || t.Price <= 0 || t.Size < 0 {
						continue
					}
					at := time.Unix(0, t.SIPTimestamp)
					if o.UseRTH && !isRegularSession(at) {
						continue
					}
					side := lastSide
					if lastPrice > 0 {
						if t.Price > lastPrice {
							side = 1
						} else if t.Price < lastPrice {
							side = -1
						}
					}
					lastPrice = t.Price
					if side != 0 {
						lastSide = side
					}
					trades = append(trades, storage.TradeRecord{Symbol: symbol, EventUS: t.SIPTimestamp / 1000, ExchangeTimeMS: t.ParticipantTimestamp / 1e6, Price: t.Price, Size: t.Size, Class: tape.Between, Side: side, Exchange: strconv.Itoa(t.Exchange), Conditions: formatConditionCodes(t.Conditions), Source: "historical", Provider: "massive"})
				} else {
					var q massiveQuote
					if json.Unmarshal(raw, &q) != nil {
						return fmt.Errorf("invalid historical quote")
					}
					if q.SIPTimestamp < o.Start.UnixNano() || q.SIPTimestamp > o.End.UnixNano() {
						continue
					}
					if o.UseRTH && !isRegularSession(time.Unix(0, q.SIPTimestamp)) {
						continue
					}
					quotes = append(quotes, storage.QuoteRecord{Symbol: symbol, EventUS: q.SIPTimestamp / 1000, Bid: q.BidPrice, Ask: q.AskPrice, BidSize: q.BidSize, AskSize: q.AskSize, Source: "historical", Provider: "massive"})
				}
			}
			if len(trades) > 0 {
				if e = db.InsertTrades(ctx, trades); e != nil {
					return e
				}
			}
			if len(quotes) > 0 {
				if e = db.InsertQuotes(ctx, quotes); e != nil {
					return e
				}
			}
			total += int64(len(trades) + len(quotes))
			path = v.Next
		}
		if e = markDownloadCoverage(ctx, db, symbol, "massive", kind, o, total); e != nil {
			return e
		}
	}
	return nil
}
