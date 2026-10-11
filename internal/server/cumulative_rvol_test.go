package server

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
)

func rvolFixture(t *testing.T, session string) (time.Time, []storage.MinuteBar, []storage.MinuteBar) {
	t.Helper()
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	open, err := time.ParseInLocation("2006-01-02 15:04", session+" 09:30", loc)
	if err != nil {
		t.Fatal(err)
	}
	var prior []storage.MinuteBar
	for day, n := open.AddDate(0, 0, -1), 1; n <= 6; day = day.AddDate(0, 0, -1) {
		if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
			continue
		}
		for minute := 0; minute < 3; minute++ {
			prior = append(prior, storage.MinuteBar{TimeUS: day.Add(time.Duration(minute) * time.Minute).UnixMicro(), Open: 10, High: 11, Low: 9, Close: 10, Volume: float64(n * 100)})
		}
		n++
	}
	today := []storage.MinuteBar{
		{TimeUS: open.UnixMicro(), Open: 10, High: 11, Low: 9, Close: 11, Volume: 600},
		{TimeUS: open.Add(time.Minute).UnixMicro(), Open: 11, High: 11, Low: 9, Close: 10, Volume: 1200},
		{TimeUS: open.Add(2 * time.Minute).UnixMicro(), Open: 10, High: 11, Low: 9, Close: 11, Volume: 999999},
	}
	return open, prior, today
}

func TestCumulativeRVOLSameClockFivePriorSessions(t *testing.T) {
	// The Nov 2 session crosses DST; Monday's first minute must compare with
	// 09:30 ET on Friday, not with Friday's 08:30/10:30 UTC-offset neighbor.
	for _, date := range []string{"2026-07-24", "2026-11-02"} {
		t.Run(date, func(t *testing.T) {
			open, prior, today := rvolFixture(t, date)
			prior = append(prior, today...)
			prior = append(prior, storage.MinuteBar{TimeUS: open.AddDate(0, 0, -3).Add(-time.Hour).UnixMicro(), Volume: 9e9})
			base := cumulativeRVOLResponse{SessionDate: date}
			got := buildCumulativeRVOL(base, prior, today, open.AddDate(0, 0, -14), open, open.Add(2*time.Minute), open.Location())
			if got.Status != "ready" || len(got.BaselineSessions) != 5 || len(got.Points) != 2 {
				t.Fatalf("%+v", got)
			}
			for i, want := range []float64{2, 3} {
				if got.Points[i].Ratio == nil || math.Abs(*got.Points[i].Ratio-want) > 1e-9 {
					t.Fatalf("minute %d: %+v", i, got.Points[i])
				}
			}
			if !got.Points[0].Up || got.Points[1].Up {
				t.Fatal("candle colors lost")
			}
		})
	}
}

func TestCumulativeRVOLGapsZeroBaselineAndInsufficient(t *testing.T) {
	open, prior, today := rvolFixture(t, "2026-07-24")
	base := cumulativeRVOLResponse{SessionDate: "2026-07-24", Status: "unavailable"}
	build := func(prior, today []storage.MinuteBar, from time.Time) cumulativeRVOLResponse {
		return buildCumulativeRVOL(base, prior, today, from, open, open.Add(3*time.Minute), open.Location())
	}
	// Complete queried coverage may have no-trade minutes: carry the cumulative
	// sum forward rather than aligning by row index or treating them as holes.
	got := build(prior, today[:1], open.AddDate(0, 0, -14))
	if got.Status != "ready" || *got.Points[2].Ratio != 600.0/900 {
		t.Fatalf("gap: %+v", got)
	}
	if got := build(prior[:12], today, open.AddDate(0, 0, -14)); got.Status != "insufficient" || len(got.Points) != 0 {
		t.Fatalf("short baseline: %+v", got)
	}
	// A queried range beginning after an earlier session's open must not count
	// that partial session as a complete day.
	if got := build(prior, today, open.AddDate(0, 0, -7).Add(time.Minute)); got.Status != "insufficient" {
		t.Fatalf("partial session counted: %+v", got)
	}
	for i := range prior {
		prior[i].Volume = 0
	}
	got = build(prior, today, open.AddDate(0, 0, -14))
	if got.Status != "insufficient" {
		t.Fatalf("zero denominator: %+v", got)
	}
	for _, point := range got.Points {
		if point.Ratio != nil {
			t.Fatal("zero denominator manufactured a ratio")
		}
	}
	prior[0].Volume = math.NaN()
	if got := build(prior, today, open.AddDate(0, 0, -14)); got.Status != "unavailable" {
		t.Fatalf("invalid volume: %+v", got)
	}
}

func TestCumulativeRVOLProviderIsolationCachingAndRefresh(t *testing.T) {
	for _, mode := range []string{"live", "massive"} {
		t.Run(mode, func(t *testing.T) {
			s := panelServer(t, mode)
			s.AttachRecorder(openPanelDatabase(t))
			open, prior, today := rvolFixture(t, "2026-07-24")
			clock := open.Add(2*time.Minute + 10*time.Second)
			s.now = func() time.Time { return clock }
			provider := "ibkr"
			if mode == "massive" {
				provider = "massive"
			}
			calls := 0
			s.chartHistoryFetch = func(ctx context.Context, symbol, selected string, start, end time.Time) error {
				calls++
				if selected != provider || end.After(clock.Truncate(time.Minute)) || end.Sub(start) > 7*24*time.Hour {
					t.Fatalf("wrong provider or range: %s %v %v", selected, start, end)
				}
				// The future/forming minute is deliberately in the cache. The range
				// reader and calculator must still exclude it.
				if err := s.recorder.UpsertMinuteBars(ctx, symbol, selected, append(prior, today...)); err != nil {
					return err
				}
				return s.recorder.MarkCoverage(ctx, storage.Coverage{Symbol: symbol, Provider: selected, Kind: "minute_bars", StartUS: start.UnixMicro(), EndUS: end.UnixMicro() - 1})
			}
			request := func() cumulativeRVOLResponse {
				w := httptest.NewRecorder()
				s.handleCumulativeRVOL(w, httptest.NewRequest("POST", "/api/cumulative-rvol?symbol=AAPL", nil))
				var got cumulativeRVOLResponse
				if w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
				if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				return got
			}
			got := request()
			if got.Status != "ready" || got.Provider != provider || *got.Points[1].Ratio != 3 {
				t.Fatalf("%+v", got)
			}
			first := calls
			request()
			if calls != first {
				t.Fatal("same-minute request bypassed cache")
			}
			clock = clock.Add(time.Minute)
			request()
			if calls != first+1 {
				t.Fatalf("prior sessions downloaded again: %d -> %d", first, calls)
			}
			clock = clock.Add(time.Minute)
			s.chartHistoryFetch = func(context.Context, string, string, time.Time, time.Time) error {
				return errors.New("https://provider?apiKey=SECRET")
			}
			got = request()
			if got.Status != "unavailable" || len(got.Points) != 0 || strings.Contains(got.Message, "SECRET") {
				t.Fatalf("stale/secret leak: %+v", got)
			}
		})
	}
}

func TestCumulativeRVOLRequestGuards(t *testing.T) {
	s := panelServer(t, "live")
	for _, test := range []struct {
		method, symbol, origin string
		code                   int
	}{
		{"GET", "AAPL", "", 405}, {"POST", "MSFT", "", 409}, {"POST", "AAPL", "https://foreign.example", 403},
	} {
		r := httptest.NewRequest(test.method, "/api/cumulative-rvol?symbol="+test.symbol, nil)
		if test.origin != "" {
			r.Header.Set("Origin", test.origin)
		}
		w := httptest.NewRecorder()
		s.handleCumulativeRVOL(w, r)
		if w.Code != test.code {
			t.Fatalf("%+v: %d", test, w.Code)
		}
	}
}

func TestCumulativeRVOLReplayClockAndCachedProvider(t *testing.T) {
	for _, provider := range []string{"ibkr", "massive"} {
		t.Run(provider, func(t *testing.T) {
			s := panelServer(t, "replay")
			s.AttachRecorder(openPanelDatabase(t))
			open, prior, today := rvolFixture(t, "2026-07-24")
			clock := open.Add(2*time.Minute + 10*time.Second)
			ctx := context.Background()
			if err := s.recorder.UpsertMinuteBars(ctx, "AAPL", provider, append(prior, today...)); err != nil {
				t.Fatal(err)
			}
			if err := s.recorder.MarkCoverage(ctx, storage.Coverage{Symbol: "AAPL", Provider: provider, Kind: "minute_bars", StartUS: open.AddDate(0, 0, -14).UnixMicro(), EndUS: open.Add(4 * time.Hour).UnixMicro()}); err != nil {
				t.Fatal(err)
			}
			if err := s.recorder.InsertTrades(ctx, []storage.TradeRecord{
				{Symbol: "AAPL", Source: "historical", Provider: provider, EventUS: open.UnixMicro(), MarketTimeUS: open.UnixMicro(), Price: 10, Size: 1, ChartEligible: true},
				{Symbol: "AAPL", Source: "historical", Provider: provider, EventUS: clock.Add(time.Minute).UnixMicro(), MarketTimeUS: clock.Add(time.Minute).UnixMicro(), Price: 10, Size: 1, ChartEligible: true},
			}); err != nil {
				t.Fatal(err)
			}
			replay := feed.NewReplay(s.recorder, s.store, "historical", provider, 1)
			s.feed = replay
			if err := replay.PrepareRender(feed.ReplayRequest{Symbol: "AAPL", Source: "historical", Provider: provider, StartUS: clock.UnixMicro(), EndUS: clock.Add(time.Minute).UnixMicro(), Speed: 1}, open.UnixMicro()); err != nil {
				t.Fatal(err)
			}
			s.now = func() time.Time { return clock.AddDate(0, 1, 0) }
			s.chartHistoryFetch = func(context.Context, string, string, time.Time, time.Time) error {
				t.Fatal("cached replay must not fetch live history")
				return nil
			}
			w := httptest.NewRecorder()
			s.handleCumulativeRVOL(w, httptest.NewRequest("POST", "/api/cumulative-rvol?symbol=AAPL", nil))
			var got cumulativeRVOLResponse
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err, w.Body.String())
			}
			if w.Code != 200 || got.Status != "ready" || got.ThroughUS != clock.Truncate(time.Minute).UnixMicro() || got.Provider != provider || len(got.Points) != 2 || *got.Points[1].Ratio != 3 {
				t.Fatalf("%+v", got)
			}
		})
	}
}
