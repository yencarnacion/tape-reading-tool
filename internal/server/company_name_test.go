package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"tape-reading-tool/internal/marketgateway"
)

func TestCompanyNameUsesConfiguredMarketGateway(t *testing.T) {
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/adapter/rest/v3/reference/tickers/NVDA" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected reference request: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"results":{"name":" NVIDIA Corporation "}}`)
	}))
	defer adapter.Close()
	client, err := marketgateway.New(adapter.URL+"/adapter", "test-token")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	s := &Server{companyReference: client}
	for _, tc := range []struct {
		symbol, site string
		status       int
	}{
		{"nvda", "same-origin", http.StatusOK},
		{"../NVDA", "", http.StatusBadRequest},
		{"NVDA", "cross-site", http.StatusForbidden},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/company-name?symbol="+tc.symbol, nil)
		req.Header.Set("Sec-Fetch-Site", tc.site)
		w := httptest.NewRecorder()
		s.handleCompanyName(w, req)
		if w.Code != tc.status {
			t.Fatalf("status %d, want %d: %s", w.Code, tc.status, w.Body)
		}
		if tc.status == http.StatusOK {
			var result map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result["name"] != "NVIDIA Corporation" {
				t.Fatalf("company name missing: %v (%v)", result, err)
			}
		}
	}
}
