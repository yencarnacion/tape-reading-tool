package gexbot

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestLiveRecordingParityAndCoalescing(t *testing.T) {
	at := testTime()
	var hits atomic.Int32
	var failed atomic.Bool
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing auth")
		}
		if failed.Load() {
			http.Error(w, "must-not-expose-test-key", 403)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/orderflow") {
			fmt.Fprintf(w, `{"timestamp":%d,"ticker":"SNDK","spot":860,"agg_dex":600,"one_agg_dex":300}`, at/1000)
		} else {
			fmt.Fprintf(w, `{"timestamp":%d,"ticker":"SNDK","spot":860,"min_dte":0,"sec_min_dte":7,"sum_gex_vol":4,"strikes":[[855,-3],[860,1],[865,6]]}`, at/1000)
		}
	}))
	defer api.Close()
	s := New()
	s.Dir = t.TempDir()
	s.HistoryDir = ""
	s.Base = api.URL
	s.Key = "test-key"
	s.Enabled = true
	now := time.UnixMilli(at + 100)
	s.clock = func() time.Time { return now }
	for i := 0; i < 600; i += 2 {
		r := flow(at-600000+int64(i)*1000, float64(i))
		r.Origin = "recorded-live"
		r.AvailableMS += 100
		if e := s.Record(r); e != nil {
			t.Fatal(e)
		}
	}
	// Prime index so the append must extend it rather than repeatedly scanning.
	s.At("SNDK", at-1000)
	var wg sync.WaitGroup
	views := make([]View, 8)
	for i := range views {
		wg.Add(1)
		go func(i int) { defer wg.Done(); views[i] = s.Live(context.Background(), "SNDK", now) }(i)
	}
	wg.Wait()
	if hits.Load() != 4 {
		t.Fatalf("duplicate polling: %d", hits.Load())
	}
	v := views[0]
	if v.Status != "ready" || v.Recording != "recorded" {
		t.Fatalf("bad live status %+v", v)
	}
	if w := v.Flows[0].Windows[1]; w.Delta == nil || *w.Delta != 62 {
		t.Fatalf("receipt-aware flow: %+v", w)
	}
	replay := s.At("SNDK", now.UnixMilli())
	replay.Replay = false
	replay.Recording = v.Recording
	a, _ := json.Marshal(v)
	b, _ := json.Marshal(replay)
	if string(a) != string(b) {
		t.Fatal("replay differs from live snapshot")
	}
	if s.At("SNDK", at).Profiles[0].Status == "ready" {
		t.Fatal("snapshot visible before receipt")
	}
	failed.Store(true)
	now = now.Add(3 * time.Second)
	v = s.Live(context.Background(), "SNDK", now)
	body, _ := json.Marshal(v)
	if v.Status != "access-denied" || strings.Contains(string(body), "test-key") {
		t.Fatal("failure returned stale data or exposed credentials")
	}
	count := hits.Load()
	s.Live(context.Background(), "SNDK", now.Add(time.Second))
	if hits.Load() != count {
		t.Fatal("failure backoff missing")
	}
}

func TestNoCredentialRedirectOrOffSessionPolling(t *testing.T) {
	var hits atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer redirect.Close()
	s := New()
	s.Base = redirect.URL
	s.Enabled = true
	s.Key = "test-key"
	s.Dir = t.TempDir()
	s.HistoryDir = ""
	s.clock = func() time.Time { return time.UnixMilli(testTime()) }
	v := s.Live(context.Background(), "SNDK", s.now())
	if hits.Load() != 0 || v.Status == "ready" {
		t.Fatal("redirect followed")
	}
	if v = s.Live(context.Background(), "QQQ", s.now().Add(48*time.Hour)); v.Status != "market-closed" {
		t.Fatal("queried Sunday")
	}
}
