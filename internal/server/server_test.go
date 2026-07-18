package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

type stubFeed struct {
	symbol string
}

func (f *stubFeed) Run(context.Context)     {}
func (f *stubFeed) SetSymbol(symbol string) { f.symbol = symbol }

type stubLiveBarFeed struct {
	stubFeed
	calls int
}

func (f *stubLiveBarFeed) RVOLMinuteBars(_ context.Context, _ string, end time.Time, _ int) ([]storage.MinuteBar, error) {
	f.calls++
	return []storage.MinuteBar{{TimeUS: end.Add(-time.Minute).UnixMicro(), Close: 10, Volume: 100}}, nil
}

func TestTickerHandlerActivatesSymbol(t *testing.T) {
	store := tape.NewStore("AAPL", 100, 4)
	source := &stubFeed{}
	server := New(config.Defaults(), store, source)
	request := httptest.NewRequest(http.MethodPost, "/api/ticker", bytes.NewBufferString(`{"symbol":"nvda"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	server.handleTicker(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if store.Active() != "NVDA" || source.symbol != "NVDA" {
		t.Fatalf("active=%q feed=%q", store.Active(), source.symbol)
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["symbol"] != "NVDA" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestTickerHandlerRejectsInvalidSymbol(t *testing.T) {
	store := tape.NewStore("AAPL", 100, 4)
	server := New(config.Defaults(), store, &stubFeed{})
	request := httptest.NewRequest(http.MethodPost, "/api/ticker", bytes.NewBufferString(`{"symbol":"bad symbol"}`))
	response := httptest.NewRecorder()

	server.handleTicker(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", response.Code)
	}
	if store.Active() != "AAPL" {
		t.Fatalf("active symbol changed to %q", store.Active())
	}
}

func TestRVOLHistoryUsesAndCachesIBKRLiveBars(t *testing.T) {
	store := tape.NewStore("AAPL", 100, 4)
	store.SetStatus(tape.FeedStatus{Mode: "live", State: "live", Connected: true})
	source := &stubLiveBarFeed{}
	server := New(config.Defaults(), store, source)
	now := time.Date(2026, time.July, 18, 10, 31, 42, 0, time.UTC)
	server.now = func() time.Time { return now }

	for range 2 {
		request := httptest.NewRequest(http.MethodGet, "/api/rvol-history?symbol=aapl", nil)
		response := httptest.NewRecorder()
		server.handleRVOLHistory(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		var payload struct {
			Provider  string              `json:"provider"`
			ThroughUS int64               `json:"through_us"`
			Bars      []storage.MinuteBar `json:"bars"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Provider != "ibkr" || payload.ThroughUS != now.Truncate(time.Minute).UnixMicro() || len(payload.Bars) != 1 {
			t.Fatalf("payload = %+v", payload)
		}
	}
	if source.calls != 1 {
		t.Fatalf("IBKR history calls = %d, want 1", source.calls)
	}
}

func TestRVOLHistoryDoesNotUseMassiveForLiveFallback(t *testing.T) {
	store := tape.NewStore("AAPL", 100, 4)
	store.SetStatus(tape.FeedStatus{Mode: "live", State: "live", Connected: true})
	cfg := config.Defaults()
	cfg.Massive.APIKey = "must-not-be-used"
	server := New(cfg, store, &stubFeed{})
	request := httptest.NewRequest(http.MethodGet, "/api/rvol-history?symbol=AAPL", nil)
	response := httptest.NewRecorder()

	server.handleRVOLHistory(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}
