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
	if err := replay.Seek(seekUS); err != nil {
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
