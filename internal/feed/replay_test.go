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
