package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestOptionsSubscriptionRequiresExplicitOptIn(t *testing.T) {
	t.Setenv("MARKET_DATA_GATEWAY_URL", "http://127.0.0.1:8080/api/marketdata/v1")
	t.Setenv("TAPE_OPTIONS_GATEWAY_URL", "")
	for _, test := range []struct {
		shared, tape string
		enabled      bool
	}{
		{"", "", false}, {"false", "", false}, {"true", "", true},
		{"true", "false", false}, {"false", "true", true}, {"true", "invalid", false},
	} {
		t.Setenv("MASSIVE_OPTIONS_ENABLED", test.shared)
		t.Setenv("TAPE_OPTIONS_ENABLED", test.tape)
		service := newOptionsService()
		if service.enabled != test.enabled {
			t.Fatalf("shared=%q tape=%q: enabled=%v", test.shared, test.tape, service.enabled)
		}
	}
}

func TestDisabledOptionsNeverCallGatewayOrDisturbStockTape(t *testing.T) {
	t.Setenv("MASSIVE_OPTIONS_ENABLED", "")
	t.Setenv("TAPE_OPTIONS_ENABLED", "")
	for _, mode := range []string{"live", "massive"} {
		s := panelServer(t, mode)
		t.Cleanup(s.gex.close)
		s.options.base = "http://127.0.0.1:18080"
		s.options.client = &http.Client{Transport: rejectOptionsNetwork{t}}
		now := s.now()
		s.store.AddTrade("AAPL", now, now, 100, 100)
		for _, closed := range []bool{false, true} {
			if closed {
				s.now = func() time.Time { return now.AddDate(0, 0, 1) }
			}
			if got := requestOptions(t, s); got.Status != "subscription-disabled" || len(got.Contracts) != 0 {
				t.Fatal(got)
			}
			if got := requestGEX(t, s); got.Status != "subscription-disabled" || got.Net != nil {
				t.Fatal(got)
			}
			if got := flowRequest(t, s); got.Status != "subscription-disabled" || len(got.Windows) != 0 {
				t.Fatal(got)
			}
		}
		if !s.store.Status().Connected || len(s.store.Snapshot("AAPL", 1).Trades) != 1 {
			t.Fatal("options disablement changed stock tape")
		}
	}
}

func TestSnapshotDenialStopsBothIVAndGEXAcrossRequests(t *testing.T) {
	for _, first := range []string{"iv", "gex"} {
		for _, code := range []int{http.StatusForbidden, http.StatusOK} {
			t.Run(fmt.Sprintf("%s/%d", first, code), func(t *testing.T) {
				s := gexTestServer(t, "live")
				var calls atomic.Int32
				gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					w.WriteHeader(code)
					fmt.Fprint(w, `{"status":"NOT_AUTHORIZED"}`)
				}))
				defer gateway.Close()
				s.options.base = gateway.URL
				if first == "iv" {
					requestOptions(t, s)
				} else {
					requestGEX(t, s)
				}
				for i := 0; i < 3; i++ {
					if got := requestOptions(t, s); got.Status != "access-denied" {
						t.Fatal(got)
					}
					if got := requestGEX(t, s); got.Status != "access-denied" {
						t.Fatal(got)
					}
				}
				// Changing the symbol/cache key must not reopen a denied feed.
				got := s.options.get(context.Background(), optionsReply{Symbol: "MSFT", Spot: 100}, s.now())
				if got.Status != "access-denied" || calls.Load() != 1 {
					t.Fatal(got.Status, calls.Load())
				}
			})
		}
	}
}

func TestFlowDenialDoesNotDisableSnapshotEntitlement(t *testing.T) {
	s := gexTestServer(t, "live")
	var flowCalls atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/options-flow" {
			flowCalls.Add(1)
			w.WriteHeader(403)
			return
		}
		fmt.Fprint(w, `{"status":"OK","results":[]}`)
	}))
	defer gateway.Close()
	s.options.base = gateway.URL
	for i := 0; i < 3; i++ {
		if got := flowRequest(t, s); got.Status != "not-entitled" {
			t.Fatal(got)
		}
	}
	if got := requestOptions(t, s); got.Status != "no-options" {
		t.Fatal(got)
	}
	if flowCalls.Load() != 1 {
		t.Fatal(flowCalls.Load())
	}
}

func TestGatewayDisabledStatusStopsAllLiveOptions(t *testing.T) {
	for _, first := range []string{"iv", "gex", "flow"} {
		t.Run(first, func(t *testing.T) {
			s := gexTestServer(t, "live")
			var calls atomic.Int32
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if first == "flow" {
					fmt.Fprintf(w, `{"schemaVersion":1,"symbol":"AAPL","status":"disabled","asOfMS":%d,"recording":"off"}`, s.now().UnixMilli())
					return
				}
				w.WriteHeader(403)
				fmt.Fprint(w, `{"status":"OPTIONS_DISABLED"}`)
			}))
			defer gateway.Close()
			s.options.base = gateway.URL
			switch first {
			case "iv":
				requestOptions(t, s)
			case "gex":
				requestGEX(t, s)
			case "flow":
				flowRequest(t, s)
			}
			if got := requestOptions(t, s); got.Status != "subscription-disabled" {
				t.Fatal(got)
			}
			if got := requestGEX(t, s); got.Status != "subscription-disabled" {
				t.Fatal(got)
			}
			if got := flowRequest(t, s); got.Status != "subscription-disabled" {
				t.Fatal(got)
			}
			if calls.Load() != 1 {
				t.Fatal(calls.Load())
			}
		})
	}
}

func TestConcurrentSnapshotDenialClearsPendingGEXAndStopsPagination(t *testing.T) {
	for _, paginate := range []bool{false, true} {
		t.Run(fmt.Sprint(paginate), func(t *testing.T) {
			s := gexTestServer(t, "live")
			started, release := make(chan struct{}), make(chan struct{})
			var gexCalls atomic.Int32
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Has("strike_price.gte") {
					w.WriteHeader(403)
					return
				}
				if gexCalls.Add(1) == 1 {
					close(started)
					<-release
				}
				body := map[string]any{"status": "OK", "results": []gexContract{gexFixtureContract(s.now(), "C100", "call", 100, .02, 100)}}
				if paginate {
					body["next_url"] = "/rest/v3/snapshot/options/AAPL?cursor=more"
				}
				json.NewEncoder(w).Encode(body)
			}))
			defer gateway.Close()
			s.options.base = gateway.URL
			pending := make(chan gexReply, 1)
			go func() { pending <- requestGEX(t, s) }()
			<-started
			denial := requestOptions(t, s)
			close(release)
			if denial.Status != "access-denied" {
				t.Fatal(denial)
			}
			got := <-pending
			if got.Status != "access-denied" || got.Net != nil || got.Complete || got.Recording != "" || gexCalls.Load() != 1 {
				t.Fatal(got, gexCalls.Load())
			}
			entries, err := os.ReadDir(s.gex.archive.dir)
			if err != nil || len(entries) != 0 {
				t.Fatal("denied pending chain was archived", entries, err)
			}
		})
	}
}
