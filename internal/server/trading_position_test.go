package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTradingPositionLevelsRenderOnTickAndMinuteCharts(t *testing.T) {
	script, err := webFS.ReadFile("web/app.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range [][]byte{
		[]byte(`if (target.showTradingPosition) drawTradingPositionLevels(context`),
		[]byte(`drawTradingPositionLevels(replayContext, priceY`),
		[]byte("edge === 'above' ? '↑' : '↓'"),
		[]byte("AVG ${formatPrice(position.average_cost)}"),
		[]byte("STOP ${formatPrice(position.stop)}"),
	} {
		if !bytes.Contains(script, required) {
			t.Fatalf("app.js missing %q", required)
		}
	}
}

func TestTradingPositionBridgeReturnsOnlyChartFields(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ManagedSymbol": "TEST",
			"Position":      map[string]any{"symbol": "TEST", "quantity": -10, "average_price": "100.500000"},
			"Stop":          map[string]any{"stop_price": "102.000000"},
			"AccountMasked": "must-not-leak",
		})
	}))
	defer upstream.Close()
	t.Setenv("TAPE_POSITION_STATUS_URL", upstream.URL)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/trading-position", nil)
	request.RemoteAddr = "127.0.0.1:12345"
	(&Server{}).handleTradingPosition(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	want := `{"available":true,"average_cost":100.5,"shares":-10,"stop":102,"symbol":"TEST"}`
	if got := response.Body.String(); len(got) == 0 || got[:len(got)-1] != want {
		t.Fatalf("body=%q want=%q", got, want)
	}
}

func TestJSONNumberAcceptsNumericMoneyForCompatibility(t *testing.T) {
	var value jsonNumber
	if err := value.UnmarshalJSON([]byte(`14.005`)); err != nil || float64(value) != 14.005 {
		t.Fatalf("value=%v err=%v", value, err)
	}
}

func TestPositionBridgeIsOptionalAndLocal(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; writeJSON(w, 200, map[string]any{}) }))
	defer upstream.Close()
	t.Setenv("TRADING_TOOLS_STATUS_URL", "")
	for _, tc := range []struct {
		name, target, remote, origin string
		code                         int
	}{
		{"unset", "", "127.0.0.1:1234", "", 200},
		{"remote client", upstream.URL, "192.0.2.1:1234", "", 403},
		{"foreign origin", upstream.URL, "127.0.0.1:1234", "https://foreign.example", 403},
		{"remote upstream", "https://example.com/status", "127.0.0.1:1234", "", 200},
		{"credentialed upstream", "http://user:secret@localhost/status", "127.0.0.1:1234", "", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TAPE_POSITION_STATUS_URL", tc.target)
			r := httptest.NewRequest("GET", "/api/trading-position", nil)
			r.RemoteAddr = tc.remote
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			(&Server{}).handleTradingPosition(w, r)
			if w.Code != tc.code || calls != 0 {
				t.Fatalf("code=%d upstream calls=%d", w.Code, calls)
			}
		})
	}
}

func TestPositionBridgeDoesNotFollowRedirects(t *testing.T) {
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++ }))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer upstream.Close()
	t.Setenv("TAPE_POSITION_STATUS_URL", upstream.URL)
	r := httptest.NewRequest("GET", "/api/trading-position", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	(&Server{}).handleTradingPosition(w, r)
	if w.Code != 200 || calls != 0 || w.Body.String() != "{\"available\":false}\n" {
		t.Fatal("position redirect was not refused")
	}
}
