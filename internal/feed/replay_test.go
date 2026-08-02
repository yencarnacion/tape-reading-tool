package feed

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

func TestReplayPauseResumeSeekAndHistoricalQuoteClassification(t *testing.T) {
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "replay.db")
	database, err := storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	base := time.Date(2026, 7, 17, 13, 30, 0, 0, time.UTC).UnixMicro()
	ctx := context.Background()
	if err := database.InsertQuotes(ctx, []storage.QuoteRecord{
		{Symbol: "IONQ", EventUS: base, Bid: 34.49, Ask: 34.50, Source: "historical", Provider: "massive"},
		{Symbol: "IONQ", EventUS: base + 10e6, Bid: 34.50, Ask: 34.51, Source: "historical", Provider: "massive"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.InsertTrades(ctx, []storage.TradeRecord{
		{Symbol: "IONQ", EventUS: base, ExchangeTimeMS: base / 1000, Price: 34.50, Size: 100, Source: "historical", Provider: "massive"},
		{Symbol: "IONQ", EventUS: base + 10e6, ExchangeTimeMS: (base + 10e6) / 1000, Price: 34.51, Size: 200, Source: "historical", Provider: "massive"},
	}); err != nil {
		t.Fatal(err)
	}

	store := tape.NewStore("IONQ", 100, 4)
	replay := NewReplay(database, store, "historical", "massive", 20)
	request := ReplayRequest{Symbol: "IONQ", Source: "historical", Provider: "massive", StartUS: base, EndUS: base + 11e6, Speed: 20}
	if err := replay.Start(request); err != nil {
		t.Fatal(err)
	}
	waitReplayState(t, replay, "replaying")
	if err := replay.Pause(); err != nil {
		t.Fatal(err)
	}
	seekUS := base + 5e6
	if err := replay.SeekTo(seekUS); err != nil {
		t.Fatal(err)
	}
	if err := replay.Pause(); err != nil {
		t.Fatal(err)
	}
	if got := replay.Status().PositionUS; got != seekUS {
		t.Fatalf("paused seek position = %d, want %d", got, seekUS)
	}
	if err := replay.Resume(); err != nil {
		t.Fatal(err)
	}
	waitReplayState(t, replay, "complete")
	snapshot := store.Snapshot("IONQ", 10)
	if len(snapshot.Trades) != 1 || snapshot.Trades[0].Side != 1 || snapshot.Trades[0].Class != tape.AtAsk {
		t.Fatalf("historical replay trade = %+v, want at-ask buyer", snapshot.Trades)
	}
	if got, want := snapshot.Trades[0].ReceivedUS, base+10e6; got != want {
		t.Fatalf("historical replay receipt clock = %d, want event time %d", got, want)
	}
}

func waitReplayState(t *testing.T, replay *Replay, wanted string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if replay.Status().State == wanted {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("replay state = %q, want %q", replay.Status().State, wanted)
}

func TestReplayUsesPersistedEligibilityAndReceiptCadence(t *testing.T) {
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "replay.db")
	database, err := storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	base := time.Date(2026, 7, 17, 13, 30, 0, 0, time.UTC).UnixMicro()
	if err := database.InsertTrades(context.Background(), []storage.TradeRecord{
		{Symbol: "TEST", EventUS: base, MarketTimeUS: base, ReceivedUS: base, SequenceID: 1, Price: 100, Size: 10, ChartEligible: true, Source: "live", Provider: "ibkr"},
		{Symbol: "TEST", EventUS: base + 1000, MarketTimeUS: base, ReceivedUS: base + 1000, SequenceID: 2, Price: 95, Size: 1000, Unreported: true, ChartExclusionReason: tape.ExcludeUnreported, Source: "live", Provider: "ibkr"},
		{Symbol: "TEST", EventUS: base + 2000, MarketTimeUS: base, ReceivedUS: base + 2000, SequenceID: 3, Price: 100.02, Size: 20, ChartEligible: true, Source: "live", Provider: "ibkr"},
	}); err != nil {
		t.Fatal(err)
	}
	store := tape.NewStore("TEST", 100, 4)
	replay := NewReplay(database, store, "live", "ibkr", 20)
	if err := replay.Start(ReplayRequest{Symbol: "TEST", Source: "live", Provider: "ibkr", StartUS: base, EndUS: base + 3000, Speed: 20}); err != nil {
		t.Fatal(err)
	}
	waitReplayState(t, replay, "complete")
	trades := store.Snapshot("TEST", 10).Trades
	if len(trades) != 2 || trades[0].Price != 100 || trades[1].Price != 100.02 || trades[1].ReceivedUS != base+2000 {
		t.Fatalf("replayed chart stream = %+v", trades)
	}
}

func TestDeterministicRenderWarmsAndStepsWithoutWallClock(t *testing.T) {
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "render.db")
	database, err := storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	base := time.Date(2026, 7, 22, 13, 0, 0, 0, time.UTC).UnixMicro()
	if err := database.InsertTrades(context.Background(), []storage.TradeRecord{
		{Symbol: "IREN", EventUS: base, MarketTimeUS: base, Price: 40, Size: 10, ChartEligible: true, Source: "historical", Provider: "massive"},
		{Symbol: "IREN", EventUS: base + 30e6, MarketTimeUS: base + 30e6, Price: 40.01, Size: 20, ChartEligible: true, Source: "historical", Provider: "massive"},
		{Symbol: "IREN", EventUS: base + 61e6, MarketTimeUS: base + 61e6, Price: 40.02, Size: 30, ChartEligible: true, Source: "historical", Provider: "massive"},
	}); err != nil {
		t.Fatal(err)
	}
	store := tape.NewStore("IREN", 100, 4)
	replay := NewReplay(database, store, "historical", "massive", 1)
	request := ReplayRequest{
		Symbol: "IREN", Source: "historical", Provider: "massive",
		StartUS: base + 60e6, EndUS: base + 120e6, Speed: 1,
	}
	if err := replay.PrepareRender(request, base); err != nil {
		t.Fatal(err)
	}
	warmed := store.Snapshot("IREN", 10).Trades
	if len(warmed) != 2 || warmed[0].Price != 40 || warmed[1].Price != 40.01 {
		t.Fatalf("warmup trades = %+v", warmed)
	}
	if got := replay.Status().PositionUS; got != request.StartUS {
		t.Fatalf("render position = %d, want %d", got, request.StartUS)
	}
	sequence, err := replay.StepRender(base + 62e6)
	if err != nil {
		t.Fatal(err)
	}
	if sequence == 0 {
		t.Fatal("render step returned no browser sequence")
	}
	trades := store.Snapshot("IREN", 10).Trades
	if len(trades) != 3 || trades[2].Price != 40.02 {
		t.Fatalf("stepped trades = %+v", trades)
	}
	if _, err := replay.StepRender(base + 61e6); err == nil {
		t.Fatal("backward render step succeeded")
	}
}

// Live Rewind introduced a shared event source in the browser. Historical replay
// is server-driven and reaches the browser as ordinary trade messages, so this
// pins the exact stream the replay path emits, field by field.
func TestHistoricalReplayEmitsAnUnchangedEventStream(t *testing.T) {
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "replay.db")
	database, err := storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	ctx := context.Background()
	base := time.Date(2026, 7, 22, 13, 30, 0, 0, time.UTC).UnixMicro()
	if err := database.InsertQuotes(ctx, []storage.QuoteRecord{
		{Symbol: "IREN", EventUS: base, Bid: 41.99, Ask: 42.01, BidSize: 300, AskSize: 400, Source: "historical", Provider: "ibkr"},
		{Symbol: "IREN", EventUS: base + 3e6, Bid: 42.00, Ask: 42.02, BidSize: 100, AskSize: 200, Source: "historical", Provider: "ibkr"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.InsertTrades(ctx, []storage.TradeRecord{
		{Symbol: "IREN", EventUS: base + 1e6, MarketTimeUS: base + 1e6, Price: 42.01, Size: 100, Source: "historical", Provider: "ibkr"},
		{Symbol: "IREN", EventUS: base + 2e6, MarketTimeUS: base + 2e6, Price: 41.99, Size: 250, Source: "historical", Provider: "ibkr"},
		{Symbol: "IREN", EventUS: base + 4e6, MarketTimeUS: base + 4e6, Price: 42.01, Size: 75, Source: "historical", Provider: "ibkr"},
		{Symbol: "IREN", EventUS: base + 5e6, MarketTimeUS: base + 5e6, Price: 42.03, Size: 1000, Source: "historical", Provider: "ibkr"},
	}); err != nil {
		t.Fatal(err)
	}

	store := tape.NewStore("IREN", 100, 4)
	replay := NewReplay(database, store, "historical", "ibkr", 20)
	if err := replay.Start(ReplayRequest{
		Symbol: "IREN", Source: "historical", Provider: "ibkr",
		StartUS: base, EndUS: base + 6e6, Speed: 20,
	}); err != nil {
		t.Fatal(err)
	}
	waitReplayState(t, replay, "complete")

	want := []tape.Trade{
		{Seq: 1, ExchangeTimeMS: (base + 1e6) / 1000, ReceivedUS: base + 1e6, Price: 42.01, Size: 100, Class: tape.AtAsk, Side: 1, Bid: 41.99, Ask: 42.01},
		{Seq: 2, ExchangeTimeMS: (base + 2e6) / 1000, ReceivedUS: base + 2e6, Price: 41.99, Size: 250, Class: tape.AtBid, Side: -1, Bid: 41.99, Ask: 42.01},
		{Seq: 3, ExchangeTimeMS: (base + 4e6) / 1000, ReceivedUS: base + 4e6, Price: 42.01, Size: 75, Class: tape.Between, Side: 1, Bid: 42.00, Ask: 42.02},
		{Seq: 4, ExchangeTimeMS: (base + 5e6) / 1000, ReceivedUS: base + 5e6, Price: 42.03, Size: 1000, Class: tape.AboveAsk, Side: 1, Bid: 42.00, Ask: 42.02},
	}
	got := store.Snapshot("IREN", 100).Trades
	if len(got) != len(want) {
		t.Fatalf("replayed %d trades, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("replayed trade %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if quote := store.Quote("IREN"); quote.Bid != 42.00 || quote.Ask != 42.02 || quote.BidSize != 100 || quote.AskSize != 200 {
		t.Fatalf("replayed quote = %+v", quote)
	}
}

func TestResetSubscriptionsRejectsStaleRequestIDs(t *testing.T) {
	f := NewIBKR(config.Defaults().IBKR, tape.NewStore("AAPL", 10, 2), nil)
	f.reqSymbols[41] = "AAPL"
	f.subs["AAPL"] = &subscription{symbol: "AAPL", tradeID: 41, quoteID: 42}
	f.resetSubscriptions()
	if got := f.symbolFor(41); got != "" {
		t.Fatalf("stale request mapped to %q", got)
	}
	if len(f.subs) != 0 {
		t.Fatalf("subscriptions survived reconnect: %+v", f.subs)
	}
}
