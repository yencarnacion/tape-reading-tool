package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const optionsGatewayPath = "/custom/options-api"

func optionsContractJSON(expiry string, stamp int64) string {
	return fmt.Sprintf(`{"details":{"ticker":"O:AAPLTEST","expiration_date":%q,"contract_type":"call","strike_price":100,"shares_per_contract":100},"implied_volatility":0.6,"greeks":{"delta":0.5},"last_quote":{"bid":2,"ask":2.1,"last_updated":%d,"timeframe":"REAL-TIME"},"day":{"volume":100},"open_interest":500}`, expiry, stamp)
}
func requestOptions(t *testing.T, s *Server) optionsReply {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleOptions(w, httptest.NewRequest("GET", "/api/panel-data/options?symbol=AAPL", nil))
	var reply optionsReply
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &reply) != nil {
		t.Fatalf("bad response %d %s", w.Code, w.Body.String())
	}
	return reply
}
func TestOptionsUsesOnlyLocalGatewayAndCoalesces(t *testing.T) {
	s := panelServer(t, "live")
	now := s.now()
	s.store.AddTrade("AAPL", now, now, 100, 100)
	var calls atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != optionsGatewayPath+"/rest/v3/snapshot/options/AAPL" || r.Header.Get("Authorization") != "Bearer local-token" || (r.URL.Query().Get("cursor") == "" && (r.URL.Query().Get("limit") != "250" || r.URL.Query().Get("strike_price.gte") != "90.0000")) || r.URL.Query().Has("apiKey") {
			t.Error("not a bounded gateway request")
		}
		if r.URL.Query().Get("cursor") == "next" {
			fmt.Fprintf(w, `{"status":"OK","results":[%s]}`, optionsContractJSON("2026-08-21", now.UnixNano()))
			return
		}
		fmt.Fprintf(w, `{"status":"OK","results":[%s],"next_url":%q}`, optionsContractJSON("2026-08-14", now.UnixNano()), optionsGatewayPath+"/rest/v3/snapshot/options/AAPL?cursor=next")
	}))
	defer gateway.Close()
	s.options.base = gateway.URL + optionsGatewayPath
	s.options.token = "local-token"
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			reply := requestOptions(t, s)
			if reply.Status != "ready" || len(reply.Contracts) != 2 || reply.Contracts[0].QuoteMS != now.UnixMilli() || reply.Source != "Local options gateway" {
				t.Errorf("bad normalized response %+v", reply)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 2 {
		t.Fatalf("wanted exactly one shared two-page fetch, got %d", calls.Load())
	}
}
func TestOptionsNoNetworkForReplayDemoClosedOrStaleTape(t *testing.T) {
	for _, mode := range []string{"replay", "render", "demo", "live", "massive"} {
		s := panelServer(t, mode)
		var calls atomic.Int32
		gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
		s.options.base = gateway.URL + optionsGatewayPath
		reply := requestOptions(t, s)
		wanted := "live-only"
		if mode == "replay" || mode == "render" {
			wanted = "replay-unavailable"
		}
		if mode == "live" || mode == "massive" {
			wanted = "waiting-tape"
		}
		if reply.Status != wanted || calls.Load() != 0 {
			t.Fatalf("%s: %+v calls=%d", mode, reply, calls.Load())
		}
		gateway.Close()
	}
	s := panelServer(t, "live")
	s.options.base = "http://127.0.0.1:18080/options"
	now := s.now()
	s.store.AddTrade("AAPL", now.Add(-time.Minute), now, 100, 10)
	if r := requestOptions(t, s); r.Status != "waiting-tape" {
		t.Fatal(r)
	}
	s.now = func() time.Time { return now.AddDate(0, 0, 1) } // Saturday
	if r := requestOptions(t, s); r.Status != "market-closed" {
		t.Fatal(r)
	}
}
func TestOptionsRejectsForeignPaginationAndRedirects(t *testing.T) {
	for _, target := range []string{"https://api.massive.com/v3/snapshot/options/AAPL?apiKey=secret", "//evil.example/api", "/api/marketdata/v1/rest/v3/trades/AAPL", optionsGatewayPath + "/rest/v3/snapshot/options/AAPL?apiKey=secret"} {
		s := panelServer(t, "live")
		now := s.now()
		s.store.AddTrade("AAPL", now, now, 100, 100)
		gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"status":"OK","results":[],"next_url":%q}`, target)
		}))
		s.options.base = gateway.URL + optionsGatewayPath
		if reply := requestOptions(t, s); reply.Status != "invalid-data" {
			t.Fatalf("accepted %s: %+v", target, reply)
		}
		gateway.Close()
	}
	s := panelServer(t, "live")
	now := s.now()
	s.store.AddTrade("AAPL", now, now, 100, 100)
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://api.massive.com", 302) }))
	defer gateway.Close()
	s.options.base = gateway.URL + optionsGatewayPath
	if reply := requestOptions(t, s); reply.Status != "gateway-unavailable" {
		t.Fatal(reply)
	}
}
func TestOptionsBoundedPaginationAndAuthorizationFailures(t *testing.T) {
	for _, status := range []int{403, 429, 400, 503} {
		s := panelServer(t, "live")
		now := s.now()
		s.store.AddTrade("AAPL", now, now, 100, 100)
		gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			fmt.Fprint(w, "secret-provider-error")
		}))
		s.options.base = gateway.URL + optionsGatewayPath
		reply := requestOptions(t, s)
		b, _ := json.Marshal(reply)
		if reply.Status == "ready" || strings.Contains(string(b), "secret-provider-error") {
			t.Fatal(reply)
		}
		gateway.Close()
	}
	s := panelServer(t, "live")
	now := s.now()
	s.store.AddTrade("AAPL", now, now, 100, 100)
	calls := 0
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		fmt.Fprintf(w, `{"status":"OK","results":[%s],"next_url":%q}`, optionsContractJSON("2026-07-31", now.UnixNano()), optionsGatewayPath+"/rest/v3/snapshot/options/AAPL?cursor=repeat")
	}))
	defer gateway.Close()
	s.options.base = gateway.URL + optionsGatewayPath
	if reply := requestOptions(t, s); reply.Status != "chain-too-large" || len(reply.Contracts) > 0 || calls != 8 {
		t.Fatalf("partial chain escaped: %+v calls=%d", reply, calls)
	}
}
func TestOptionsMonthlyAndCompletedExpiryBoundaries(t *testing.T) {
	s := panelServer(t, "live")
	now := s.now()
	s.store.AddTrade("AAPL", now, now, 100, 100)
	calls := 0
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Query().Get("expiration_date.lte") != now.AddDate(0, 0, 45).Format("2006-01-02") {
			t.Error("monthly expiries excluded")
		}
		fmt.Fprintf(w, `{"status":"OK","results":[%s,%s,%s],"next_url":%q}`, optionsContractJSON("2026-08-14", now.UnixNano()), optionsContractJSON("2026-08-21", now.UnixNano()), optionsContractJSON("2026-08-28", now.UnixNano()), optionsGatewayPath+"/rest/v3/snapshot/options/AAPL?cursor=more")
	}))
	defer gateway.Close()
	s.options.base = gateway.URL + optionsGatewayPath
	if reply := requestOptions(t, s); reply.Status != "ready" || len(reply.Contracts) != 2 || calls != 1 {
		t.Fatalf("expiry boundary: %+v", reply)
	}
}
func TestOptionsConfigurationAndRequestBoundaries(t *testing.T) {
	for _, raw := range []string{"https://api.massive.com", "http://127.0.0.1:8080?apiKey=secret", "http://user:secret@localhost:8080", "ftp://localhost"} {
		if _, ok := optionsLocalURL(raw); ok {
			t.Fatalf("accepted external/keyed config %s", raw)
		}
	}
	s := panelServer(t, "live")
	for _, query := range []string{"symbol=OTHER", "symbol=AAPL&url=https://api.massive.com", "symbol=AAPL&symbol=AAPL"} {
		w := httptest.NewRecorder()
		s.handleOptions(w, httptest.NewRequest("GET", "/api/panel-data/options?"+query, nil))
		if w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	r := httptest.NewRequest("GET", "http://localhost/api/panel-data/options?symbol=AAPL", nil)
	r.Header.Set("Origin", "http://localhost.evil.example")
	w := httptest.NewRecorder()
	s.handleOptions(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	// A canceled waiter cannot cancel another browser's shared request.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	service := newOptionsService()
	service.base = "invalid"
	_ = service.get(ctx, optionsReply{Symbol: "AAPL"}, s.now())
}

func TestOptionsDelayedResponseNeverBecomesLive(t *testing.T) {
	s := panelServer(t, "live")
	now := s.now()
	s.store.AddTrade("AAPL", now, now, 100, 100)
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"status":"DELAYED","results":[%s]}`, optionsContractJSON("2026-07-31", now.UnixNano()))
	}))
	defer gateway.Close()
	s.options.base = gateway.URL + optionsGatewayPath
	if reply := requestOptions(t, s); reply.Status != "delayed" || len(reply.Contracts) != 0 {
		t.Fatalf("delayed data accepted: %+v", reply)
	}
}

func TestOptionsCanceledWaiterDoesNotCancelSharedFetch(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		fmt.Fprint(w, `{"status":"OK","results":[]}`)
	}))
	defer gateway.Close()
	service := newOptionsService()
	service.base = gateway.URL + optionsGatewayPath
	seed := optionsReply{SchemaVersion: 1, Symbol: "AAPL", Spot: 100}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan optionsReply, 1)
	go func() { first <- service.get(ctx, seed, time.Now()) }()
	<-started
	cancel()
	if result := <-first; result.Status != "unavailable" {
		t.Fatal(result)
	}
	second := make(chan optionsReply, 1)
	go func() { second <- service.get(context.Background(), seed, time.Now()) }()
	close(release)
	if result := <-second; result.Status != "no-options" {
		t.Fatalf("second waiter lost shared fetch: %+v", result)
	}
}

func TestOptionsUnconfiguredNeverContactsAService(t *testing.T) {
	t.Setenv("TAPE_OPTIONS_GATEWAY_URL", "")
	t.Setenv("TAPE_OPTIONS_GATEWAY_TOKEN", "")
	service := newOptionsService()
	service.client = &http.Client{Transport: rejectOptionsNetwork{t}}
	got := service.get(context.Background(), optionsReply{Symbol: "TEST"}, time.Now())
	if got.Status != "not-configured" || service.token != "" {
		t.Fatalf("unexpected unconfigured state: %+v", got)
	}
	if got := requestOptions(t, panelServer(t, "live")); got.Status != "not-configured" {
		t.Fatal("unconfigured API should explain that options are optional")
	}
}

type rejectOptionsNetwork struct{ t *testing.T }

func (r rejectOptionsNetwork) RoundTrip(*http.Request) (*http.Response, error) {
	r.t.Error("unconfigured options attempted network access")
	return nil, fmt.Errorf("network forbidden")
}

func TestOptionsGenericEnvironmentConfig(t *testing.T) {
	t.Setenv("TAPE_OPTIONS_GATEWAY_URL", "http://127.0.0.1:18080/custom/")
	t.Setenv("TAPE_OPTIONS_GATEWAY_TOKEN", "local-only-token")
	s := newOptionsService()
	if s.base != "http://127.0.0.1:18080/custom" || s.token != "local-only-token" {
		t.Fatal("generic gateway configuration not applied")
	}
}
