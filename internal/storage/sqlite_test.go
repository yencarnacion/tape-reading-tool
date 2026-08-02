package storage

import (
	"context"
	"math"
	"os"
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

func TestMinuteBarsUseEligibleMarketTimeAndDeterministicOrder(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	minute := time.Date(2026, 7, 17, 13, 30, 0, 0, time.UTC).UnixMicro()
	receivedNextMinute := minute + 60e6 + 50e3
	records := []TradeRecord{
		{Symbol: "TEST", EventUS: minute + 1e6, MarketTimeUS: minute + 59e6, ReceivedUS: receivedNextMinute, SequenceID: 1, Price: 100, Size: 10, ChartEligible: true, Source: "live", Provider: "ibkr"},
		{Symbol: "TEST", EventUS: minute + 2e6, MarketTimeUS: minute + 59e6, ReceivedUS: receivedNextMinute + 1, SequenceID: 2, Price: 100.01, Size: 20, ChartEligible: true, Source: "live", Provider: "ibkr"},
		{Symbol: "TEST", EventUS: minute + 3e6, MarketTimeUS: minute + 59e6, ReceivedUS: receivedNextMinute + 2, SequenceID: 3, Price: 95, Size: 1000, Unreported: true, ChartExclusionReason: tape.ExcludeUnreported, Source: "live", Provider: "ibkr"},
		{Symbol: "TEST", EventUS: minute + 4e6, MarketTimeUS: minute + 59e6, ReceivedUS: receivedNextMinute + 3, SequenceID: 4, Price: 100.02, Size: 30, ChartEligible: true, Source: "live", Provider: "ibkr"},
	}
	if err := database.InsertTrades(ctx, records); err != nil {
		t.Fatal(err)
	}
	bars, err := database.MinuteBars(ctx, "TEST", "live", "ibkr", minute, minute+60e6-1)
	if err != nil {
		t.Fatal(err)
	}
	if len(bars) != 1 {
		t.Fatalf("bars=%+v", bars)
	}
	b := bars[0]
	if b.TimeUS != minute || b.Open != 100 || b.High != 100.02 || b.Low != 100 || b.Close != 100.02 || b.Volume != 60 || math.Abs(b.DollarVolume-6000.8) > 1e-9 {
		t.Fatalf("eligible OHLCV/order = %+v", b)
	}
}

func TestMinuteBarsRetainLargeLegitimateMovement(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	minute := time.Date(2026, 7, 17, 13, 30, 0, 0, time.UTC).UnixMicro()
	if err := database.InsertTrades(ctx, []TradeRecord{
		{Symbol: "TEST", EventUS: minute, MarketTimeUS: minute, SequenceID: 1, Price: 100, Size: 10, ChartEligible: true, Source: "live", Provider: "ibkr"},
		{Symbol: "TEST", EventUS: minute + 1, MarketTimeUS: minute, SequenceID: 2, Price: 95, Size: 20, ChartEligible: true, Source: "live", Provider: "ibkr"},
	}); err != nil {
		t.Fatal(err)
	}
	bars, err := database.MinuteBars(ctx, "TEST", "live", "ibkr", minute, minute+59e6)
	if err != nil {
		t.Fatal(err)
	}
	if len(bars) != 1 || bars[0].Low != 95 || bars[0].Close != 95 || bars[0].Volume != 30 {
		t.Fatalf("legitimate move missing: %+v", bars)
	}
}

func TestTradesByRingSeqServesOverwrittenRewindRange(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	base := time.Date(2026, 7, 22, 13, 30, 0, 0, time.UTC).UnixMicro()
	records := []TradeRecord{
		{Symbol: "IREN", EventUS: base, ReceivedUS: base, RingSeq: 1, ExchangeTimeMS: base / 1000, Price: 10, Size: 100, Class: tape.AtAsk, Side: 1, Bid: 9.99, Ask: 10, ChartEligible: true, Source: "live", Provider: "ibkr"},
		{Symbol: "IREN", EventUS: base + 1, ReceivedUS: base + 1, RingSeq: 2, ExchangeTimeMS: base / 1000, Price: 9.99, Size: 200, Class: tape.AtBid, Side: -1, Bid: 9.99, Ask: 10, ChartEligible: true, Source: "live", Provider: "ibkr"},
		{Symbol: "IREN", EventUS: base + 2, ReceivedUS: base + 2, RingSeq: 3, ExchangeTimeMS: base / 1000, Price: 10.01, Size: 300, Class: tape.AboveAsk, Side: 1, Bid: 9.99, Ask: 10, ChartEligible: true, Source: "live", Provider: "ibkr"},
		// Never entered the ring, so it must never appear in a rewind range.
		{Symbol: "IREN", EventUS: base + 3, ReceivedUS: base + 3, RingSeq: 0, Price: 50, Size: 1, Unreported: true, ChartExclusionReason: tape.ExcludeUnreported, Source: "live", Provider: "ibkr"},
		// A different symbol, and a Massive row, must both be excluded.
		{Symbol: "AAPL", EventUS: base + 4, ReceivedUS: base + 4, RingSeq: 2, Price: 200, Size: 5, ChartEligible: true, Source: "live", Provider: "ibkr"},
		{Symbol: "IREN", EventUS: base + 5, ReceivedUS: base + 5, RingSeq: 2, Price: 77, Size: 7, ChartEligible: true, Source: "live", Provider: "massive"},
	}
	if err := database.InsertTrades(ctx, records); err != nil {
		t.Fatal(err)
	}

	trades, err := database.TradesByRingSeq(ctx, "IREN", 1, 3, base, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(trades) != 3 {
		t.Fatalf("trades = %+v", trades)
	}
	for i, want := range []uint64{1, 2, 3} {
		if trades[i].Seq != want {
			t.Fatalf("trade %d sequence = %d, want %d", i, trades[i].Seq, want)
		}
	}
	if trades[1].Price != 9.99 || trades[1].Size != 200 || trades[1].Class != tape.AtBid || trades[1].Side != -1 || trades[1].Bid != 9.99 || trades[1].Ask != 10 {
		t.Fatalf("classified trade did not round-trip: %+v", trades[1])
	}

	middle, err := database.TradesByRingSeq(ctx, "IREN", 2, 2, base, 100)
	if err != nil || len(middle) != 1 || middle[0].Seq != 2 || middle[0].Price != 9.99 {
		t.Fatalf("single-sequence range = %+v, err = %v", middle, err)
	}
	bounded, err := database.TradesByRingSeq(ctx, "IREN", 1, 3, base, 2)
	if err != nil || len(bounded) != 2 {
		t.Fatalf("limit was not honored: %+v, err = %v", bounded, err)
	}
	// Receipts from an earlier process run reuse ring sequences and must not leak.
	stale, err := database.TradesByRingSeq(ctx, "IREN", 1, 3, base+3, 100)
	if err != nil || len(stale) != 0 {
		t.Fatalf("stale process rows leaked: %+v, err = %v", stale, err)
	}
	if _, err := database.TradesByRingSeq(ctx, "IREN", 0, 3, base, 100); err == nil {
		t.Fatal("zero sequence should be rejected")
	}
}

func TestUIEventsRecordOnTheReceiptTimeline(t *testing.T) {
	database := testDatabase(t)
	received := time.Date(2026, 7, 22, 13, 31, 0, 0, time.UTC).UnixMicro()
	if !database.RecordUIEvent(UIEventRecord{Symbol: "IREN", EventUS: received, ReceivedUS: received, Kind: UIEventTickSize, ValueNum: 100, Source: "live", Provider: "ibkr"}) {
		t.Fatal("unexpected queue drop")
	}
	if !database.RecordUIEvent(UIEventRecord{Symbol: "IREN", EventUS: received + 5, ReceivedUS: received + 5, Kind: UIEventSymbol, ValueText: "IREN", Source: "live", Provider: "ibkr"}) {
		t.Fatal("unexpected queue drop")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		var count int
		if err := database.db.QueryRow("SELECT COUNT(*) FROM ui_events WHERE symbol='IREN'").Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ui_events rows = %d, want 2", count)
		}
		time.Sleep(5 * time.Millisecond)
	}
	var kind string
	var value float64
	if err := database.db.QueryRow("SELECT kind, value_num FROM ui_events WHERE symbol='IREN' ORDER BY received_us LIMIT 1").Scan(&kind, &value); err != nil {
		t.Fatal(err)
	}
	if kind != UIEventTickSize || value != 100 {
		t.Fatalf("first ui event = %s/%v", kind, value)
	}
}

func TestOpenRejectsOlderSchemaWithoutDeletingIt(t *testing.T) {
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "tape.db")
	database, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.db.Exec("UPDATE metadata SET value='2' WHERE key='schema_version'"); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(cfg); err == nil {
		t.Fatal("an older schema version must be reported as an error")
	}
	if _, err := os.Stat(cfg.Path); err != nil {
		t.Fatalf("the older database must never be deleted: %v", err)
	}
}

func TestOpenMigratesSchemaThreeAndPreservesRows(t *testing.T) {
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "tape.db")
	db, err := Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 7, 1, 13, 30, 0, 0, time.UTC).UnixMicro()
	if err := db.InsertTrades(context.Background(), []TradeRecord{{Symbol: "AAPL", EventUS: base, Price: 200, Size: 10, Source: "historical", Provider: "massive"}}); err != nil {
		t.Fatal(err)
	}
	// Recreate the actual previous layout: the durable event tables exist, but
	// the new bar and coverage tables do not.
	if _, err := db.db.Exec(`DROP TABLE minute_bars; DROP TABLE download_coverage;
      UPDATE metadata SET value='3' WHERE key='schema_version'`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rangeValue, err := db.DataRange(context.Background(), "AAPL", "historical", "massive")
	if err != nil || rangeValue.Trades != 1 {
		t.Fatalf("preserved range=%+v err=%v", rangeValue, err)
	}
	if err := db.UpsertMinuteBars(context.Background(), "AAPL", "massive", []MinuteBar{{TimeUS: base, Open: 1, High: 2, Low: 1, Close: 2, Volume: 3}}); err != nil {
		t.Fatal(err)
	}
}

func TestCoverageUnionAndMinuteBarMergePreventsFutureLeakage(t *testing.T) {
	db := testDatabase(t)
	ctx := context.Background()
	minute := time.Date(2026, 7, 1, 13, 35, 0, 0, time.UTC).UnixMicro()
	size := int64(time.Minute / time.Microsecond)
	for _, c := range []Coverage{{Symbol: "AAPL", Provider: "massive", Kind: "minute_bars", StartUS: minute - size, EndUS: minute + size - 1, RowCount: 2}, {Symbol: "AAPL", Provider: "massive", Kind: "trades", StartUS: minute - size, EndUS: minute - 1, RowCount: 1}} {
		if err := db.MarkCoverage(ctx, c); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertMinuteBars(ctx, "AAPL", "massive", []MinuteBar{{TimeUS: minute - size, Open: 9, High: 10, Low: 9, Close: 10, Volume: 100}, {TimeUS: minute, Open: 10, High: 99, Low: 1, Close: 50, Volume: 9999}}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertTrades(ctx, []TradeRecord{{Symbol: "AAPL", EventUS: minute + 5e6, MarketTimeUS: minute + 5e6, Price: 10, Size: 10, Source: "historical", Provider: "massive"}, {Symbol: "AAPL", EventUS: minute + 10e6, MarketTimeUS: minute + 10e6, Price: 11, Size: 20, Source: "historical", Provider: "massive"}}); err != nil {
		t.Fatal(err)
	}
	bars, err := db.MinuteBars(ctx, "AAPL", "historical", "massive", minute-size, minute+10e6)
	if err != nil {
		t.Fatal(err)
	}
	if len(bars) != 2 || bars[1].High != 11 || bars[1].Low != 10 || bars[1].Close != 11 || bars[1].Volume != 30 {
		t.Fatalf("future aggregate leaked: %+v", bars)
	}
	if err := db.MarkCoverage(ctx, Coverage{Symbol: "AAPL", Provider: "massive", Kind: "quotes", StartUS: 100, EndUS: 199}); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkCoverage(ctx, Coverage{Symbol: "AAPL", Provider: "massive", Kind: "quotes", StartUS: 200, EndUS: 299}); err != nil {
		t.Fatal(err)
	}
	covered, missing, err := db.CoverageIntervals(ctx, "AAPL", "massive", "quotes", 100, 350)
	if err != nil {
		t.Fatal(err)
	}
	if len(covered) != 1 || covered[0].EndUS != 299 || len(missing) != 1 || missing[0].StartUS != 300 {
		t.Fatalf("covered=%+v missing=%+v", covered, missing)
	}
}
