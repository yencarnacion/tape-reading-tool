package server

import (
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"tape-reading-tool/internal/gexbot"
)

func (s *Server) handleGexbot(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	local := func(host string) bool {
		if h, _, e := net.SplitHostPort(host); e == nil {
			host = h
		}
		return host == "localhost" || net.ParseIP(strings.Trim(host, "[]")).IsLoopback()
	}
	if r.Method != "GET" {
		http.Error(w, "GET required", 405)
		return
	}
	if !local(r.Host) || !local(r.RemoteAddr) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "local only", 403)
		return
	}
	if o := r.Header.Get("Origin"); o != "" {
		u, e := url.Parse(o)
		if e != nil || u.Host != r.Host {
			http.Error(w, "same origin required", 403)
			return
		}
	}
	q := r.URL.Query()
	symbol := strings.ToUpper(q.Get("symbol"))
	for k, values := range q {
		if (k != "symbol" && k != "at") || len(values) != 1 {
			http.Error(w, "invalid query", 400)
			return
		}
	}
	if !gexbot.SymbolPattern.MatchString(symbol) || symbol != s.store.Active() {
		http.Error(w, "selected symbol required", 400)
		return
	}
	clock, mode, _, _ := s.panelClock()
	generation := s.store.Generation(symbol)
	var reply gexbot.View
	if mode == "replay" || mode == "render" || q.Has("at") {
		at := clock.UnixMilli()
		if q.Has("at") {
			n, e := strconv.ParseInt(q.Get("at"), 10, 64)
			if e != nil || n < 1e12 {
				http.Error(w, "invalid clock", 400)
				return
			}
			if n < at {
				at = n
			}
		}
		reply = s.gexbot.Replay(symbol, at)
	} else if (mode == "live" || mode == "massive") && s.store.Status().Connected {
		reply = s.gexbot.Live(r.Context(), symbol, s.now())
	} else {
		reply = gexbot.View{Version: 1, Symbol: symbol, Status: "waiting-tape"}
	}
	if symbol != s.store.Active() || generation != s.store.Generation(symbol) {
		reply = gexbot.View{Version: 1, Symbol: symbol, Status: "context-changed"}
	}
	writeJSON(w, 200, reply)
}
