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

func TestMassiveSessionStartedBeforeOpenEstablishesCompleteness(t *testing.T) {
	server := panelServer(t, "massive")
	database := openPanelDatabase(t)
	server.AttachRecorder(database)
	location, _ := time.LoadLocation("America/New_York")
	start := time.Date(2026, time.July, 24, 9, 30, 0, 0, location).UnixMicro()
	through := time.Date(2026, time.July, 24, 10, 0, 0, 0, location).UnixMicro()
	server.noteSymbolActive("AAPL", start-1)
	if err := database.InsertTrades(context.Background(), []storage.TradeRecord{{
		Symbol: "AAPL", EventUS: start + 1e6, ReceivedUS: start + 1e6, MarketTimeUS: start + 1e6,
		SequenceID: 1, Price: 100, Size: 10, ChartEligible: true, Source: "live", Provider: "massive",
	}}); err != nil {
		t.Fatal(err)
	}
	_, payload := decodeRTH(t, server, "symbol=AAPL&session=2026-07-24&through_us="+formatInt64(through))
	if payload.Status != "ready" || !payload.CompleteFromRTHOpen || payload.Last != 100 {
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

// The browser extrapolates its clock between deliveries and, after a backward
// replay seek, keeps the pre-seek clock until the first batch from the new
// position arrives. Refusing those requests left the panel stranded on
// "ADR HISTORY UNAVAILABLE"; clamping answers for the authoritative instant.
func TestPanelRTHContextClampsAheadOfAuthoritativeClock(t *testing.T) {
	server := panelServer(t, "demo")
	location, _ := time.LoadLocation("America/New_York")
	server.now = func() time.Time { return time.Date(2026, time.July, 24, 10, 0, 0, 0, location) }
	authoritative := time.Date(2026, time.July, 24, 10, 0, 0, 0, location).UnixMicro()
	code, payload := decodeRTH(t, server, "symbol=AAPL&session=2026-07-24&through_us="+formatInt64(authoritative+90*int64(time.Second/time.Microsecond)))
	if code != http.StatusOK || payload.ThroughUS != authoritative || payload.Status != "ready" {
		t.Fatalf("code=%d payload=%+v", code, payload)
	}
	if code, _ := decodeRTH(t, server, "symbol=AAPL&session=2026-07-24&through_us=-1"); code != http.StatusBadRequest {
		t.Fatal("a non-positive through_us must still be rejected")
	}
	if code, _ := decodeRTH(t, server, "symbol=AAPL&session=2026-07-24&through_us=nonsense"); code != http.StatusBadRequest {
		t.Fatal("an unparseable through_us must still be rejected")
	}
}

// A clamped request may never reach past the authoritative instant: the seed for
// an earlier replay position must not see the later session low.
func TestPanelRTHContextClampDoesNotGrantLookAhead(t *testing.T) {
	server := panelServer(t, "massive")
	database := openPanelDatabase(t)
	server.AttachRecorder(database)
	location, _ := time.LoadLocation("America/New_York")
	start := time.Date(2026, time.July, 24, 9, 30, 0, 0, location).UnixMicro()
	position := time.Date(2026, time.July, 24, 9, 40, 0, 0, location)
	server.now = func() time.Time { return position }
	records := []storage.TradeRecord{
		{Symbol: "AAPL", EventUS: start + 1e6, MarketTimeUS: start + 1e6, SequenceID: 1, Price: 100, Size: 10, ChartEligible: true, Source: "live", Provider: "massive"},
		{Symbol: "AAPL", EventUS: start + 1800e6, MarketTimeUS: start + 1800e6, SequenceID: 2, Price: 60, Size: 10, ChartEligible: true, Source: "live", Provider: "massive"},
	}
	if err := database.InsertTrades(context.Background(), records); err != nil {
		t.Fatal(err)
	}
	if err := database.MarkCoverage(context.Background(), storage.Coverage{Symbol: "AAPL", Provider: "massive", Kind: "trades", StartUS: start, EndUS: start + 3600e6}); err != nil {
		t.Fatal(err)
	}
	_, payload := decodeRTH(t, server, "symbol=AAPL&session=2026-07-24&through_us="+formatInt64(start+3600e6))
	if payload.Status != "ready" || payload.Low != 100 || payload.ThroughUS != position.UnixMicro() {
		t.Fatalf("clamped request leaked a later low: %+v", payload)
	}
}

// A provider outage must not be remembered for the life of the process. The
// panel has to be able to recover once the provider or the local download does.
func TestPanelDailyBarsRetriesAfterUnavailableResponse(t *testing.T) {
	server := panelServer(t, "live")
	location, _ := time.LoadLocation("America/New_York")
	at := time.Date(2026, time.July, 24, 10, 0, 0, 0, location)
	server.now = func() time.Time { return at }
	calls := 0
	server.dailyBars = func(context.Context, string, time.Time, int) ([]storage.MinuteBar, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("provider down")
		}
		bars := make([]storage.MinuteBar, 0, 2)
		for index := 0; index < 2; index++ {
			day := time.Date(2026, time.July, 22+index, 0, 0, 0, 0, time.UTC)
			bars = append(bars, storage.MinuteBar{TimeUS: day.UnixMicro(), Open: 100, High: 106, Low: 100, Close: 104, Volume: 1000})
		}
		return bars, nil
	}
	query := "symbol=AAPL&before=2026-07-24&limit=2"
	if _, payload, _ := decodeDaily(t, server, query); payload.Status != "unavailable" {
		t.Fatalf("payload=%+v", payload)
	}
	if _, payload, _ := decodeDaily(t, server, query); payload.Status != "unavailable" || calls != 1 {
		t.Fatalf("an unavailable answer must be held briefly: calls=%d payload=%+v", calls, payload)
	}
	server.now = func() time.Time { return at.Add(panelDataRetryAfter + time.Second) }
	if _, payload, _ := decodeDaily(t, server, query); payload.Status != "ready" || calls != 2 {
		t.Fatalf("calls=%d payload=%+v", calls, payload)
	}
	server.now = func() time.Time { return at.Add(24 * time.Hour) }
	if _, payload, _ := decodeDaily(t, server, query); payload.Status != "ready" || calls != 2 {
		t.Fatalf("a ready answer must stay cached: calls=%d payload=%+v", calls, payload)
	}
}
