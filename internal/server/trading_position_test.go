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
			"ManagedSymbol": "WDC",
			"Position":      map[string]any{"symbol": "WDC", "quantity": -118, "average_price": "460.860000"},
			"Stop":          map[string]any{"stop_price": "469.000000"},
			"AccountMasked": "must-not-leak",
		})
	}))
	defer upstream.Close()
	t.Setenv("TRADING_TOOLS_STATUS_URL", upstream.URL)
	response := httptest.NewRecorder()
	(&Server{}).handleTradingPosition(response, httptest.NewRequest(http.MethodGet, "/api/trading-position", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	want := `{"available":true,"average_cost":460.86,"shares":-118,"stop":469,"symbol":"WDC"}`
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
