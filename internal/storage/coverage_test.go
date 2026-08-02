package storage

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestInvalidateCoveragePreservesOnlyUnaffectedRemainders(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	if err := database.MarkCoverage(ctx, Coverage{
		Symbol: "AAPL", Provider: "massive", Kind: "quotes",
		StartUS: 100, EndUS: 500, CompletedUS: 42, RowCount: 99,
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.InvalidateCoverage(ctx, "AAPL", "massive", "quotes", 200, 299); err != nil {
		t.Fatal(err)
	}
	covered, missing, err := database.CoverageIntervals(ctx, "AAPL", "massive", "quotes", 100, 500)
	if err != nil {
		t.Fatal(err)
	}
	wantCovered := []Interval{{StartUS: 100, EndUS: 199}, {StartUS: 300, EndUS: 500}}
	wantMissing := []Interval{{StartUS: 200, EndUS: 299}}
	if !reflect.DeepEqual(covered, wantCovered) || !reflect.DeepEqual(missing, wantMissing) {
		t.Fatalf("covered=%+v missing=%+v, want covered=%+v missing=%+v", covered, missing, wantCovered, wantMissing)
	}
}

const minuteSizeUS = int64(time.Minute / time.Microsecond)

func easternMinute(t *testing.T, year int, month time.Month, day, hour, minute int) int64 {
	t.Helper()
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	return time.Date(year, month, day, hour, minute, 0, 0, location).UnixMicro()
}

// A repeated download of the same window must leave one row per minute with the
// corrected values, so a re-run after a bad partial fetch is always safe.
func TestMinuteBarUpsertReplacesWithoutDuplicating(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	minute := easternMinute(t, 2026, time.July, 2, 9, 35)
	first := []MinuteBar{
		{TimeUS: minute, Open: 10, High: 11, Low: 9, Close: 10.5, Volume: 100, DollarVolume: 1000},
		{TimeUS: minute + minuteSizeUS, Open: 10.5, High: 12, Low: 10, Close: 11, Volume: 200, DollarVolume: 2200},
	}
	for range 3 {
		if err := database.UpsertMinuteBars(ctx, "aapl", "MASSIVE", first); err != nil {
			t.Fatal(err)
		}
	}
	var rows int
	if err := database.db.QueryRow("SELECT COUNT(*) FROM minute_bars").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("repeated downloads duplicated rows: %d", rows)
	}
	corrected := []MinuteBar{{TimeUS: minute, Open: 10, High: 15, Low: 8, Close: 14, Volume: 500, DollarVolume: 7000}}
	if err := database.UpsertMinuteBars(ctx, "AAPL", "massive", corrected); err != nil {
		t.Fatal(err)
	}
	var high, volume float64
	if err := database.db.QueryRow("SELECT high,volume FROM minute_bars WHERE minute_us=?", minute).Scan(&high, &volume); err != nil {
		t.Fatal(err)
	}
	if high != 15 || volume != 500 {
		t.Fatalf("upsert did not replace deterministically: high=%v volume=%v", high, volume)
	}
	if err := database.db.QueryRow("SELECT COUNT(*) FROM minute_bars").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("upsert changed the row count: %d", rows)
	}
}

// An invalid bar aborts the whole batch: a half-written minute range would look
// like a completed download to every later coverage check.
func TestMinuteBarUpsertRejectsInvalidBatchAtomically(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	minute := easternMinute(t, 2026, time.July, 2, 9, 35)
	err := database.UpsertMinuteBars(ctx, "AAPL", "massive", []MinuteBar{
		{TimeUS: minute, Open: 10, High: 11, Low: 9, Close: 10, Volume: 100},
		{TimeUS: minute + minuteSizeUS, Open: 10, High: 5, Low: 9, Close: 10, Volume: 100},
	})
	if err == nil {
		t.Fatal("a bar with high below low must be rejected")
	}
	var rows int
	if err := database.db.QueryRow("SELECT COUNT(*) FROM minute_bars").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("a rejected batch left %d rows behind", rows)
	}
}

// A download that never completed must not be reported as covered, even when
// rows from it are already in the database.
func TestFailedDownloadIsNotMarkedComplete(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	start := easternMinute(t, 2026, time.July, 2, 9, 30)
	end := start + 10*minuteSizeUS
	if err := database.UpsertMinuteBars(ctx, "AAPL", "massive", []MinuteBar{
		{TimeUS: start, Open: 10, High: 11, Low: 9, Close: 10, Volume: 100},
	}); err != nil {
		t.Fatal(err)
	}
	complete, err := database.HasCoverage(ctx, "AAPL", "massive", "minute_bars", start, end)
	if err != nil || complete {
		t.Fatalf("rows without completed coverage must not read as covered: complete=%v err=%v", complete, err)
	}
	if err := database.MarkCoverage(ctx, Coverage{Symbol: "AAPL", Provider: "massive", Kind: "minute_bars", StartUS: start, EndUS: end}); err != nil {
		t.Fatal(err)
	}
	complete, err = database.HasCoverage(ctx, "AAPL", "massive", "minute_bars", start, end)
	if err != nil || !complete {
		t.Fatalf("a completed download must read as covered: complete=%v err=%v", complete, err)
	}
}

// A quiet period inside a completed download is coverage, not a gap. This is the
// difference between "nothing traded" and "never downloaded".
func TestQuietPeriodInsideCompletedCoverageIsNotMissing(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	start := easternMinute(t, 2026, time.July, 2, 4, 0)
	end := start + 120*minuteSizeUS
	if err := database.MarkCoverage(ctx, Coverage{Symbol: "AAPL", Provider: "massive", Kind: "trades", StartUS: start, EndUS: end, RowCount: 0}); err != nil {
		t.Fatal(err)
	}
	covered, missing, err := database.CoverageIntervals(ctx, "AAPL", "massive", "trades", start, end)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 0 || len(covered) != 1 || covered[0].StartUS != start || covered[0].EndUS != end {
		t.Fatalf("covered=%+v missing=%+v", covered, missing)
	}
}

// Adjacent and overlapping downloads merge into one interval; the union - not
// the first and last row - decides what is missing.
func TestCoverageMergesAdjacentAndOverlappingIntervals(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	for _, record := range []Coverage{
		{Symbol: "AAPL", Provider: "massive", Kind: "quotes", StartUS: 1000, EndUS: 1999},
		{Symbol: "AAPL", Provider: "massive", Kind: "quotes", StartUS: 2000, EndUS: 2999},
		{Symbol: "AAPL", Provider: "massive", Kind: "quotes", StartUS: 2500, EndUS: 3500},
		{Symbol: "AAPL", Provider: "massive", Kind: "quotes", StartUS: 5000, EndUS: 5999},
	} {
		if err := database.MarkCoverage(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	covered, missing, err := database.CoverageIntervals(ctx, "AAPL", "massive", "quotes", 1000, 6500)
	if err != nil {
		t.Fatal(err)
	}
	if len(covered) != 2 || covered[0].StartUS != 1000 || covered[0].EndUS != 3500 || covered[1].StartUS != 5000 {
		t.Fatalf("covered = %+v", covered)
	}
	if len(missing) != 2 || missing[0].StartUS != 3501 || missing[0].EndUS != 4999 || missing[1].StartUS != 6000 || missing[1].EndUS != 6500 {
		t.Fatalf("missing = %+v", missing)
	}
}

func TestCoverageIsolatesKindProviderAndSymbol(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	if err := database.MarkCoverage(ctx, Coverage{Symbol: "AAPL", Provider: "massive", Kind: "trades", StartUS: 1000, EndUS: 2000}); err != nil {
		t.Fatal(err)
	}
	for _, probe := range []struct{ symbol, provider, kind string }{
		{"NVDA", "massive", "trades"},
		{"AAPL", "ibkr", "trades"},
		{"AAPL", "massive", "quotes"},
		{"AAPL", "massive", "minute_bars"},
	} {
		complete, err := database.HasCoverage(ctx, probe.symbol, probe.provider, probe.kind, 1000, 2000)
		if err != nil || complete {
			t.Fatalf("coverage leaked to %+v: complete=%v err=%v", probe, complete, err)
		}
	}
	if err := database.MarkCoverage(ctx, Coverage{Symbol: "AAPL", Provider: "massive", Kind: "candles", StartUS: 1, EndUS: 2}); err == nil {
		t.Fatal("an unknown data kind must be rejected")
	}
}

// Precedence: exact prints win for a minute whose trade download completed;
// otherwise the cached aggregate stands alone. The two are never summed.
func TestCompletedMinutePrefersExactTradesOverCachedAggregate(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	covered := easternMinute(t, 2026, time.July, 2, 9, 31)
	uncovered := covered + minuteSizeUS
	target := uncovered + minuteSizeUS + 30e6

	if err := database.UpsertMinuteBars(ctx, "AAPL", "massive", []MinuteBar{
		{TimeUS: covered, Open: 10, High: 99, Low: 1, Close: 50, Volume: 9999, DollarVolume: 1},
		{TimeUS: uncovered, Open: 20, High: 22, Low: 19, Close: 21, Volume: 4321, DollarVolume: 2},
	}); err != nil {
		t.Fatal(err)
	}
	// Only the first minute has a completed detailed download behind it.
	if err := database.MarkCoverage(ctx, Coverage{Symbol: "AAPL", Provider: "massive", Kind: "trades", StartUS: covered, EndUS: covered + minuteSizeUS - 1, RowCount: 2}); err != nil {
		t.Fatal(err)
	}
	if err := database.InsertTrades(ctx, []TradeRecord{
		{Symbol: "AAPL", EventUS: covered + 1e6, MarketTimeUS: covered + 1e6, Price: 10, Size: 5, Source: "historical", Provider: "massive"},
		{Symbol: "AAPL", EventUS: covered + 2e6, MarketTimeUS: covered + 2e6, Price: 12, Size: 7, Source: "historical", Provider: "massive"},
		// A stray print inside the uncovered minute must not displace the aggregate.
		{Symbol: "AAPL", EventUS: uncovered + 1e6, MarketTimeUS: uncovered + 1e6, Price: 20.5, Size: 1, Source: "historical", Provider: "massive"},
	}); err != nil {
		t.Fatal(err)
	}
	bars, err := database.MinuteBars(ctx, "AAPL", "historical", "massive", covered, target)
	if err != nil {
		t.Fatal(err)
	}
	if len(bars) < 2 {
		t.Fatalf("bars = %+v", bars)
	}
	if bars[0].TimeUS != covered || bars[0].High != 12 || bars[0].Low != 10 || bars[0].Volume != 12 {
		t.Fatalf("a fully covered minute must come from exact prints: %+v", bars[0])
	}
	if bars[1].TimeUS != uncovered || bars[1].High != 22 || bars[1].Volume != 4321 {
		t.Fatalf("a partially covered minute must keep the cached aggregate: %+v", bars[1])
	}
	if bars[1].Volume == 4322 {
		t.Fatal("cached volume and detailed volume were double counted")
	}
}

// A target inside a minute may never reveal that minute's finished aggregate.
func TestFormingMinuteNeverRevealsTheCompletedAggregate(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	minute := easternMinute(t, 2026, time.July, 2, 9, 35)
	if err := database.UpsertMinuteBars(ctx, "AAPL", "massive", []MinuteBar{
		{TimeUS: minute, Open: 100, High: 140, Low: 60, Close: 130, Volume: 50000, DollarVolume: 1},
		{TimeUS: minute + minuteSizeUS, Open: 130, High: 150, Low: 120, Close: 145, Volume: 60000, DollarVolume: 1},
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.InsertTrades(ctx, []TradeRecord{
		{Symbol: "AAPL", EventUS: minute + 3e6, MarketTimeUS: minute + 3e6, Price: 100, Size: 10, Source: "historical", Provider: "massive"},
		{Symbol: "AAPL", EventUS: minute + 8e6, MarketTimeUS: minute + 8e6, Price: 101, Size: 20, Source: "historical", Provider: "massive"},
		// Everything after the 09:35:10 target is the future and must not appear.
		{Symbol: "AAPL", EventUS: minute + 40e6, MarketTimeUS: minute + 40e6, Price: 139, Size: 900, Source: "historical", Provider: "massive"},
	}); err != nil {
		t.Fatal(err)
	}
	bars, err := database.MinuteBars(ctx, "AAPL", "historical", "massive", minute, minute+10e6)
	if err != nil {
		t.Fatal(err)
	}
	if len(bars) != 1 {
		t.Fatalf("only the forming minute belongs at this target: %+v", bars)
	}
	forming := bars[0]
	if forming.TimeUS != minute || forming.High != 101 || forming.Low != 100 || forming.Close != 101 || forming.Volume != 30 {
		t.Fatalf("the forming minute leaked future data: %+v", forming)
	}
}

func TestMinuteBarRangeReportsCachedExtent(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	premarket := easternMinute(t, 2026, time.July, 2, 4, 0)
	open := easternMinute(t, 2026, time.July, 2, 9, 30)
	if err := database.UpsertMinuteBars(ctx, "AAPL", "massive", []MinuteBar{
		{TimeUS: premarket, Open: 10, High: 11, Low: 9, Close: 10, Volume: 1},
		{TimeUS: open, Open: 10, High: 11, Low: 9, Close: 10, Volume: 1},
	}); err != nil {
		t.Fatal(err)
	}
	first, last, count, err := database.MinuteBarRange(ctx, "AAPL", "massive", premarket-minuteSizeUS, open+minuteSizeUS)
	if err != nil || count != 2 || first != premarket || last != open {
		t.Fatalf("first=%d last=%d count=%d err=%v", first, last, count, err)
	}
	_, _, count, err = database.MinuteBarRange(ctx, "NVDA", "massive", premarket, open)
	if err != nil || count != 0 {
		t.Fatalf("another symbol must not report bars: count=%d err=%v", count, err)
	}
}

func TestCoverageRecordsListCompletedDownloads(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	for _, record := range []Coverage{
		{Symbol: "AAPL", Provider: "massive", Kind: "trades", StartUS: 1000, EndUS: 2000, RowCount: 7},
		{Symbol: "NVDA", Provider: "massive", Kind: "quotes", StartUS: 1000, EndUS: 2000, RowCount: 9},
	} {
		if err := database.MarkCoverage(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	all, err := database.CoverageRecords(ctx, "", "")
	if err != nil || len(all) != 2 {
		t.Fatalf("all = %+v err=%v", all, err)
	}
	filtered, err := database.CoverageRecords(ctx, "aapl", "massive")
	if err != nil || len(filtered) != 1 || filtered[0].Symbol != "AAPL" || filtered[0].RowCount != 7 || filtered[0].CompletedUS == 0 {
		t.Fatalf("filtered = %+v err=%v", filtered, err)
	}
}

// Invalidation must only ever remove the window it was asked about. Every other
// completed download has to survive with an accurate row count, because the
// caller deletes the underlying rows immediately afterwards and a lost interval
// would silently downgrade real data to "never downloaded".
func TestInvalidateCoverageKeepsUnrelatedAndNeighbouringIntervals(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	minute := easternMinute(t, 2026, time.July, 2, 9, 30)
	for _, record := range []Coverage{
		{Symbol: "AAPL", Provider: "massive", Kind: "trades", StartUS: minute, EndUS: minute + 10*minuteSizeUS},
		{Symbol: "AAPL", Provider: "massive", Kind: "quotes", StartUS: minute, EndUS: minute + 10*minuteSizeUS},
		{Symbol: "NVDA", Provider: "massive", Kind: "trades", StartUS: minute, EndUS: minute + 10*minuteSizeUS},
		{Symbol: "AAPL", Provider: "ibkr", Kind: "trades", StartUS: minute, EndUS: minute + 10*minuteSizeUS},
	} {
		if err := database.MarkCoverage(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	// An interval that merely touches the invalidated window's lower edge.
	if err := database.MarkCoverage(ctx, Coverage{
		Symbol: "AAPL", Provider: "massive", Kind: "trades",
		StartUS: minute - 5*minuteSizeUS, EndUS: minute - 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.InvalidateCoverage(ctx, "AAPL", "massive", "trades", minute+2*minuteSizeUS, minute+4*minuteSizeUS); err != nil {
		t.Fatal(err)
	}

	_, missing, err := database.CoverageIntervals(ctx, "AAPL", "massive", "trades", minute, minute+10*minuteSizeUS)
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 1 || missing[0].StartUS != minute+2*minuteSizeUS || missing[0].EndUS != minute+4*minuteSizeUS {
		t.Fatalf("missing = %+v", missing)
	}
	// The adjacent interval never overlapped the window and must be untouched.
	if complete, err := database.HasCoverage(ctx, "AAPL", "massive", "trades", minute-5*minuteSizeUS, minute-1); err != nil || !complete {
		t.Fatalf("the adjacent interval was disturbed: complete=%v err=%v", complete, err)
	}
	for _, other := range []struct{ symbol, provider, kind string }{
		{"AAPL", "massive", "quotes"}, {"NVDA", "massive", "trades"}, {"AAPL", "ibkr", "trades"},
	} {
		complete, err := database.HasCoverage(ctx, other.symbol, other.provider, other.kind, minute, minute+10*minuteSizeUS)
		if err != nil || !complete {
			t.Fatalf("invalidation leaked to %+v: complete=%v err=%v", other, complete, err)
		}
	}
}

// A download that deletes rows and then fails must leave coverage describing
// only what is still durable, which is what invalidating first buys.
func TestInvalidateThenFailedReplacementLeavesNoFalseCoverage(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	minute := easternMinute(t, 2026, time.July, 2, 9, 30)
	window := Coverage{Symbol: "AAPL", Provider: "massive", Kind: "trades", StartUS: minute, EndUS: minute + 5*minuteSizeUS, RowCount: 2}
	if err := database.MarkCoverage(ctx, window); err != nil {
		t.Fatal(err)
	}
	if err := database.InsertTrades(ctx, []TradeRecord{
		{Symbol: "AAPL", EventUS: minute + 1e6, MarketTimeUS: minute + 1e6, Price: 10, Size: 5, Source: "historical", Provider: "massive"},
	}); err != nil {
		t.Fatal(err)
	}
	// The downloader's order: drop the claim, then the rows. The replacement
	// never arrives.
	if err := database.InvalidateCoverage(ctx, "AAPL", "massive", "trades", minute, minute+5*minuteSizeUS); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteRange(ctx, "AAPL", "historical", "massive", minute, minute+5*minuteSizeUS); err != nil {
		t.Fatal(err)
	}
	complete, err := database.HasCoverage(ctx, "AAPL", "massive", "trades", minute, minute+5*minuteSizeUS)
	if err != nil || complete {
		t.Fatalf("a failed replacement must not stay covered: complete=%v err=%v", complete, err)
	}
	records, err := database.CoverageRecords(ctx, "AAPL", "massive")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 0 {
		t.Fatalf("stale coverage survived: %+v", records)
	}
}

// Invalidating a window nothing has ever covered must be a no-op rather than an
// error, so a first download can call it unconditionally.
func TestInvalidateCoverageOnAnUncoveredWindowIsANoOp(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	if err := database.InvalidateCoverage(ctx, "AAPL", "massive", "trades", 1000, 2000); err != nil {
		t.Fatal(err)
	}
	records, err := database.CoverageRecords(ctx, "", "")
	if err != nil || len(records) != 0 {
		t.Fatalf("records = %+v err = %v", records, err)
	}
	if err := database.InvalidateCoverage(ctx, "AAPL", "nasdaq", "trades", 1000, 2000); err == nil {
		t.Fatal("an unknown provider must be rejected rather than silently resolved")
	}
	if err := database.InvalidateCoverage(ctx, "AAPL", "massive", "candles", 1000, 2000); err == nil {
		t.Fatal("an unknown data kind must be rejected")
	}
}
