package server

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tape-reading-tool/internal/tape"
)

func gexFloat(value float64) *float64 { return &value }
func gexFixtureContract(at time.Time, ticker, kind string, strike, gamma, oi float64) gexContract {
	var c gexContract
	c.Details.Ticker, c.Details.Kind, c.Details.Expiry = ticker, kind, "2026-07-31"
	c.Details.Strike, c.Details.Shares = strike, 100
	c.Greeks.Gamma, c.OI = gexFloat(gamma), gexFloat(oi)
	c.Underlying.Ticker, c.Underlying.Price, c.Underlying.Updated = "AAPL", 100, at.UnixNano()
	c.Underlying.Timeframe = "REAL-TIME"
	return c
}
func gexFixtureSeed(at time.Time) gexReply {
	return gexReply{SchemaVersion: 1, Symbol: "AAPL", Generation: 1, Model: gexModel,
		MaxDTE: 120, Spot: 100, SpotMS: at.UnixMilli(), ThroughExpiry: "2026-11-21",
		OIConvention: "previous trading day; reporting date not supplied", Strikes: []gexBucket{}, Expiries: []gexBucket{}}
}
func gexFixtureReply(at time.Time) gexReply {
	return calculateGEX(gexFixtureSeed(at), []gexContract{
		gexFixtureContract(at, "C100", "call", 100, .02, 100),
		gexFixtureContract(at, "P95", "put", 95, .01, 50),
	}, "2026-07-24", "2026-11-21", at)
}
func gexTestServer(t *testing.T, mode string) *Server {
	t.Helper()
	s := panelServer(t, mode)
	s.gex.archive.dir = t.TempDir()
	t.Cleanup(s.gex.close)
	now := s.now()
	s.store.AddTrade("AAPL", now, now, 100, 100)
	return s
}
func requestGEX(t *testing.T, s *Server) gexReply {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleGEX(w, httptest.NewRequest("GET", "/api/panel-data/gex?symbol=AAPL&dte=120", nil))
	var reply gexReply
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &reply) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	return reply
}

func TestGEXCalculationUsesDollarPerOnePercentUnits(t *testing.T) {
	at := panelServer(t, "live").now()
	r := gexFixtureReply(at)
	// .02 * 100 OI * 100 shares * $100^2 * .01 = $20,000 calls.
	// .01 * 50 OI * 100 shares * $100^2 * .01 = -$5,000 puts.
	if r.Status != "ready" || *r.Call != 20000 || *r.Put != -5000 || *r.Net != 15000 || *r.Gross != 25000 ||
		r.Coverage.Seen != 2 || r.Coverage.Included != 2 || r.Coverage.OIFraction != 1 || r.GreekTimeKnown {
		t.Fatalf("wrong formula, sign or quality: %+v", r)
	}
	if !validGEXRecord(r) || len(r.Strikes) != 2 || len(r.Expiries) != 1 || r.Strikes[0].Strike != 95 || r.Expiries[0].Net != 15000 {
		t.Fatal("breakdowns do not reconcile", r)
	}
	seed := gexFixtureSeed(at)
	seed.Spot = 200
	c := gexFixtureContract(at, "C200", "call", 200, .02, 100)
	c.Underlying.Price = 200
	doubleSpot := calculateGEX(seed, []gexContract{c}, "2026-07-24", seed.ThroughExpiry, at)
	if doubleSpot.Status != "ready" || *doubleSpot.Net != 80000 {
		t.Fatal("spot-square scaling failed", doubleSpot)
	}
}

func TestGEXQualityNeverTreatsMissingAsZero(t *testing.T) {
	at := panelServer(t, "live").now()
	base := gexFixtureContract(at, "C100", "call", 100, .02, 100)
	for _, test := range []struct {
		name, want string
		mutate     func(*gexContract)
	}{
		{"missing gamma", "insufficient", func(c *gexContract) { c.Greeks.Gamma = nil }},
		{"negative gamma", "insufficient", func(c *gexContract) { c.Greeks.Gamma = gexFloat(-.01) }},
		{"missing OI", "insufficient", func(c *gexContract) { c.OI = nil }},
		{"fractional OI", "insufficient", func(c *gexContract) { c.OI = gexFloat(1.5) }},
		{"nonstandard multiplier", "insufficient", func(c *gexContract) { c.Details.Shares = 10 }},
		{"unknown freshness", "freshness-unknown", func(c *gexContract) { c.Underlying.Updated = 0 }},
		{"old underlying", "stale", func(c *gexContract) { c.Underlying.Updated = at.Add(-91 * time.Second).UnixNano() }},
		{"future underlying", "stale", func(c *gexContract) { c.Underlying.Updated = at.Add(3 * time.Second).UnixNano() }},
		{"delayed", "delayed", func(c *gexContract) { c.Underlying.Timeframe = "DELAYED" }},
		{"price mismatch", "stale", func(c *gexContract) { c.Underlying.Price = 110 }},
		{"expiry outside scope", "invalid-data", func(c *gexContract) { c.Details.Expiry = "2027-01-01" }},
		{"invalid date", "invalid-data", func(c *gexContract) { c.Details.Expiry = "2026-07-99" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			c := base
			test.mutate(&c)
			r := calculateGEX(gexFixtureSeed(at), []gexContract{c}, "2026-07-24", "2026-11-21", at)
			if r.Status != test.want {
				t.Fatal(r.Status, test.want)
			}
		})
	}
	zero := base
	zero.OI = gexFloat(0)
	zero.Greeks.Gamma = nil
	zero.Underlying.Updated = 0
	r := calculateGEX(gexFixtureSeed(at), []gexContract{zero}, "2026-07-24", "2026-11-21", at)
	if r.Status != "ready" || *r.Net != 0 || *r.Gross != 0 || r.Coverage.MissingGamma != 0 || r.Coverage.OIFraction != 1 {
		t.Fatal("known zero OI lost", r)
	}
	missing := base
	missing.Details.Ticker = "P95"
	missing.OI = nil
	r = calculateGEX(gexFixtureSeed(at), []gexContract{base, missing}, "2026-07-24", "2026-11-21", at)
	if r.Status != "poor-coverage" || r.Coverage.MissingOI != 1 {
		t.Fatal("unknown OI hidden", r)
	}
	missing.OI = gexFloat(1000)
	missing.Greeks.Gamma = nil
	r = calculateGEX(gexFixtureSeed(at), []gexContract{base, missing}, "2026-07-24", "2026-11-21", at)
	if r.Status != "poor-coverage" || r.Coverage.MissingGamma != 1 || r.Coverage.IncludedOI != 100 || r.Coverage.KnownOI != 1100 {
		t.Fatal(r)
	}
	if gexTimestampMS(at.UnixMilli()) != at.UnixMilli() || gexTimestampMS(at.UnixMicro()) != at.UnixMilli() || gexTimestampMS(at.UnixNano()) != at.UnixMilli() {
		t.Fatal("timestamp units")
	}
}

func TestGEXFullChainPaginationCacheAndRecording(t *testing.T) {
	s := gexTestServer(t, "live")
	at := s.now()
	var calls atomic.Int32
	g := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer local-only" || r.URL.Path != "/custom/rest/v3/snapshot/options/AAPL" {
			t.Error("wrong gateway/auth", r.URL)
		}
		c := gexFixtureContract(at, "C100", "call", 100, .02, 100)
		next := "/custom/rest/v3/snapshot/options/AAPL?cursor=page2"
		if r.URL.Query().Get("cursor") != "" {
			c = gexFixtureContract(at, "P95", "put", 95, .01, 50)
			next = ""
		} else {
			q := r.URL.Query()
			if q.Get("limit") != "250" || q.Get("expiration_date.gte") != "2026-07-24" || q.Get("expiration_date.lte") != "2026-11-21" || q.Has("strike_price.gte") || q.Has("contract_type") {
				t.Error("scope is not full chain", q)
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"status": "OK", "results": []gexContract{c}, "next_url": next, "api_key": "must-not-leak"})
	}))
	defer g.Close()
	s.options.base = g.URL + "/custom"
	s.options.token = "local-only"
	r := requestGEX(t, s)
	if r.Status != "ready" || *r.Net != 15000 || r.Recording != "recorded" || calls.Load() != 2 {
		t.Fatal(r, calls.Load())
	}
	requestGEX(t, s)
	if calls.Load() != 2 {
		t.Fatal("cache fetched again")
	}
	path := filepath.Join(s.gex.archive.dir, "2026-07-24", "AAPL.jsonl")
	body, err := os.ReadFile(path)
	if err != nil || strings.Count(string(body), "\n") != 1 || strings.Contains(string(body), "must-not-leak") || strings.Contains(string(body), "local-only") {
		t.Fatal("unsafe or duplicate record", err, string(body))
	}
	var saved gexReply
	if json.Unmarshal(body[:len(body)-1], &saved) != nil || !validGEXRecord(saved) {
		t.Fatal("invalid recording")
	}
}

func TestGEXPaginationNeverPublishesPartialOrFollowsForeignURL(t *testing.T) {
	at := panelServer(t, "live").now()
	for _, scenario := range []string{"absolute", "wrong-path", "credentials", "duplicate", "loop", "cap", "delayed", "error"} {
		t.Run(scenario, func(t *testing.T) {
			var calls atomic.Int32
			g := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := calls.Add(1)
				c := gexFixtureContract(at, fmt.Sprintf("C%d", n), "call", 100, .02, 100)
				next := ""
				switch scenario {
				case "absolute":
					next = "https://example.com/rest/v3/snapshot/options/AAPL"
				case "wrong-path":
					next = "/rest/v3/snapshot/options/OTHER?cursor=x"
				case "credentials":
					next = "/rest/v3/snapshot/options/AAPL?apiKey=secret"
				case "duplicate":
					c.Details.Ticker = "same"
					if n == 1 {
						next = "/rest/v3/snapshot/options/AAPL?cursor=x"
					}
				case "loop":
					next = "/rest/v3/snapshot/options/AAPL?cursor=x"
				case "cap":
					next = fmt.Sprintf("/rest/v3/snapshot/options/AAPL?cursor=%d", n)
				case "error":
					http.Error(w, "provider-secret", 429)
					return
				}
				status := "OK"
				if scenario == "delayed" {
					status = "DELAYED"
				}
				json.NewEncoder(w).Encode(map[string]any{"status": status, "results": []gexContract{c}, "next_url": next})
			}))
			defer g.Close()
			s := gexTestServer(t, "live")
			s.options.base = g.URL
			r := requestGEX(t, s)
			if r.Complete || r.Net != nil || r.Status == "ready" {
				t.Fatal("partial usable total", r)
			}
			if calls.Load() > gexMaxPages {
				t.Fatal("unbounded pagination")
			}
			if scenario == "cap" && r.Status != "chain-too-large" {
				t.Fatal(r.Status)
			}
			if scenario == "error" && r.Status != "rate-limited" {
				t.Fatal(r.Status)
			}
			b, _ := json.Marshal(r)
			if strings.Contains(string(b), "provider-secret") || strings.Contains(string(b), "secret") {
				t.Fatal("upstream leaked")
			}
		})
	}
}

func TestGEXCacheSingleFlightAndCancelledWaiter(t *testing.T) {
	s := gexTestServer(t, "live")
	at := s.now()
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	g := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(entered)
		<-release
		json.NewEncoder(w).Encode(map[string]any{"status": "OK", "results": []gexContract{gexFixtureContract(at, "C100", "call", 100, .02, 100)}})
	}))
	defer g.Close()
	s.options.base = g.URL
	ctx, cancel := context.WithCancel(context.Background())
	one := make(chan gexReply, 1)
	go func() { one <- s.gex.get(ctx, gexFixtureSeed(at), at) }()
	<-entered
	cancel()
	if (<-one).Status != "unavailable" {
		t.Fatal("cancel not honored")
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r := s.gex.get(context.Background(), gexFixtureSeed(at), at); r.Status != "ready" {
				t.Error(r.Status)
			}
		}()
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal("no singleflight", calls.Load())
	}
}

func TestGEXEndpointGuardsAndInactiveModesNeverFetch(t *testing.T) {
	for _, mode := range []string{"replay", "render", "demo", "live"} {
		t.Run(mode, func(t *testing.T) {
			s := gexTestServer(t, mode)
			if mode == "live" {
				s.store.SetStatus(tape.FeedStatus{Mode: mode, Connected: false})
			}
			var calls atomic.Int32
			g := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
			defer g.Close()
			s.options.base = g.URL
			if r := requestGEX(t, s); r.Status == "ready" || calls.Load() != 0 {
				t.Fatal(r, calls.Load())
			}
		})
	}
	s := gexTestServer(t, "live")
	for _, q := range []string{"symbol=OTHER", "symbol=AAPL&symbol=AAPL", "symbol=AAPL&dte=7", "symbol=AAPL&dte=30&dte=120", "symbol=AAPL&spot=1", "symbol=AAPL&url=bad"} {
		w := httptest.NewRecorder()
		s.handleGEX(w, httptest.NewRequest("GET", "/api/panel-data/gex?"+q, nil))
		if w.Code != 400 {
			t.Fatal(q, w.Code)
		}
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/panel-data/gex?symbol=AAPL", nil)
	req.Header.Set("Origin", "https://evil.example")
	s.handleGEX(w, req)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	s.now = func() time.Time { return time.Date(2026, 7, 24, 16, 0, 0, 0, gexLocation()) }
	if requestGEX(t, s).Status != "market-closed" {
		t.Fatal("close not gated")
	}
}

func TestGEXSymbolChangeDuringFetchCannotRecordOrColorOldStock(t *testing.T) {
	s := gexTestServer(t, "live")
	at := s.now()
	entered, release := make(chan struct{}), make(chan struct{})
	g := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		json.NewEncoder(w).Encode(map[string]any{"status": "OK", "results": []gexContract{gexFixtureContract(at, "C100", "call", 100, .02, 100)}})
	}))
	defer g.Close()
	s.options.base = g.URL
	done := make(chan gexReply, 1)
	go func() { done <- requestGEX(t, s) }()
	<-entered
	s.store.Activate("MSFT")
	close(release)
	if r := <-done; r.Status != "context-changed" || r.Net != nil {
		t.Fatal(r)
	}
	if _, err := os.Stat(filepath.Join(s.gex.archive.dir, "2026-07-24", "AAPL.jsonl")); !os.IsNotExist(err) {
		t.Fatal("old-symbol result recorded", err)
	}
}

func TestGEXArchiveFloorNoFutureSeekScopeAndCorruptLines(t *testing.T) {
	at := panelServer(t, "live").now()
	archive := newGEXArchiveStore()
	archive.dir = t.TempDir()
	r := gexFixtureReply(at)
	if archive.record(r) != "recorded" {
		t.Fatal("record failed")
	}
	r2 := gexFixtureReply(at.Add(time.Minute))
	r2.MaxDTE = 30
	r2.ThroughExpiry = at.AddDate(0, 0, 30).In(gexLocation()).Format("2006-01-02")
	if archive.record(r2) != "recorded" {
		t.Fatal("second scope")
	}
	r3 := gexFixtureReply(at.Add(time.Minute))
	if archive.record(r3) != "recorded" {
		t.Fatal("next snapshot")
	}
	path := filepath.Join(archive.dir, "2026-07-24", "AAPL.jsonl")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString("{bad json}\n{\"partial\":")
	f.Close()
	seed := gexFixtureSeed(at)
	seed.Generation = 88
	for _, test := range []struct {
		offset time.Duration
		status string
		asOf   int64
	}{
		{-time.Millisecond, "replay-unavailable", 0}, {30 * time.Second, "ready", at.UnixMilli()}, {time.Minute, "ready", at.Add(time.Minute).UnixMilli()},
		{151 * time.Second, "replay-gap", at.Add(time.Minute).UnixMilli()}, {0, "ready", at.UnixMilli()},
	} {
		r := archive.replayAt(seed, at.Add(test.offset))
		if r.Status != test.status || r.AsOfMS != test.asOf || !r.Replay || r.Generation != 88 {
			t.Fatal(test, r)
		}
	}
	seed.MaxDTE = 30
	if archive.replayAt(seed, at.Add(30*time.Second)).Status != "replay-unavailable" {
		t.Fatal("future scope snapshot used")
	}
	if r := archive.replayAt(seed, at.Add(time.Minute)); r.Status != "ready" || r.MaxDTE != 30 {
		t.Fatal("scope lost", r)
	}
	seed.Symbol = "../AAPL"
	if archive.replayAt(seed, at).Status != "replay-unavailable" {
		t.Fatal("unsafe symbol")
	}
}

func TestGEXArchiveRejectsUnreconciledTotals(t *testing.T) {
	r := gexFixtureReply(panelServer(t, "live").now())
	for _, mutate := range []func(*gexReply){
		func(r *gexReply) { r.Net = gexFloat(2) }, func(r *gexReply) { r.Net = gexFloat(math.NaN()) },
		func(r *gexReply) { r.Coverage.IncludedOI = 900 }, func(r *gexReply) { r.Coverage.MissingGamma = -1 },
		func(r *gexReply) { r.Complete = false }, func(r *gexReply) { r.Strikes = []gexBucket{} },
		func(r *gexReply) { r.Expiries = []gexBucket{{Expiry: "2026-07-31", Net: 1, Call: 1}} },
	} {
		bad := r
		mutate(&bad)
		if validGEXRecord(bad) {
			t.Fatal("bad record accepted", bad)
		}
	}
}
