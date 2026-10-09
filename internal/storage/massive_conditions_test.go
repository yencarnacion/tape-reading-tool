package storage

import (
	"context"
	"testing"
	"time"
)

func TestRecordedPremarketCandlesAndRewind(t *testing.T) {
	db := testDatabase(t)
	ctx := context.Background()
	at, _ := time.Parse(time.RFC3339, "2026-10-08T09:28:00-04:00")
	start := at.UnixMicro()
	received := at.Add(3 * time.Minute).UnixMicro() // delivery crosses the RTH boundary
	var records []TradeRecord
	for i, v := range []struct {
		offset      int64
		price, size float64
		conditions  string
	}{
		{0, 117.21, 100, "12"}, {1e6, 900, 1, "12,37"}, {2e6, 1, 10, "2,12"},
		{3e6, 117.17, 100, "14,12,41"},
		{60e6, 117.06, 100, "12"}, {61e6, 118.81, 100, "14,12,41"}, {62e6, 117.05, 100, "12"},
		{63e6, 1, 10, "13"}, {64e6, 117.30, 100, "12"},
		{120e6, 999, 10, "12"}, {121e6, 117.40, 100, "0,14,41"},
	} {
		records = append(records, TradeRecord{Symbol: "AAOI", EventUS: received + int64(i)*1000, ReceivedUS: received + int64(i)*1000,
			MarketTimeUS: start + v.offset, ExchangeTimeMS: (start + v.offset) / 1000, RingSeq: uint64(i + 1),
			Price: v.price, Size: v.size, Conditions: v.conditions, Source: "live", Provider: "massive"})
	}
	if err := db.InsertTrades(ctx, records); err != nil {
		t.Fatal(err)
	}
	// Existing recordings carry the old exclusion marker. Re-evaluate their
	// conditions without requiring a database migration or redownload.
	if _, err := db.db.Exec(`UPDATE trades SET chart_eligible=0,chart_exclusion_reason='massive_sale_condition' WHERE conditions LIKE '%12%'`); err != nil {
		t.Fatal(err)
	}
	bars, err := db.MinuteBars(ctx, "AAOI", "live", "massive", start, start+179e6)
	if err != nil || len(bars) != 3 {
		t.Fatalf("bars=%+v err=%v", bars, err)
	}
	want := []MinuteBar{
		{TimeUS: start, Open: 117.21, High: 117.21, Low: 117.17, Close: 117.17, Volume: 211},
		{TimeUS: start + 60e6, Open: 117.06, High: 118.81, Low: 117.05, Close: 117.30, Volume: 410},
		{TimeUS: start + 120e6, Open: 117.40, High: 117.40, Low: 117.40, Close: 117.40, Volume: 110},
	}
	for i, b := range bars {
		b.DollarVolume = 0
		if b != want[i] {
			t.Errorf("bar %d=%+v want %+v", i, b, want[i])
		}
	}
	rows, err := db.Events(ctx, "AAOI", "live", "massive", received, received+1e6)
	if err != nil {
		t.Fatal(err)
	}
	wantFlags := []uint8{31, 28, 12, 31, 31, 31, 31, 12, 31, 28, 31}
	i := 0
	for rows.Next() {
		e, err := ScanEvent(rows)
		if err != nil || e.Flags != wantFlags[i] {
			t.Fatalf("replay event=%+v err=%v want=%d", e, err, wantFlags[i])
		}
		i++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if i != len(wantFlags) {
		t.Fatalf("replayed %d events", i)
	}
	trades, err := db.TradesByRingSeq(ctx, "AAOI", 1, uint64(len(records)), received, len(records), "massive")
	if err != nil || len(trades) != len(records) {
		t.Fatalf("rewind=%+v err=%v", trades, err)
	}
	for i, tr := range trades {
		if tr.Flags != wantFlags[i] {
			t.Fatalf("rewind trade=%+v want=%d", tr, wantFlags[i])
		}
	}
	// A partially elapsed minute exposes only prints through the replay cursor.
	partial, err := db.MinuteBars(ctx, "AAOI", "live", "massive", start, start+60e6)
	if err != nil || len(partial) != 2 || partial[1].High != 117.06 {
		t.Fatalf("partial=%+v err=%v", partial, err)
	}
}

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
	want := []uint8{28, 31, 12, 14, 31, 8}
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
