package tape

import (
	"math"
	"testing"
	"time"
)

func TestLastPriceSnapshotAndTradeOrdering(t *testing.T) {
	s := NewStore("TEST", 100, 2)
	at := time.Now()
	s.UpdateLastPrice("TEST", 429, at.UnixMilli())
	if got := s.Snapshot("TEST", 10); got.Quote.LastPrice != 429 || len(got.Trades) != 0 {
		t.Fatalf("snapshot manufactured a print: %+v", got)
	}
	s.AddTradeWithRules("TEST", at.Add(time.Millisecond), at, 429.5, .25, MassiveTradeFlags("12,37"), "12,37")
	s.UpdateLastPrice("TEST", 1, at.UnixMilli())
	s.AddTradeWithRules("TEST", at.Add(2*time.Millisecond), at, 900, 100, MassiveTradeFlags("2,12,37"), "2,12,37")
	s.AddTradeWithRules("TEST", at.Add(-time.Second), at, 1, 100, MassiveTradeFlags("12"), "12")
	for _, price := range []float64{0, math.NaN(), math.Inf(1)} {
		s.UpdateLastPrice("TEST", price, at.Add(time.Hour).UnixMilli())
	}
	if got := s.Quote("TEST"); got.LastPrice != 429.5 || got.LastTimeMS != at.Add(time.Millisecond).UnixMilli() {
		t.Fatalf("stale or special report replaced LAST: %+v", got)
	}
	s.Activate("NEW")
	if got := s.Quote("NEW"); got.LastPrice != 0 {
		t.Fatalf("previous symbol leaked: %+v", got)
	}
	// A historical rebuild cannot inherit the old live/snapshot price.
	stage := s.PrepareRebuild("TEST")
	stage.AddTrade(at.Add(-time.Hour), at.Add(-time.Hour), 400, 100)
	if !stage.Commit() {
		t.Fatal("rebuild failed")
	}
	if got := s.Quote("TEST"); got.LastPrice != 400 {
		t.Fatalf("live price leaked into replay: %+v", got)
	}
}
