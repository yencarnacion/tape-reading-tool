package server

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"tape-reading-tool/internal/tape"
)

func (s *Server) handleCompanyName(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		http.Error(w, "same origin required", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || !strings.EqualFold(u.Host, r.Host) || (u.Scheme != "http" && u.Scheme != "https") {
			http.Error(w, "same origin required", http.StatusForbidden)
			return
		}
	}
	symbol := tape.NormalizeSymbol(r.URL.Query().Get("symbol"))
	if symbol == "" {
		http.Error(w, "invalid ticker", http.StatusBadRequest)
		return
	}
	if s.companyReference == nil {
		writeJSON(w, http.StatusOK, map[string]string{"name": ""})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	var result struct {
		Results struct {
			Name string `json:"name"`
		} `json:"results"`
	}
	if err := s.companyReference.Get(ctx, "/rest/v3/reference/tickers/"+symbol, &result); err != nil {
		http.Error(w, "company lookup unavailable", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": strings.TrimSpace(result.Results.Name)})
}
