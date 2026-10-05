package server

import (
	"context"
	"net/http/httptest"
	"tape-reading-tool/internal/storage"
	"testing"
	"time"
)

func TestADRDoesNotWaitForOtherSymbolHistory(t *testing.T) {
	s := panelServer(t, "live")
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	defer func() { close(release); <-finished }()
	s.dailyBars = func(ctx context.Context, symbol string, before time.Time, limit int) ([]storage.MinuteBar, error) {
		if symbol == "PCVX" {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return []storage.MinuteBar{{TimeUS: before.AddDate(0, 0, -1).UnixMicro(), Open: 40, High: 42, Low: 39, Close: 41}}, nil
	}
	go func() {
		defer close(finished)
		s.handlePanelDailyBars(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/panel-data/daily-bars?symbol=PCVX&before=2026-07-24&limit=90", nil))
	}()
	<-started
	done := make(chan int, 1)
	go func() {
		w := httptest.NewRecorder()
		s.handlePanelDailyBars(w, httptest.NewRequest("GET", "/api/panel-data/daily-bars?symbol=U&before=2026-07-24&limit=20", nil))
		done <- w.Code
	}()
	select {
	case code := <-done:
		if code != 200 {
			t.Fatal(code)
		}
	case <-time.After(time.Second):
		t.Fatal("ADR queued behind previous ticker")
	}
}

func TestADRHistoryCountsOnlyDistinctValidCompletedSessions(t *testing.T) {
	loc, _ := time.LoadLocation("America/New_York")
	before := time.Date(2026, 10, 5, 0, 0, 0, 0, loc)
	valid := storage.MinuteBar{TimeUS: before.AddDate(0, 0, -3).UnixMicro(), Open: 75, High: 77, Low: 74, Close: 76}
	invalid := valid
	invalid.TimeUS = before.AddDate(0, 0, -4).UnixMicro()
	invalid.Close = 90
	current := valid
	current.TimeUS = before.UnixMicro()
	bars := convertDailyBars([]storage.MinuteBar{valid, valid, invalid, current}, before, loc)
	if len(bars) != 1 || bars[0].SessionDateET != "2026-10-02" {
		t.Fatalf("invalid ADR sample counted complete: %+v", bars)
	}
}
