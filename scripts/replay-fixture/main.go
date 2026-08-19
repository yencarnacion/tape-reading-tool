// Command replay-fixture writes a deterministic replay recording so the browser
// checks can drive a real historical replay. The panel guarantees that matter
// most - a running low the browser tape never saw, and a later low that must
// stay invisible - are only observable against a real feed.Replay, and until now
// no check had a recording to point one at. Market data cannot be committed, so
// the recording is generated instead.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
)

const (
	symbol   = "AAPL"
	provider = "massive"
	source   = "historical"

	// Every prior session spans exactly 5% high to low, so ADR20 is 5.00% and the
	// panel's arithmetic is checkable by eye as well as by assertion.
	priorLow  = 50.0
	priorHigh = 52.5

	// Filler holds the last price steady, so the reading is the same at every
	// position between the running low and the later low. The check never has to
	// land the replay on an exact instant.
	fillerPrice = 102.90
	sessionLow  = 98.00
	laterLow    = 95.00
)

func main() {
	databasePath := flag.String("db", "", "path to write the fixture recording to")
	flag.Parse()
	if *databasePath == "" {
		log.Fatal("-db is required")
	}
	if err := write(*databasePath); err != nil {
		log.Fatal(err)
	}
}

func write(databasePath string) error {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		return err
	}
	storageConfig := config.Defaults().Storage
	storageConfig.Path = databasePath
	database, err := storage.Open(storageConfig)
	if err != nil {
		return err
	}
	ctx := context.Background()
	session := time.Date(2026, 7, 22, 0, 0, 0, 0, location)
	at := func(day time.Time, hour, minute, second int) int64 {
		return time.Date(day.Year(), day.Month(), day.Day(), hour, minute, second, 0, location).UnixMicro()
	}

	// Twenty completed prior sessions, as provider minute bars with a completed
	// download, which is the shape local replay history really has.
	sessions := 0
	for day := session.AddDate(0, 0, -1); sessions < 20; day = day.AddDate(0, 0, -1) {
		if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
			continue
		}
		bars := []storage.MinuteBar{
			{TimeUS: at(day, 9, 30, 0), Open: priorLow, High: priorLow, Low: priorLow, Close: priorLow, Volume: 1000},
			{TimeUS: at(day, 12, 0, 0), Open: priorLow, High: priorHigh, Low: priorLow, Close: priorHigh, Volume: 1000},
			{TimeUS: at(day, 15, 0, 0), Open: priorHigh, High: priorHigh, Low: priorLow, Close: priorHigh, Volume: 1000},
		}
		if err := database.UpsertMinuteBars(ctx, symbol, provider, bars); err != nil {
			return err
		}
		if err := database.MarkCoverage(ctx, storage.Coverage{
			Symbol: symbol, Provider: provider, Kind: "minute_bars",
			StartUS: at(day, 9, 30, 0), EndUS: at(day, 16, 0, 0), RowCount: int64(len(bars)),
		}); err != nil {
			return err
		}
		sessions++
	}

	// The replay session. Filler every ten seconds keeps the last price constant;
	// the two lows are the only prices that move it.
	trades := make([]storage.TradeRecord, 0, 128)
	add := func(timeUS int64, price float64, side int8) {
		trades = append(trades, storage.TradeRecord{
			Symbol: symbol, EventUS: timeUS, MarketTimeUS: timeUS, ExchangeTimeMS: timeUS / 1000,
			SequenceID: uint64(len(trades) + 1), Price: price, Size: 100, Side: side,
			ChartEligible: true, Source: source, Provider: provider,
		})
	}
	startUS, endUS := at(session, 9, 30, 0), at(session, 9, 50, 0)
	for tick := startUS; tick <= endUS; tick += int64(10 * time.Second / time.Microsecond) {
		switch tick {
		case at(session, 9, 32, 0):
			add(tick, sessionLow, -1)
		case at(session, 9, 45, 0):
			add(tick, laterLow, -1)
		default:
			add(tick, fillerPrice, 1)
		}
	}
	if err := database.InsertTrades(ctx, trades); err != nil {
		return err
	}
	if err := database.MarkCoverage(ctx, storage.Coverage{
		Symbol: symbol, Provider: provider, Kind: "trades",
		StartUS: at(session, 9, 30, 0), EndUS: at(session, 16, 0, 0), RowCount: int64(len(trades)),
	}); err != nil {
		return err
	}
	if err := database.Close(); err != nil {
		return err
	}

	// The check reads these back rather than recomputing them, so the fixture
	// stays the single source of truth for what the panel must display.
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"symbol": symbol, "source": source, "provider": provider,
		"sessionDateET": session.Format("2006-01-02"),
		"startUS":       startUS, "endUS": endUS,
		"beforeLowUS": at(session, 9, 31, 0),
		"steadyUS":    at(session, 9, 38, 0),
		"afterLowUS":  at(session, 9, 47, 0),
		"baseline":    fmt.Sprintf("%.2f%%", (priorHigh/priorLow-1)*100),
		"history":     "20 / 20",
		"steady": map[string]string{
			"value": "1.00 ADR", "percent": "+5.00% FROM RTH LOW",
			"low": "98.00", "last": "102.90",
		},
		"beforeLow": map[string]string{
			"value": "0.00 ADR", "percent": "+0.00% FROM RTH LOW",
			"low": "102.90", "last": "102.90",
		},
	})
}
