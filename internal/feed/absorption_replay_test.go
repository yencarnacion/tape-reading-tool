package feed

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/massive-com/client-go/v3/websocket/models"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

// Opt in with an isolated copy of a recording, never the working live database:
// TAPE_ABSORPTION_TEST_DB=/tmp/friday.db go test ./internal/feed -run TestAbsorptionFriday -v
func TestAbsorptionFriday(t *testing.T) {
	path := os.Getenv("TAPE_ABSORPTION_TEST_DB")
	if path == "" {
		t.Skip("requires isolated Friday SNDK recording")
	}
	cfg := config.Defaults()
	cfg.Storage.Path = path
	db, err := storage.Open(cfg.Storage)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	start := time.Date(2026, 11, 13, 14, 30, 0, 0, time.UTC).UnixMicro()
	end := start + int64(6.5*60*60*1e6)
	request := ReplayRequest{Symbol: "SNDK", Source: "live", Provider: "massive", StartUS: start, EndUS: end, Speed: 20}
	store := tape.NewStore("SNDK", 1000, 4)
	liveStore := tape.NewStore("SNDK", 1000, 4)
	replay := NewReplay(db, store, "live", "massive", 20)
	live := NewMassive(cfg.Massive, liveStore, nil)
	rows, err := db.Events(context.Background(), "SNDK", "live", "massive", start, end)
	if err != nil {
		t.Fatal(err)
	}
	trades, quotes, checks := 0, 0, 0
	all := map[int64]tape.AbsorptionZone{}
	samples := map[int64]tape.AbsorptionSnapshot{}
	nextCheck := start + 60e6
	lastUS := start
	firstUS := int64(0)
	for rows.Next() {
		event, err := storage.ScanEvent(rows)
		if err != nil {
			t.Fatal(err)
		}
		if firstUS == 0 {
			firstUS = event.EventUS
		}
		lastUS = event.EventUS
		replay.applyEvent(request, event)
		received := time.UnixMicro(event.ReceivedUS)
		if event.ReceivedUS <= 0 {
			received = time.UnixMicro(event.EventUS)
		}
		if event.Kind == "quote" {
			quotes++
			live.handleQuote(models.EquityQuote{Symbol: "SNDK", BidPrice: event.Bid, AskPrice: event.Ask, BidSize: int32(event.BidSize), AskSize: int32(event.AskSize)}, received)
		} else {
			trades++
			conditions := []int32{}
			for _, s := range strings.Split(event.Conditions, ",") {
				if n, e := strconv.Atoi(strings.TrimSpace(s)); e == nil {
					conditions = append(conditions, int32(n))
				}
			}
			live.handleSizedTrade(massiveStreamTrade{Symbol: "SNDK", Price: event.Price, Size: event.Size, Timestamp: event.ExchangeTimeMS, Conditions: conditions}, received)
		}
		if event.EventUS >= nextCheck {
			a, b := store.Absorption("SNDK"), liveStore.Absorption("SNDK")
			if !reflect.DeepEqual(a.Zones, b.Zones) {
				t.Fatalf("live/replay mismatch at %s: replay=%+v live=%+v", received, a.Zones, b.Zones)
			}
			for _, z := range a.Zones {
				all[z.ID] = z
				if z.DetectedUS > event.EventUS || z.HeldUS > event.EventUS || z.BrokenUS > event.EventUS {
					t.Fatal("future zone state")
				}
			}
			if checks%45 == 0 {
				samples[event.EventUS] = a
			}
			checks++
			nextCheck = event.EventUS + 60e6
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	for _, z := range store.Absorption("SNDK").Zones {
		all[z.ID] = z
	}
	if trades < 100000 || quotes < 100000 || len(all) < 1 {
		t.Fatalf("insufficient validation: %d trades %d quotes %d zones", trades, quotes, len(all))
	}
	// Random access cue reconstruction must recover the same recent zones. Compare
	// the visible 15-minute set; the additional rewind retention is intentionally bounded.
	cueChecks := 0
	for at, expected := range samples {
		cued := tape.NewStore("SNDK", 1000, 4)
		r := NewReplay(db, cued, "live", "massive", 1)
		_, err := r.Cue(context.Background(), request, at-60e6, at, false)
		if err != nil {
			t.Fatal(err)
		}
		filter := func(s tape.AbsorptionSnapshot) []tape.AbsorptionZone {
			v := []tape.AbsorptionZone{}
			for _, z := range s.Zones {
				if z.ExpiresUS > at {
					v = append(v, z)
				}
			}
			return v
		}
		// Internal hold timers are not wire state. Compare serialized public state.
		a, _ := json.Marshal(filter(expected))
		b, _ := json.Marshal(filter(cued.Absorption("SNDK")))
		if string(a) != string(b) {
			t.Fatalf("cue differs at %d\n%s\n%s", at, a, b)
		}
		cueChecks++
	}
	zones := []tape.AbsorptionZone{}
	buy, sell, held, broken := 0, 0, 0, 0
	for _, z := range all {
		zones = append(zones, z)
		if z.Side == "buy" {
			buy++
		} else {
			sell++
		}
		if z.HeldUS > 0 {
			held++
		}
		if z.BrokenUS > 0 {
			broken++
		}
	}
	sort.Slice(zones, func(i, j int) bool { return zones[i].DetectedUS < zones[j].DetectedUS })
	report := map[string]any{"date": "2026-11-13", "symbol": "SNDK", "source": "recorded live Massive", "first_event_us": firstUS, "last_event_us": lastUS, "trades": trades, "quotes": quotes, "live_replay_checkpoints": checks, "cue_checkpoints": cueChecks, "buy_zones": buy, "sell_zones": sell, "held": held, "broken": broken, "zones": zones}
	if out := os.Getenv("TAPE_ABSORPTION_REPORT"); out != "" {
		data, _ := json.MarshalIndent(report, "", "  ")
		if err := os.WriteFile(out, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("Friday SNDK: %d trades, %d quotes; %d live/replay checkpoints; %d seeks; %d buy + %d sell zones (%d held, %d broken)", trades, quotes, checks, cueChecks, buy, sell, held, broken)
}
