package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/tape"
)

type stubFeed struct {
	symbol string
}

func (f *stubFeed) Run(context.Context)     {}
func (f *stubFeed) SetSymbol(symbol string) { f.symbol = symbol }

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
