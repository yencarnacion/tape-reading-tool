package feed

import (
	"encoding/json"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/marketgateway"
	"tape-reading-tool/internal/tape"
	"testing"
	"time"
)

func TestGatewayTradeConditionsReachTape(t *testing.T) {
	store := tape.NewStore("PCVX", 100, 1)
	f := NewGateway(config.MassiveConfig{}, store, nil)
	now := time.Now().UnixMilli()
	for _, test := range []struct {
		raw   string
		flags uint8
	}{{`{"p":75,"s":100}`, 31}, {`{"p":5,"s":1,"c":[37]}`, 28}, {`{"p":99,"s":200,"c":[10,2,41]}`, 12}, {`{"p":74,"s":100,"c":[32]}`, 14}, {`{"p":1,"s":100,"c":[999]}`, 8}} {
		f.event("PCVX", marketgateway.Event{Symbol: "PCVX", Channel: "T", EventMS: now, Data: json.RawMessage(test.raw)})
		tr := store.Snapshot("PCVX", 1).Trades[0]
		if tr.Flags != test.flags {
			t.Fatalf("%s: %+v", test.raw, tr)
		}
	}
}

func TestMassivePremarketCandles(t *testing.T) {
	store := tape.NewStore("AAOI", 100, 1)
	f := NewGateway(config.MassiveConfig{}, store, nil)
	directStore := tape.NewStore("AAOI", 100, 1)
	direct := NewMassive(config.MassiveConfig{}, directStore, nil)
	for _, tt := range []struct {
		at, conditions string
		want           uint8
	}{
		{"2026-10-08T09:18:00-04:00", "12", 31},
		{"2026-10-08T09:19:00-04:00", "14,12,41", 31},
		{"2026-10-08T09:19:01-04:00", "12,37", 28},
		{"2026-10-08T09:19:02-04:00", "2,12", 12},
		{"2026-10-08T09:19:03-04:00", "13", 12},
		{"2026-10-08T09:30:00-04:00", "12", 28},
		{"2026-10-08T09:30:01-04:00", "0,14,41", 31},
	} {
		at, _ := time.Parse(time.RFC3339, tt.at)
		body := json.RawMessage(`{"p":117.18,"s":100,"c":[` + tt.conditions + `]}`)
		f.event("AAOI", marketgateway.Event{Symbol: "AAOI", Channel: "T", EventMS: at.UnixMilli(), Data: body})
		tr := store.Snapshot("AAOI", 1).Trades[0]
		if tr.Flags != tt.want {
			t.Errorf("%s conditions=%s: flags=%d, want %d", tt.at, tt.conditions, tr.Flags, tt.want)
		}
		var raw massiveStreamTrade
		if err := json.Unmarshal(body, &raw); err != nil {
			t.Fatal(err)
		}
		raw.Symbol, raw.Timestamp = "AAOI", at.UnixMilli()
		direct.handleSizedTrade(raw, at.Add(3*time.Hour))
		if got := directStore.Snapshot("AAOI", 1).Trades[0].Flags; got != tt.want {
			t.Errorf("direct feed %s conditions=%s: flags=%d, want %d", tt.at, tt.conditions, got, tt.want)
		}
	}
}
