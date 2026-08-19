// Command replay-fixture writes a deterministic replay recording so the browser
// checks can drive a real historical replay. The panel guarantees that matter
// most - a running low the browser tape never saw, a later low that must stay
// invisible, and a session or symbol boundary the panel and the core have to
// agree across - are only observable against a real feed.Replay, and market data
// cannot be committed, so the recording is generated instead.
//
// Two symbols over two consecutive sessions. Each symbol's earlier session spans
// exactly its own ADR, so serving as a completed prior session for the later one
// leaves the baseline unchanged and every reading stays a round number.
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
	provider = "massive"
	source   = "historical"
)

// A symbol's recording. priorLow/priorHigh set the ADR baseline; earlyLow and
// earlyLast span exactly that same ratio so the earlier session is a neutral
// prior for the later one. lateLow/lateLast are the reading under test, and
// laterLow is the low the replay must not reveal before it reaches 09:45.
type instrument struct {
	symbol                       string
	priorLow, priorHigh          float64
	earlyLow, earlyLast          float64
	lateLow, lateLast, laterLow  float64
	baseline, early, late, after string
}

var instruments = []instrument{
	// 5% baseline; a 5% early session, a 2.5% late session, and a low that would
	// read 1.15 ADR if it leaked.
	{symbol: "AAPL", priorLow: 50, priorHigh: 52.5,
		earlyLow: 49, earlyLast: 51.45, lateLow: 98, lateLast: 100.45, laterLow: 95,
		baseline: "5.00%", early: "1.00 ADR", late: "0.50 ADR", after: "1.15 ADR"},
	// 10% baseline, so a symbol confused for the other changes the headline number
	// and the baseline together.
	{symbol: "NVDA", priorLow: 200, priorHigh: 220,
		earlyLow: 200, earlyLast: 220, lateLow: 400, lateLast: 420, laterLow: 380,
		baseline: "10.00%", early: "1.00 ADR", late: "0.50 ADR", after: "1.10 ADR"},
}

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
	early := time.Date(2026, 7, 21, 0, 0, 0, 0, location)
	late := time.Date(2026, 7, 22, 0, 0, 0, 0, location)
	at := func(day time.Time, hour, minute, second int) int64 {
		return time.Date(day.Year(), day.Month(), day.Day(), hour, minute, second, 0, location).UnixMicro()
	}

	for _, target := range instruments {
		// Twenty completed sessions before the earlier replay session, as provider
		// minute bars with a completed download, which is the shape local replay
		// history really has. The later session sees these plus the earlier one.
		sessions := 0
		for day := early.AddDate(0, 0, -1); sessions < 20; day = day.AddDate(0, 0, -1) {
			if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
				continue
			}
			bars := []storage.MinuteBar{
				{TimeUS: at(day, 9, 30, 0), Open: target.priorLow, High: target.priorLow, Low: target.priorLow, Close: target.priorLow, Volume: 1000},
				{TimeUS: at(day, 12, 0, 0), Open: target.priorLow, High: target.priorHigh, Low: target.priorLow, Close: target.priorHigh, Volume: 1000},
				{TimeUS: at(day, 15, 0, 0), Open: target.priorHigh, High: target.priorHigh, Low: target.priorLow, Close: target.priorHigh, Volume: 1000},
			}
			if err := database.UpsertMinuteBars(ctx, target.symbol, provider, bars); err != nil {
				return err
			}
			if err := database.MarkCoverage(ctx, storage.Coverage{
				Symbol: target.symbol, Provider: provider, Kind: "minute_bars",
				StartUS: at(day, 9, 30, 0), EndUS: at(day, 16, 0, 0), RowCount: int64(len(bars)),
			}); err != nil {
				return err
			}
			sessions++
		}

		// Filler every ten seconds holds the last price constant, so a reading is
		// the same at every position between the running low and the later one and
		// the check never has to land the replay on an exact instant.
		for _, session := range []struct {
			day               time.Time
			low, last, deeper float64
		}{
			{early, target.earlyLow, target.earlyLast, 0},
			{late, target.lateLow, target.lateLast, target.laterLow},
		} {
			trades := make([]storage.TradeRecord, 0, 128)
			for tick := at(session.day, 9, 30, 0); tick <= at(session.day, 9, 50, 0); tick += int64(10 * time.Second / time.Microsecond) {
				price, side := session.last, int8(1)
				switch tick {
				case at(session.day, 9, 32, 0):
					price, side = session.low, -1
				case at(session.day, 9, 45, 0):
					if session.deeper > 0 {
						price, side = session.deeper, -1
					}
				}
				trades = append(trades, storage.TradeRecord{
					Symbol: target.symbol, EventUS: tick, MarketTimeUS: tick, ExchangeTimeMS: tick / 1000,
					SequenceID: uint64(len(trades) + 1), Price: price, Size: 100, Side: side,
					ChartEligible: true, Source: source, Provider: provider,
				})
			}
			if err := database.InsertTrades(ctx, trades); err != nil {
				return err
			}
			if err := database.MarkCoverage(ctx, storage.Coverage{
				Symbol: target.symbol, Provider: provider, Kind: "trades",
				StartUS: at(session.day, 9, 30, 0), EndUS: at(session.day, 16, 0, 0), RowCount: int64(len(trades)),
			}); err != nil {
				return err
			}
		}
	}
	if err := database.Close(); err != nil {
		return err
	}

	// The check reads these back rather than recomputing them, so the fixture
	// stays the single source of truth for what the panel must display.
	readings := map[string]any{}
	for _, target := range instruments {
		readings[target.symbol] = map[string]any{
			"baseline": target.baseline, "history": "20 / 20",
			"early": reading(target.early, target.earlyLow, target.earlyLast),
			"late":  reading(target.late, target.lateLow, target.lateLast),
			"after": reading(target.after, target.laterLow, target.lateLast),
		}
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"source": source, "provider": provider,
		"earlySessionDateET": early.Format("2006-01-02"),
		"lateSessionDateET":  late.Format("2006-01-02"),
		"startUS":            at(early, 9, 30, 0),
		"endUS":              at(late, 9, 50, 0),
		"earlySteadyUS":      at(early, 9, 38, 0),
		"lateSteadyUS":       at(late, 9, 38, 0),
		"lateBeforeLowUS":    at(late, 9, 31, 0),
		"lateAfterLowUS":     at(late, 9, 47, 0),
		"beforeLow": map[string]string{
			// Before 09:32 the filler is both the low and the last.
			"value": "0.00 ADR", "percent": "+0.00% FROM RTH LOW",
		},
		"readings": readings,
	})
}

func reading(value string, low, last float64) map[string]string {
	return map[string]string{
		"value":   value,
		"percent": fmt.Sprintf("+%.2f%% FROM RTH LOW", (last/low-1)*100),
		"low":     fmt.Sprintf("%.2f", low),
		"last":    fmt.Sprintf("%.2f", last),
	}
}
