package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/tape"
)

func testDatabase(t *testing.T) *Database {
	t.Helper()
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "tape.db")
	cfg.QueueSize = 1024
	cfg.BatchSize = 16
	cfg.FlushInterval = "5ms"
	database, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})
	return database
}

func TestDatabaseSeparatesProvidersAndOrdersQuotesBeforeTrades(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	base := time.Date(2026, 7, 17, 13, 30, 0, 0, time.UTC).UnixMicro()
	if err := database.InsertTrades(ctx, []TradeRecord{
		{Symbol: "IONQ", EventUS: base, Price: 34.5, Size: 100, Class: tape.AtAsk, Side: 1, Source: "historical", Provider: "massive"},
		{Symbol: "IONQ", EventUS: base, Price: 34.4, Size: 50, Class: tape.AtBid, Side: -1, Source: "historical", Provider: "ibkr"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.InsertQuotes(ctx, []QuoteRecord{
		{Symbol: "IONQ", EventUS: base, Bid: 34.4, Ask: 34.5, Source: "historical", Provider: "massive"},
	}); err != nil {
		t.Fatal(err)
	}

	dataRange, err := database.DataRange(ctx, "IONQ", "historical", "massive")
	if err != nil {
		t.Fatal(err)
	}
	if dataRange.Trades != 1 || dataRange.Quotes != 1 || dataRange.Provider != "massive" {
		t.Fatalf("unexpected range: %+v", dataRange)
	}
	rows, err := database.Events(ctx, "IONQ", "historical", "massive", base, base)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var kinds []string
	for rows.Next() {
		event, err := ScanEvent(rows)
		if err != nil {
			t.Fatal(err)
		}
		kinds = append(kinds, event.Kind)
	}
	if len(kinds) != 2 || kinds[0] != "quote" || kinds[1] != "trade" {
		t.Fatalf("event order = %v", kinds)
	}
}

func TestDatabaseDrainsAsyncLiveWritesOnClose(t *testing.T) {
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "tape.db")
	cfg.QueueSize = 1024
	cfg.BatchSize = 128
	cfg.FlushInterval = time.Hour.String()
	database, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if !database.RecordTrade(TradeRecord{Symbol: "AAPL", EventUS: int64(i + 1), Price: 100, Size: 1, Source: "live", Provider: "ibkr"}) {
			t.Fatal("unexpected queue drop")
		}
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	dataRange, err := reopened.DataRange(context.Background(), "AAPL", "live", "ibkr")
	if err != nil {
		t.Fatal(err)
	}
	if dataRange.Trades != 100 {
		t.Fatalf("stored trades = %d, want 100", dataRange.Trades)
	}
}

func TestMinuteBarsRespectExactReplayPosition(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	base := time.Date(2026, 7, 17, 13, 30, 0, 0, time.UTC).UnixMicro()
	if err := database.InsertTrades(ctx, []TradeRecord{
		{Symbol: "IONQ", EventUS: base, Price: 10, Size: 100, Source: "historical", Provider: "massive"},
		{Symbol: "IONQ", EventUS: base + 20e6, Price: 12, Size: 50, Source: "historical", Provider: "massive"},
		{Symbol: "IONQ", EventUS: base + 50e6, Price: 9, Size: 25, Source: "historical", Provider: "massive"},
		{Symbol: "IONQ", EventUS: base + 70e6, Price: 11, Size: 10, Source: "historical", Provider: "massive"},
	}); err != nil {
		t.Fatal(err)
	}
	bars, err := database.MinuteBars(ctx, "IONQ", "historical", "massive", base, base+25e6)
	if err != nil {
		t.Fatal(err)
	}
	if len(bars) != 1 || bars[0].Open != 10 || bars[0].High != 12 || bars[0].Low != 10 || bars[0].Close != 12 || bars[0].Volume != 150 || bars[0].DollarVolume != 1600 {
		t.Fatalf("partial minute bar = %+v", bars)
	}
}
