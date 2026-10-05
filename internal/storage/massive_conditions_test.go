package storage

import (
	"context"
	"testing"
	"time"
)

func TestRecordedMassiveCandlesRespectPerFieldRules(t *testing.T) {
	db := testDatabase(t)
	ctx := context.Background()
	start := time.Date(2026, 10, 5, 14, 0, 0, 0, time.UTC).UnixMicro()
	var records []TradeRecord
	for i, v := range []struct {
		p, z float64
		c    string
	}{{50, 1, "37"}, {75, 100, ""}, {95, 200, "10,2,41"}, {74, 100, "32"}, {76, 100, "14,41"}, {1, 100, "999"}} {
		records = append(records, TradeRecord{Symbol: "PCVX", EventUS: start + int64(i)*1000, MarketTimeUS: start + int64(i)*1000, Price: v.p, Size: v.z, Conditions: v.c, Source: "live", Provider: "massive"})
	}
	if err := db.InsertTrades(ctx, records); err != nil {
		t.Fatal(err)
	}
	bars, err := db.MinuteBars(ctx, "PCVX", "live", "massive", start, start+59e6)
	if err != nil || len(bars) != 1 {
		t.Fatal(bars, err)
	}
	b := bars[0]
	if b.Open != 75 || b.High != 76 || b.Low != 74 || b.Close != 76 || b.Volume != 501 {
		t.Fatalf("special report corrupted candle: %+v", b)
	}
	stats, err := db.EligibleSessionTradeStats(ctx, "PCVX", "live", "massive", start, start+59e6, start+59e6)
	if err != nil || stats.Open != 75 || stats.High != 76 || stats.Low != 74 || stats.Last != 76 {
		t.Fatal(stats, err)
	}
	rows, err := db.Events(ctx, "PCVX", "live", "massive", start, start+59e6)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := []uint8{12, 15, 12, 14, 15, 8}
	i := 0
	for rows.Next() {
		e, err := ScanEvent(rows)
		if err != nil || e.Flags != want[i] {
			t.Fatal(e, err)
		}
		i++
	}
	if i != len(want) {
		t.Fatal(i)
	}
}
