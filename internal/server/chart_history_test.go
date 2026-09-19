package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
)

func seedChartHistory(t *testing.T, s *Server, through time.Time) {
	t.Helper()
	bars := make([]storage.MinuteBar, 5002)
	for i := range bars {
		bars[i] = storage.MinuteBar{TimeUS: through.Add(time.Duration(i-5000) * time.Minute).UnixMicro(), Open: 100, High: 101, Low: 99, Close: 100}
	}
	if err := s.recorder.UpsertMinuteBars(context.Background(), "AAPL", "ibkr", bars); err != nil {
		t.Fatal(err)
	}
}

func TestChartHistoryCachedBoundedAndNoFuture(t *testing.T) {
	s := panelServer(t, "live")
	s.AttachRecorder(openPanelDatabase(t))
	through := s.now().Truncate(time.Minute)
	seedChartHistory(t, s, through)
	if err := s.recorder.MarkCoverage(context.Background(), storage.Coverage{Symbol: "AAPL", Provider: "ibkr", Kind: "minute_bars", StartUS: through.AddDate(0, 0, -7).UnixMicro(), EndUS: through.UnixMicro() - 1, RowCount: 5000}); err != nil {
		t.Fatal(err)
	}
	s.chartHistoryFetch = func(context.Context, string, string, time.Time, time.Time) error {
		t.Fatal("cached range downloaded again")
		return nil
	}
	s.rvolMinuteBars = func(context.Context, string, time.Time, int) ([]storage.MinuteBar, error) {
		t.Fatal("unexpected IBKR request")
		return nil, nil
	}
	w := httptest.NewRecorder()
	s.handleChartHistory(w, httptest.NewRequest("POST", "/api/chart-history?symbol=AAPL", nil))
	var result struct {
		Bars     []storage.MinuteBar `json:"bars"`
		Complete bool                `json:"complete"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err, w.Body.String())
	}
	if w.Code != 200 || !result.Complete || len(result.Bars) != 5000 {
		t.Fatalf("status=%d count=%d", w.Code, len(result.Bars))
	}
	if result.Bars[4999].TimeUS != through.Add(-time.Minute).UnixMicro() {
		t.Fatal("forming/future candle leaked")
	}
}

func TestChartHistoryDownloadsMissingAndReusesCoverage(t *testing.T) {
	s := panelServer(t, "live")
	s.AttachRecorder(openPanelDatabase(t))
	through := s.now().Truncate(time.Minute)
	calls := 0
	s.chartHistoryFetch = func(ctx context.Context, symbol, provider string, start, end time.Time) error {
		calls++
		if end.After(through) || end.Sub(start) > 7*24*time.Hour {
			t.Fatal("unbounded request")
		}
		seedChartHistory(t, s, through)
		return s.recorder.MarkCoverage(ctx, storage.Coverage{Symbol: symbol, Provider: provider, Kind: "minute_bars", StartUS: start.UnixMicro(), EndUS: end.UnixMicro() - 1, RowCount: 5000})
	}
	for i := 0; i < 2; i++ {
		bars, err := s.loadChartHistory(context.Background(), "AAPL", "ibkr", through)
		if err != nil || len(bars) != 5000 {
			t.Fatalf("bars=%d err=%v", len(bars), err)
		}
	}
	if calls != 1 {
		t.Fatalf("downloads=%d", calls)
	}
}

func TestChartHistoryCancellationAndSingleFlight(t *testing.T) {
	s := panelServer(t, "live")
	s.AttachRecorder(openPanelDatabase(t))
	s.rvolMinuteBars = func(context.Context, string, time.Time, int) ([]storage.MinuteBar, error) {
		return nil, fmt.Errorf("must not be called")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.loadChartHistory(ctx, "AAPL", "ibkr", s.now()); err == nil {
		t.Fatal("ignored cancellation")
	}
	s.chartHistorySlot <- struct{}{}
	w := httptest.NewRecorder()
	s.handleChartHistory(w, httptest.NewRequest("POST", "/api/chart-history?symbol=AAPL", nil))
	if w.Code != 503 {
		t.Fatalf("status=%d", w.Code)
	}
	<-s.chartHistorySlot
	w = httptest.NewRecorder()
	s.handleChartHistory(w, httptest.NewRequest("POST", "/api/chart-history?symbol=MSFT", nil))
	if w.Code != 409 {
		t.Fatalf("stale chart status=%d", w.Code)
	}
}

func TestChartHistoryReplayUsesReplayClock(t *testing.T) {
	s := panelServer(t, "replay")
	s.AttachRecorder(openPanelDatabase(t))
	ctx := context.Background()
	through := s.now().AddDate(0, 0, -2).Truncate(time.Minute)
	start := through.Add(-time.Minute).UnixMicro()
	replay := feed.NewReplay(s.recorder, s.store, "historical", "massive", 1)
	s.feed = replay
	if err := s.recorder.InsertTrades(ctx, []storage.TradeRecord{
		{Symbol: "AAPL", EventUS: start, MarketTimeUS: start, SequenceID: 1, Price: 100, Size: 1, ChartEligible: true, Source: "historical", Provider: "massive"},
		{Symbol: "AAPL", EventUS: through.Add(time.Minute).UnixMicro(), MarketTimeUS: through.Add(time.Minute).UnixMicro(), SequenceID: 2, Price: 100, Size: 1, ChartEligible: true, Source: "historical", Provider: "massive"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := replay.Cue(ctx, feed.ReplayRequest{Symbol: "AAPL", Source: "historical", Provider: "massive", EndUS: through.Add(time.Minute).UnixMicro(), Speed: 1}, start, through.UnixMicro(), false); err != nil {
		t.Fatal(err)
	}
	bars := make([]storage.MinuteBar, 5002)
	for i := range bars {
		bars[i] = storage.MinuteBar{TimeUS: through.Add(time.Duration(i-5000) * time.Minute).UnixMicro(), Open: 100, High: 100, Low: 100, Close: 100}
	}
	if err := s.recorder.UpsertMinuteBars(ctx, "AAPL", "massive", bars); err != nil {
		t.Fatal(err)
	}
	if err := s.recorder.MarkCoverage(ctx, storage.Coverage{Symbol: "AAPL", Provider: "massive", Kind: "minute_bars", StartUS: through.AddDate(0, 0, -7).UnixMicro(), EndUS: through.Add(time.Minute).UnixMicro(), RowCount: 5002}); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.handleChartHistory(w, httptest.NewRequest("POST", "/api/chart-history?symbol=AAPL", nil))
	var payload struct {
		Through int64               `json:"through_us"`
		Bars    []storage.MinuteBar `json:"bars"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err, w.Body.String())
	}
	if w.Code != 200 || payload.Through != through.UnixMicro() || len(payload.Bars) != 5000 || payload.Bars[4999].TimeUS >= through.UnixMicro() {
		t.Fatalf("status=%d through=%d bars=%d", w.Code, payload.Through, len(payload.Bars))
	}
}
