package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/tape"
)

func TestAlertContextTickerSnapshotAndManualClear(t *testing.T) {
	s := New(config.Defaults(), tape.NewStore("AAPL", 100, 4), &stubFeed{})
	now := time.Date(2026, 10, 9, 14, 10, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	cont, mr := 22, 77
	a := AlertContext{Symbol: "NVDA", Direction: 1, AsOfUS: now.Add(-time.Minute).UnixMicro(), Clock: "10:09", Continuation: &cont, Reversion: &mr, ReversionDirection: -1, Incomplete: true}
	body, _ := json.Marshal(map[string]any{"symbol": "NVDA", "alert_context": a})
	w := httptest.NewRecorder()
	s.handleTicker(w, httptest.NewRequest(http.MethodPost, "/api/ticker", strings.NewReader(string(body))))
	if w.Code != 200 || s.currentAlertContext("NVDA") == nil || *s.currentAlertContext("NVDA").Reversion != 77 {
		t.Fatalf("snapshot lost: status=%d body=%s", w.Code, w.Body.String())
	}
	if s.currentAlertContext("AAPL") != nil {
		t.Fatal("snapshot leaked to another ticker")
	}
	w = httptest.NewRecorder()
	s.handleTicker(w, httptest.NewRequest(http.MethodPost, "/api/ticker", strings.NewReader(`{"symbol":"NVDA"}`)))
	if w.Code != 200 || s.currentAlertContext("NVDA") != nil {
		t.Fatal("manual selection retained scanner context")
	}
}

func TestAlertContextRejectsWrongSymbolFutureAndBadScore(t *testing.T) {
	through := time.Now().UnixMicro()
	base := AlertContext{Symbol: "NVDA", Direction: -1, AsOfUS: through - 1, Clock: "10:09"}
	if err := validateAlertContext(&base, "NVDA", through); err != nil {
		t.Fatal(err)
	}
	for _, modify := range []func(*AlertContext){
		func(a *AlertContext) { a.Symbol = "AAPL" },
		func(a *AlertContext) { a.AsOfUS = through + 1 },
		func(a *AlertContext) { a.Direction = 0 },
		func(a *AlertContext) { n := 101; a.Continuation = &n },
		func(a *AlertContext) { a.Industry = strings.Repeat("a", 161) },
	} {
		a := base
		modify(&a)
		if validateAlertContext(&a, "NVDA", through) == nil {
			t.Fatalf("accepted invalid snapshot: %+v", a)
		}
	}
	s := New(config.Defaults(), tape.NewStore("AAPL", 100, 4), &stubFeed{})
	s.setAlertContext(&base)
	s.releaseExternal(nil, externalStateDetached)
	if s.currentAlertContext("NVDA") != nil {
		t.Fatal("detach retained alert context")
	}
}

func TestExternalReplayAlertSnapshotIsAsOfAndRejectedCueKeepsContext(t *testing.T) {
	f := newExternalFixture(t, nil)
	n := 0
	a := &AlertContext{Symbol: "AAPL", Direction: 1, AsOfUS: f.baseUS, Clock: "09:30", Continuation: &n, Reversion: &n}
	body := f.cue("AAPL", 1, 10*time.Second, false, 1)
	body["alert_context"] = a
	if w := f.control(t, body, nil, ""); w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := f.server.currentAlertContext("AAPL"); got == nil || got.Continuation == nil || *got.Continuation != 0 {
		t.Fatal("zero snapshot score was lost")
	}
	bad := *a
	bad.AsOfUS = f.baseUS + int64(time.Minute/time.Microsecond)
	body = f.cue("AAPL", 2, 20*time.Second, false, 1)
	body["alert_context"] = bad
	if w := f.control(t, body, nil, ""); w.Code != http.StatusBadRequest {
		t.Fatal("future alert was accepted", w.Code)
	}
	if f.server.currentAlertContext("AAPL") == nil {
		t.Fatal("rejected cue erased preceding context")
	}
}
