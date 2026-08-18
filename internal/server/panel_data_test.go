package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

func panelServer(t *testing.T, mode string) *Server {
	t.Helper()
	cfg := config.Defaults()
	store := tape.NewStore("AAPL", 1000, 8)
	store.SetStatus(tape.FeedStatus{Mode: mode, State: "stream", Connected: true})
	server := New(cfg, store, &stubFeed{})
	server.SetMode(mode)
	server.now = func() time.Time {
		location, _ := time.LoadLocation("America/New_York")
		return time.Date(2026, time.July, 24, 10, 0, 0, 0, location)
	}
	return server
}

func decodeDaily(t *testing.T, server *Server, rawQuery string) (int, panelDailyResponse, string) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/panel-data/daily-bars?"+rawQuery, nil)
	response := httptest.NewRecorder()
	server.handlePanelDailyBars(response, request)
	var payload panelDailyResponse
	_ = json.Unmarshal(response.Body.Bytes(), &payload)
	return response.Code, payload, response.Body.String()
}

func decodeRTH(t *testing.T, server *Server, rawQuery string) (int, panelRTHResponse) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/panel-data/rth-context?"+rawQuery, nil)
	response := httptest.NewRecorder()
	server.handlePanelRTHContext(response, request)
	var payload panelRTHResponse
	_ = json.Unmarshal(response.Body.Bytes(), &payload)
	return response.Code, payload
}

func TestPanelDailyBarsDemoIsBoundedCompletedAndBeforeSession(t *testing.T) {
	server := panelServer(t, "demo")
	code, payload, body := decodeDaily(t, server, "symbol=aapl&before=2026-07-24&limit=20")
	if code != http.StatusOK || payload.SchemaVersion != 1 || payload.Symbol != "AAPL" || payload.Status != "ready" || len(payload.Bars) != 20 {
		t.Fatalf("code=%d payload=%+v", code, payload)
	}
	for _, bar := range payload.Bars {
		if !bar.Complete || bar.SessionDateET >= "2026-07-24" || bar.High < bar.Low {
			t.Fatalf("invalid or future bar: %+v", bar)
		}
	}
	if strings.Contains(body, "api_key") || strings.Contains(body, "MASSIVE_API_KEY") {
		t.Fatalf("credentials leaked: %s", body)
	}
}

func TestPanelDailyBarsValidation(t *testing.T) {
	server := panelServer(t, "demo")
	for _, query := range []string{"symbol=bad!&before=2026-07-24&limit=20", "symbol=AAPL&before=bad&limit=20", "symbol=AAPL&before=2026-07-24&limit=0", "symbol=AAPL&before=2026-07-24&limit=91"} {
		if code, _, _ := decodeDaily(t, server, query); code != http.StatusBadRequest {
			t.Fatalf("query %q returned %d", query, code)
		}
	}
}

func TestPanelDailyBarsProviderFailureIsTruthful(t *testing.T) {
	server := panelServer(t, "live")
	server.dailyBars = func(context.Context, string, time.Time, int) ([]storage.MinuteBar, error) {
		return nil, errors.New("provider down")
	}
	code, payload, _ := decodeDaily(t, server, "symbol=AAPL&before=2026-07-24&limit=20")
	if code != http.StatusOK || payload.Status != "unavailable" || payload.CompleteSessions != 0 || !strings.Contains(payload.Message, "provider down") {
		t.Fatalf("payload=%+v", payload)
	}
}

func TestPanelRTHContextDemoStatesAndDST(t *testing.T) {
	server := panelServer(t, "demo")
	location, _ := time.LoadLocation("America/New_York")
	server.now = func() time.Time { return time.Date(2026, time.March, 9, 9, 29, 59, 0, location) }
	_, before := decodeRTH(t, server, "symbol=AAPL&session=2026-03-09")
	if before.Status != "before-open" || before.CompleteFromRTHOpen {
		t.Fatalf("before=%+v", before)
	}
	server.now = func() time.Time { return time.Date(2026, time.November, 2, 9, 30, 0, 0, location) }
	_, open := decodeRTH(t, server, "symbol=AAPL&session=2026-11-02")
	if open.Status != "ready" || !open.CompleteFromRTHOpen || open.Low != 45 {
		t.Fatalf("open=%+v", open)
	}
}

func openPanelDatabase(t *testing.T) *storage.Database {
	t.Helper()
	cfg := config.Defaults().Storage
	cfg.Path = t.TempDir() + "/panel.db"
	cfg.QueueSize = 1024
	database, err := storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func TestPanelRTHContextUsesExactEligibleTradesThroughTimestamp(t *testing.T) {
	server := panelServer(t, "massive")
	database := openPanelDatabase(t)
	server.AttachRecorder(database)
	location, _ := time.LoadLocation("America/New_York")
	start := time.Date(2026, time.July, 24, 9, 30, 0, 0, location).UnixMicro()
	through := time.Date(2026, time.July, 24, 10, 0, 0, 0, location).UnixMicro()
	records := []storage.TradeRecord{
		{Symbol: "AAPL", EventUS: start + 1e6, MarketTimeUS: start + 1e6, SequenceID: 1, Price: 100, Size: 10, ChartEligible: true, Source: "live", Provider: "massive"},
		{Symbol: "AAPL", EventUS: start + 2e6, MarketTimeUS: start + 2e6, SequenceID: 2, Price: 80, Size: 10, Unreported: true, ChartEligible: false, Source: "live", Provider: "massive"},
		{Symbol: "AAPL", EventUS: start + 3e6, MarketTimeUS: start + 3e6, SequenceID: 3, Price: 99, Size: 10, ChartEligible: true, Source: "live", Provider: "massive"},
		{Symbol: "AAPL", EventUS: through + 1e6, MarketTimeUS: through + 1e6, SequenceID: 4, Price: 70, Size: 10, ChartEligible: true, Source: "live", Provider: "massive"},
	}
	if err := database.InsertTrades(context.Background(), records); err != nil {
		t.Fatal(err)
	}
	if err := database.MarkCoverage(context.Background(), storage.Coverage{Symbol: "AAPL", Provider: "massive", Kind: "trades", StartUS: start, EndUS: through}); err != nil {
		t.Fatal(err)
	}
	code, payload := decodeRTH(t, server, "symbol=AAPL&session=2026-07-24&through_us="+formatInt64(through))
	if code != http.StatusOK || payload.Status != "ready" || !payload.CompleteFromRTHOpen || payload.Low != 99 || payload.Last != 99 {
		t.Fatalf("payload=%+v", payload)
	}
}

func TestPanelRTHContextDeclaresIncompleteCoverage(t *testing.T) {
	server := panelServer(t, "massive")
	server.AttachRecorder(openPanelDatabase(t))
	location, _ := time.LoadLocation("America/New_York")
	through := time.Date(2026, time.July, 24, 10, 0, 0, 0, location).UnixMicro()
	_, payload := decodeRTH(t, server, "symbol=AAPL&session=2026-07-24&through_us="+formatInt64(through))
	if payload.Status != "incomplete" || payload.CompleteFromRTHOpen {
		t.Fatalf("payload=%+v", payload)
	}
}

func TestPanelDailyCacheIsRaceSafeAndIsolatedByAsOfDate(t *testing.T) {
	server := panelServer(t, "demo")
	var wait sync.WaitGroup
	for index := 0; index < 20; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			code, payload, _ := decodeDaily(t, server, "symbol=AAPL&before=2026-07-24&limit=20")
			if code != 200 || payload.CompleteSessions != 20 {
				t.Errorf("payload=%+v", payload)
			}
		}()
	}
	wait.Wait()
	_, first, _ := decodeDaily(t, server, "symbol=AAPL&before=2026-07-24&limit=5")
	_, second, _ := decodeDaily(t, server, "symbol=AAPL&before=2026-07-23&limit=5")
	if first.Bars[len(first.Bars)-1].SessionDateET == second.Bars[len(second.Bars)-1].SessionDateET {
		t.Fatal("as-of dates shared a cache entry")
	}
}

func formatInt64(value int64) string { return strconv.FormatInt(value, 10) }
