package server

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"
)

func TestGEXHistoryLookbacksAndReplayBoundary(t *testing.T) {
	s := gexTestServer(t, "replay")
	clock := s.now().Add(time.Hour)
	s.now = func() time.Time { return clock }
	seed := gexFixtureSeed(clock)
	seed.Generation = 9
	// Deliberately out of order, with a future observation already on disk.
	for _, minutes := range []int{0, -30, -1, -15, -5, 1} {
		r := gexFixtureReply(clock.Add(time.Duration(minutes) * time.Minute))
		if got := s.gex.archive.record(r); got != "recorded" {
			t.Fatal(got)
		}
	}
	other := gexFixtureReply(clock.Add(-2 * time.Minute))
	other.MaxDTE = 30
	other.ThroughExpiry = clock.AddDate(0, 0, 30).Format("2006-01-02")
	s.gex.archive.record(other)
	h := s.gex.archive.historyAt(seed, clock, clock)
	if h.Status != "ready" || len(h.Timeline) != 5 || len(h.Comparisons) != 4 {
		t.Fatalf("history: %+v", h)
	}
	for _, c := range h.Comparisons {
		if c.Status != "ready" || c.Snapshot == nil || c.Snapshot.AsOfMS != clock.Add(-time.Duration(c.Minutes)*time.Minute).UnixMilli() || c.Snapshot.Generation != 9 || !c.Snapshot.Replay || c.Snapshot.History != nil {
			t.Fatalf("comparison: %+v", c)
		}
	}
	for _, p := range h.Timeline {
		if p.AsOfMS > clock.UnixMilli() || p.Net == nil {
			t.Fatal("future/invalid point", p)
		}
	}
	before := clock.Add(-16 * time.Minute)
	h = s.gex.archive.historyAt(seed, before, before)
	if len(h.Timeline) != 1 || h.Timeline[0].AsOfMS > before.UnixMilli() {
		t.Fatal("rewind leaked future timeline", h)
	}
	for _, c := range h.Comparisons {
		if c.Snapshot != nil && c.Snapshot.AsOfMS > c.TargetMS {
			t.Fatal("future lookback", c)
		}
	}
}

func TestGEXHistoryGapsQualityAndNoZeroFill(t *testing.T) {
	for _, test := range []struct {
		name string
		lag  time.Duration
		bad  bool
		want string
	}{
		{"inclusive gap", 90 * time.Second, false, "ready"},
		{"too old", 90*time.Second + time.Millisecond, false, "gap"},
		{"bad coverage", 0, true, "unusable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := gexTestServer(t, "live")
			clock := s.now().Add(time.Hour)
			r := gexFixtureReply(clock.Add(-5*time.Minute - test.lag))
			if test.bad {
				r.Status = "poor-coverage"
			}
			s.gex.archive.record(r)
			h := s.gex.archive.historyAt(gexFixtureSeed(clock), clock, clock)
			c := h.Comparisons[1]
			if c.Status != test.want || (c.Snapshot != nil) != (test.want == "ready") {
				t.Fatalf("%+v", c)
			}
			if h.Comparisons[3].Snapshot != nil {
				t.Fatal("missing early history was filled")
			}
			if test.bad && h.Timeline[0].Net != nil {
				t.Fatal("bad coverage became a net trend point")
			}
		})
	}
}

func TestGEXHistoryRouteReadOnlyAndAfterHours(t *testing.T) {
	s := gexTestServer(t, "live")
	recorded := s.now()
	clock := recorded.Add(7 * time.Hour)
	s.now = func() time.Time { return clock }
	r := gexFixtureReply(recorded)
	s.gex.archive.record(r)
	before := s.store.Generation("AAPL")
	request := func(query string) (int, gexReply) {
		w := httptest.NewRecorder()
		s.handleGEXHistory(w, httptest.NewRequest("GET", "/api/panel-data/gex/history?"+query, nil))
		var result gexReply
		_ = json.Unmarshal(w.Body.Bytes(), &result)
		return w.Code, result
	}
	code, result := request("symbol=AAPL&dte=120")
	if code != 200 || result.Status != "ready" || !result.Replay || result.AsOfMS != recorded.UnixMilli() || len(result.History.Timeline) != 1 {
		t.Fatalf("after-hours review: %d %+v", code, result)
	}
	if s.store.Generation("AAPL") != before || !s.now().Equal(clock) || len(s.gex.cache) != 0 {
		t.Fatal("review changed state or fetched a chain")
	}
	for _, q := range []string{"symbol=MSFT", "symbol=AAPL&dte=31", "symbol=AAPL&at=nope", "symbol=AAPL&symbol=AAPL", "symbol=AAPL&unknown=1", fmt.Sprintf("symbol=AAPL&at=%d", clock.Add(time.Millisecond).UnixMilli()), fmt.Sprintf("symbol=AAPL&at=%d", clock.AddDate(0, 0, -1).UnixMilli())} {
		if code, _ := request(q); code != 400 {
			t.Fatalf("query %s: %d", q, code)
		}
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/panel-data/gex/history?symbol=AAPL", nil)
	req.Header.Set("Origin", "https://elsewhere.example")
	s.handleGEXHistory(w, req)
	if w.Code != 403 {
		t.Fatal("foreign origin allowed")
	}
	w = httptest.NewRecorder()
	s.handleGEXHistory(w, httptest.NewRequest("POST", "/api/panel-data/gex/history?symbol=AAPL", nil))
	if w.Code != 405 {
		t.Fatal("POST allowed")
	}
	// The selected date comes from the current timeline, never the last file.
	clock = clock.AddDate(0, 0, 1)
	_, result = request("symbol=AAPL")
	if result.AsOfMS != 0 || len(result.History.Timeline) != 0 {
		t.Fatal("borrowed another session's records")
	}
}
