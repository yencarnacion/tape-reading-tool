package feed

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/marketgateway"
	"tape-reading-tool/internal/tape"
	"testing"
	"time"
)

func TestGatewayFeedKeepsProviderClockAndQuoteOrder(t *testing.T) {
	s := tape.NewStore("TEST", 100, 2)
	f := NewGateway(config.MassiveConfig{}, s, nil)
	at := time.Now().Add(-time.Second).UnixMilli()
	ev := func(ch, raw string, stamp int64) {
		f.event("TEST", marketgateway.Event{Symbol: "TEST", Channel: ch, EventMS: stamp, Data: json.RawMessage(raw)})
	}
	ev("Q", `{"bp":99,"ap":101,"bs":40,"as":40}`, at)
	ev("Q", `{"bp":1,"ap":2}`, at-1)
	ev("T", `{"p":101,"s":20}`, at)
	v := s.Snapshot("TEST", 10)
	if v.Quote.Bid != 99 || v.Quote.BidSize != 40 || len(v.Trades) != 1 || v.Trades[0].ExchangeTimeMS != at {
		t.Fatal(v)
	}
	s.Activate("NEW")
	ev("T", `{"p":101,"s":20}`, at+1)
	if len(s.Snapshot("NEW", 10).Trades) != 0 {
		t.Fatal("wrong symbol leaked")
	}
}
func TestGatewayDailyRangesExcludeExtendedHoursAndCurrentSession(t *testing.T) {
	loc, _ := time.LoadLocation("America/New_York")
	day := time.Date(2026, 9, 18, 0, 0, 0, 0, loc)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/adapter/rest/") || r.URL.Query().Get("adjusted") != "false" {
			t.Error(r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"results": []map[string]any{{"t": day.Add(8 * time.Hour).UnixMilli(), "o": 200, "h": 300, "l": 1, "c": 200}, {"t": day.Add(10 * time.Hour).UnixMilli(), "o": 100, "h": 105, "l": 95, "c": 101}, {"t": day.Add(11 * time.Hour).UnixMilli(), "o": 101, "h": 106, "l": 98, "c": 104}, {"t": day.Add(34 * time.Hour).UnixMilli(), "c": 900}}})
	}))
	defer s.Close()
	f := NewGateway(config.MassiveConfig{GatewayURL: s.URL + "/adapter"}, tape.NewStore("TEST", 100, 1), nil)
	defer f.client.Close()
	bs, e := f.DailyBars(context.Background(), "TEST", day.Add(24*time.Hour), 20)
	if e != nil || len(bs) != 1 || bs[0].High != 106 || bs[0].Low != 95 || bs[0].Close != 104 {
		t.Fatal(bs, e)
	}
}
func TestGatewayRunResyncAndCancel(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/stream") {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: hello\ndata: {\"api_version\":1,\"source\":\"massive\",\"feed\":\"realtime\"}\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ticker":{"prevDay":{"c":90}}}`)
	}))
	defer s.Close()
	store := tape.NewStore("TEST", 100, 1)
	f := NewGateway(config.MassiveConfig{GatewayURL: s.URL + "/adapter"}, store, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.Run(ctx); close(done) }()
	deadline := time.Now().Add(3 * time.Second)
	for store.Quote("TEST").PreviousClose != 90 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond * 10)
	}
	if store.Quote("TEST").PreviousClose != 90 {
		cancel()
		t.Fatal("snapshot not loaded")
	}
	if store.Status().Provider != "massive" {
		t.Fatal(store.Status())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("did not stop")
	}
}

func TestGatewayGapClearsOldBidAskButKeepsReference(t *testing.T) {
	s := tape.NewStore("TEST", 100, 1)
	s.UpdateQuote("TEST", 99, 101, 100, 100)
	s.UpdatePreviousClose("TEST", 90)
	s.ClearTopOfBook("TEST")
	q := s.Quote("TEST")
	if q.Bid != 0 || q.Ask != 0 || q.PreviousClose != 90 {
		t.Fatal(q)
	}
}

func TestGatewaySnapshotRetryDoesNotRollBackFreshTrade(t *testing.T) {
	var calls atomic.Int32
	at := time.Now().Add(-time.Second)
	store := tape.NewStore("TEST", 100, 2)
	store.AddTradeWithRules("TEST", at.Add(time.Millisecond), at, 429.5, 20, tape.MassiveTradeFlags("12"), "12")
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "temporary outage", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ticker":{"prevDay":{"c":441.64},"lastTrade":{"p":1,"s":100,"c":[12],"t":%d}}}`, at.UnixNano())
	}))
	defer adapter.Close()
	f := NewGateway(config.MassiveConfig{GatewayURL: adapter.URL + "/adapter"}, store, nil)
	defer f.client.Close()
	f.snapshot(context.Background(), "TEST")
	if got := store.Quote("TEST"); got.LastPrice != 429.5 || got.PreviousClose != 441.64 || calls.Load() != 2 {
		t.Fatal(got, calls.Load())
	}
	store.Activate("NEW")
	f.snapshot(context.Background(), "TEST")
	if calls.Load() != 2 || store.Quote("NEW").LastPrice != 0 {
		t.Fatal("old symbol snapshot leaked")
	}
}
