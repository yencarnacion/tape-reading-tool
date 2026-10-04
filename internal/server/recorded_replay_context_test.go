package server

import (
	"context"
	"testing"

	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
)

func TestRecordedReplayCueAndPreparedContextStayAsOf(t *testing.T) {
	f := newReplayPanelFixture(t)
	db := f.server.recorder
	start, target, end := f.at(f.session, 9, 30), f.at(f.session, 9, 36), f.at(f.session, 16, 0)
	err := db.InsertTrades(context.Background(), []storage.TradeRecord{
		{Symbol: "AAPL", EventUS: f.at(f.session, 9, 31), Price: 103, Size: 10, ChartEligible: true, Source: "live", Provider: "ibkr"},
		{Symbol: "AAPL", EventUS: f.at(f.session, 9, 45), Price: 1, Size: 10, ChartEligible: true, Source: "live", Provider: "ibkr"},
	})
	if err != nil {
		t.Fatal(err)
	}
	r := feed.NewReplay(db, f.server.store, "live", "ibkr", 1)
	f.server.feed = r
	if _, err := r.Cue(context.Background(), feed.ReplayRequest{Symbol: "AAPL", Source: "live", Provider: "ibkr", EndUS: end, Speed: 1}, start, target, false); err != nil {
		t.Fatal(err)
	}
	if state := r.Status(); state.State != "paused" || state.PositionUS != target || state.Source != "live" {
		t.Fatal(state)
	}
	snapshot := f.server.store.Snapshot("AAPL", 10)
	if len(snapshot.Trades) != 1 || snapshot.Trades[0].Price != 103 {
		t.Fatal("recorded warmup lost or future trade leaked", snapshot.Trades)
	}
	daily := f.daily(t, "symbol=AAPL&before=2026-07-22&limit=2")
	if daily.Status != "ready" || daily.Provider != "massive" || daily.Source != "historical" || daily.Bars[0].Low != 90 {
		t.Fatal("wrong baseline provenance", daily)
	}
	rth := f.rth(t, "symbol=AAPL&session=2026-07-22&through_us="+formatInt64(end))
	if rth.Status != "ready" || rth.Provider != "massive" || rth.Low != 99 || rth.ThroughUS != target {
		t.Fatal("fallback leaked future RTH low", rth)
	}
	if err := db.InvalidateCoverage(context.Background(), "AAPL", "massive", "trades", start, end); err != nil {
		t.Fatal(err)
	}
	if without := f.rth(t, "symbol=AAPL&session=2026-07-22"); without.Status != "incomplete" {
		t.Fatal("uncertified recording presented as complete", without)
	}
}
