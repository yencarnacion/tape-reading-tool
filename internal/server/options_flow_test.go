package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func flowRequest(t *testing.T, s *Server) flowReply {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleOptionsFlow(w, httptest.NewRequest("GET", "/api/panel-data/options-flow?symbol=AAPL", nil))
	var reply flowReply
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &reply) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	return reply
}
func TestOptionsFlowLocalAdapterAndValidation(t *testing.T) {
	s := panelServer(t, "live")
	now := s.now()
	s.store.AddTrade("AAPL", now, now, 100, 100)
	bad := false
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/custom/options-flow" || r.URL.Query().Get("symbol") != "AAPL" || r.URL.Query().Get("spot") != "100.000000" || r.Header.Get("Authorization") != "Bearer local-token" {
			t.Error("unexpected adapter request")
		}
		if bad {
			fmt.Fprint(w, `{"schemaVersion":1,"symbol":"OTHER","status":"ready","api_key":"never-reflect"}`)
			return
		}
		fmt.Fprintf(w, `{"schemaVersion":1,"symbol":"AAPL","status":"connecting","asOfMS":%d,"recording":"off","api_key":"never-reflect"}`, now.UnixMilli())
	}))
	defer gateway.Close()
	s.options.base = gateway.URL + "/custom"
	s.options.token = "local-token"
	r := flowRequest(t, s)
	if r.Status != "connecting" || r.Generation != s.store.Generation("AAPL") {
		t.Fatal(r)
	}
	bad = true
	if r := flowRequest(t, s); r.Status != "invalid-data" {
		t.Fatal(r)
	}
}
func TestOptionsFlowUnavailableNeverCallsNetwork(t *testing.T) {
	for _, mode := range []string{"replay", "render", "demo", "live", "massive"} {
		t.Run(mode, func(t *testing.T) {
			s := panelServer(t, mode)
			calls := 0
			g := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
			defer g.Close()
			s.options.base = g.URL
			r := flowRequest(t, s)
			if r.Status == "ready" || calls != 0 {
				t.Fatal(r, calls)
			}
		})
	}
	s := panelServer(t, "live")
	s.options.base = "https://example.com"
	if r := flowRequest(t, s); r.Status != "not-configured" {
		t.Fatal(r)
	}
}
func TestOptionsFlowBoundariesAndNoUpstreamErrors(t *testing.T) {
	s := panelServer(t, "live")
	now := s.now()
	s.store.AddTrade("AAPL", now, now, 100, 100)
	g := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "provider-secret", 403) }))
	defer g.Close()
	s.options.base = g.URL
	r := flowRequest(t, s)
	if r.Status != "gateway-offline" {
		t.Fatal(r)
	}
	for _, target := range []string{"?symbol=OTHER", "?symbol=AAPL&symbol=AAPL", "?symbol=AAPL&url=bad", "?symbol=AAPL&spot=100"} {
		w := httptest.NewRecorder()
		s.handleOptionsFlow(w, httptest.NewRequest("GET", "/api/panel-data/options-flow"+target, nil))
		if w.Code != 400 {
			t.Fatal(target, w.Code)
		}
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/panel-data/options-flow?symbol=AAPL", nil)
	req.Header.Set("Origin", "https://evil.example")
	s.handleOptionsFlow(w, req)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	b, _ := json.Marshal(r)
	if strings.Contains(string(b), "provider-secret") {
		t.Fatal(string(b))
	}
}
func TestOptionsFlowRejectsFalseConfidence(t *testing.T) {
	r := flowReply{SchemaVersion: 1, Symbol: "AAPL", Status: "ready", AsOfMS: 100000, StartedMS: 1, LastTradeMS: 99000, LastQuoteMS: 99000, Contracts: 2, Recording: "off"}
	for _, sec := range []int{15, 60, 300} {
		r.Windows = append(r.Windows, flowWindow{Seconds: sec, ObservedSeconds: sec, CallAsk: 20000, Bull: 20000, Net: 20000, Coverage: 1, Prints: 10, ClassifiedPrints: 10, Ready: true})
	}
	r.Previous15 = r.Windows[0]
	if !validFlowReply(r, "AAPL", 100000) {
		t.Fatal("valid fixture rejected")
	}
	r.Windows[0].ClassifiedPrints = 1
	if validFlowReply(r, "AAPL", 100000) {
		t.Fatal("thin sample accepted")
	}
	r.Windows[0].ClassifiedPrints = 10
	r.Windows[0].Unknown = 100000
	if validFlowReply(r, "AAPL", 100000) {
		t.Fatal("false coverage accepted")
	}
}
