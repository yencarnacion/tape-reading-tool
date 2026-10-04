package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOptionsReplayAsOfSeekAndCursor(t *testing.T) {
	s := newOptionsService()
	s.archiveDir = t.TempDir()
	at, _ := time.Parse(time.RFC3339, "2026-07-24T13:30:00Z")
	a := optionsArchive{SchemaVersion: 1, Symbol: "TEST", Date: "2026-07-24", StartMS: at.UnixMilli(), EndMS: at.Add(time.Minute).UnixMilli(), Method: "test model"}
	for i := 0; i < 3; i++ {
		stamp := at.Add(time.Duration(i) * 5 * time.Second).UnixMilli()
		a.Samples = append(a.Samples, optionsReply{SchemaVersion: 1, Symbol: "TEST", Status: "ready", Estimated: true, AsOfMS: stamp, Spot: 100 + float64(i), Contracts: []optionContract{{Ticker: "O:TEST260731C00100000", Timeframe: "HISTORICAL", QuoteMS: stamp - 1}}})
	}
	body, _ := json.Marshal(a)
	if err := os.WriteFile(filepath.Join(s.archiveDir, "TEST-2026-07-24.json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	seed := optionsReply{SchemaVersion: 1, Symbol: "TEST", Generation: 42}
	first := s.replayAt(seed, at.Add(6*time.Second), 0)
	if !first.Replay || !first.Estimated || first.Generation != 42 || first.Spot != 101 || len(first.Samples) != 2 {
		t.Fatalf("as-of leaked or lost history: %+v", first)
	}
	for _, sample := range first.Samples {
		if sample.AsOfMS > at.Add(6*time.Second).UnixMilli() {
			t.Fatal("future sample")
		}
	}
	forward := s.replayAt(seed, at.Add(11*time.Second), first.AsOfMS)
	if len(forward.Samples) != 1 || forward.Spot != 102 {
		t.Fatal(forward)
	}
	back := s.replayAt(seed, at.Add(time.Second), 0)
	if back.Spot != 100 || len(back.Samples) != 1 {
		t.Fatal("backward seek retained future values", back)
	}
	paused := s.replayAt(seed, at.Add(time.Second), back.AsOfMS)
	if len(paused.Samples) != 0 || paused.AsOfMS != back.AsOfMS || paused.Spot != back.Spot {
		t.Fatal("pause moved", paused)
	}
	if v := s.replayAt(seed, at.Add(-time.Second), 0); v.Status != "replay-outside-range" || len(v.Contracts) != 0 {
		t.Fatal(v)
	}
	if v := s.replayAt(seed, at.Add(61*time.Second), 0); v.Status != "replay-outside-range" {
		t.Fatal(v)
	}
	if v := s.replayAt(seed, at.AddDate(0, 0, -1), 0); v.Status != "replay-unavailable" {
		t.Fatal(v)
	}
}

func TestOptionsReplayRejectsFutureQuotesAndMalformedArchive(t *testing.T) {
	a := optionsArchive{SchemaVersion: 1, Symbol: "TEST", Date: "2026-07-24", StartMS: 1000, EndMS: 2000,
		Samples: []optionsReply{{SchemaVersion: 1, Symbol: "TEST", AsOfMS: 1000, Estimated: true, Contracts: []optionContract{{Timeframe: "HISTORICAL", QuoteMS: 1001}}}}}
	if validOptionsArchive(&a, "TEST", a.Date) {
		t.Fatal("future quote accepted")
	}
	a.Samples[0].Contracts[0].QuoteMS = 999
	if !validOptionsArchive(&a, "TEST", a.Date) {
		t.Fatal("valid archive rejected")
	}
	a.Samples = append(a.Samples, a.Samples[0])
	if validOptionsArchive(&a, "TEST", a.Date) {
		t.Fatal("duplicate time accepted")
	}
}
