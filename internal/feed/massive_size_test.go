package feed

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

func TestMassiveDecimalSizeDecoding(t *testing.T) {
	for _, tc := range []struct {
		name, fields string
		want         float64
		invalid      bool
	}{
		{"sub-share", `"s":0,"ds":"0.013374"`, .013374, false},
		{"minimum precision", `"s":0,"ds":"0.000001"`, .000001, false},
		{"whole plus fraction", `"s":125,"ds":"125.013374"`, 125.013374, false},
		{"legacy whole", `"s":100`, 100, false},
		{"legacy zero", `"s":0`, 0, false},
		{"null fallback", `"s":25,"ds":null`, 25, false},
		{"empty", `"s":25,"ds":""`, 0, true},
		{"malformed", `"s":25,"ds":"garbage"`, 0, true},
		{"NaN", `"s":25,"ds":"NaN"`, 0, true},
		{"infinite", `"s":25,"ds":"+Inf"`, 0, true},
		{"overflow", `"s":25,"ds":"1e999"`, 0, true},
		{"negative", `"s":25,"ds":"-0.25"`, 0, true},
		{"negative legacy", `"s":-1`, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var live massiveStreamTrade
			err := json.Unmarshal([]byte(`{"sym":"QQQ","p":747.6944,`+tc.fields+`}`), &live)
			if (err != nil) != tc.invalid || (!tc.invalid && (live.Size != tc.want || live.Price != 747.6944)) {
				t.Fatalf("live = %+v, err %v", live, err)
			}
			var history massiveTrade
			fields := strings.ReplaceAll(strings.ReplaceAll(tc.fields, `"s":`, `"size":`), `"ds":`, `"decimal_size":`)
			err = json.Unmarshal([]byte(`{"price":747.6944,`+fields+`}`), &history)
			if (err != nil) != tc.invalid || (!tc.invalid && (history.Size != tc.want || history.Price != 747.6944)) {
				t.Fatalf("history = %+v, err %v", history, err)
			}
		})
	}
}

func TestGatewayFractionalStreamRecordsAndReplays(t *testing.T) {
	at := time.Now().Add(-time.Second).UnixMilli()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/stream") {
			fmt.Fprint(w, `{"ticker":{}}`)
			return
		}
		if r.URL.Query().Get("channels") != "T,Q" {
			t.Errorf("unexpected channels: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: hello\ndata: {\"api_version\":1,\"source\":\"massive\",\"feed\":\"realtime\"}\n\n")
		for _, body := range []string{`{"p":747.6944,"s":0,"ds":"0.013374","c":[12,37]}`, `{"p":747.7,"s":1,"ds":"1.25"}`, `{"p":747.71,"s":25}`, `{"p":747.72,"s":0}`, `{"p":747.73,"s":25,"ds":"NaN"}`} {
			fmt.Fprintf(w, "event: market\ndata: {\"symbol\":\"QQQ\",\"channel\":\"T\",\"event_ms\":%d,\"data\":%s}\n\n", at, body)
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "fractional.db")
	db, err := storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	store := tape.NewStore("QQQ", 100, 1)
	feed := NewGateway(config.MassiveConfig{GatewayURL: server.URL + "/adapter"}, store, db)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { feed.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(3 * time.Second)
	for len(store.Snapshot("QQQ", 10).Trades) < 4 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond * 5)
	}
	cancel()
	<-done
	trades := store.Snapshot("QQQ", 10).Trades
	sizes := make([]float64, 0, len(trades))
	for _, tr := range trades {
		sizes = append(sizes, tr.Size)
	}
	want := []float64{.013374, 1.25, 25, 0}
	if !reflect.DeepEqual(sizes, want) {
		t.Fatalf("live sizes %v, want %v", sizes, want)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	checkFractionalReplay(t, db, "live", trades[0].ReceivedUS-1, trades[len(trades)-1].ReceivedUS+1, want)
}

func TestGatewayHistoricalFractionalSizes(t *testing.T) {
	at := time.Date(2026, 10, 5, 14, 0, 0, 0, time.UTC)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/trades/") {
			fmt.Fprintf(w, `{"results":[{"price":747.6944,"size":0,"decimal_size":"0.013374","sip_timestamp":%d,"conditions":[12,37]},{"price":747.7,"size":125,"decimal_size":"125.013374","sip_timestamp":%d}]}`, at.UnixNano(), at.Add(time.Millisecond).UnixNano())
		} else {
			fmt.Fprint(w, `{"results":[]}`)
		}
	}))
	defer api.Close()
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "historical.db")
	db, err := storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	options := HistoricalOptions{Symbol: "QQQ", Start: at.Add(-time.Second), End: at.Add(time.Second)}
	if err := DownloadGatewayHistorical(context.Background(), config.MassiveConfig{GatewayURL: api.URL + "/adapter"}, db, options); err != nil {
		t.Fatal(err)
	}
	checkFractionalReplay(t, db, "historical", options.Start.UnixMicro(), options.End.UnixMicro(), []float64{.013374, 125.013374})
}

func checkFractionalReplay(t *testing.T, db *storage.Database, source string, start, end int64, want []float64) {
	t.Helper()
	rows, err := db.Events(context.Background(), "QQQ", source, "massive", start, end)
	if err != nil {
		t.Fatal(err)
	}
	sizes := []float64{}
	for rows.Next() {
		event, err := storage.ScanEvent(rows)
		if err != nil {
			t.Fatal(err)
		}
		if event.Kind == "trade" {
			sizes = append(sizes, event.Size)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sizes, want) {
		t.Fatalf("recorded %s sizes %v, want %v", source, sizes, want)
	}
	store := tape.NewStore("QQQ", 100, 1)
	replay := NewReplay(db, store, source, "massive", 1)
	request := ReplayRequest{Symbol: "QQQ", Source: source, Provider: "massive", StartUS: start, EndUS: end, Speed: 1}
	if err := replay.PrepareRender(request, start); err != nil {
		t.Fatal(err)
	}
	if _, err := replay.StepRender(end); err != nil {
		t.Fatal(err)
	}
	// Legacy zero-size records are retained on disk, but existing chart
	// eligibility omits them from replay. Positive fractions must survive.
	replayWant := []float64{}
	for _, size := range want {
		if size > 0 {
			replayWant = append(replayWant, size)
		}
	}
	sizes = nil
	for _, trade := range store.Snapshot("QQQ", 100).Trades {
		sizes = append(sizes, trade.Size)
	}
	if !reflect.DeepEqual(sizes, replayWant) {
		t.Fatalf("replayed %s sizes %v, want %v", source, sizes, replayWant)
	}
}

func TestLegacyMassiveAdapterAlsoKeepsRawFraction(t *testing.T) {
	store := tape.NewStore("QQQ", 100, 1)
	feed := NewMassive(config.MassiveConfig{}, store, nil)
	feed.handleOutput(json.RawMessage(`{"ev":"Q","sym":"QQQ","bp":747.69,"ap":747.70,"bs":80,"as":200}`))
	feed.handleOutput(json.RawMessage(`{"ev":"T","sym":"QQQ","p":747.70,"s":0,"ds":"0.013374","t":1791203513709}`))
	snapshot := store.Snapshot("QQQ", 10)
	if len(snapshot.Trades) != 1 || snapshot.Trades[0].Size != .013374 || snapshot.Quote.Bid != 747.69 {
		t.Fatalf("raw adapter: %+v", snapshot)
	}
}
