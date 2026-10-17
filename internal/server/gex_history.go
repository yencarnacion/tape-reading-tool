package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"tape-reading-tool/internal/tape"
)

type gexHistoryPoint struct {
	AsOfMS int64    `json:"asOfMS"`
	Spot   float64  `json:"spot"`
	Net    *float64 `json:"net"`
	Status string   `json:"status"`
}
type gexComparison struct {
	Minutes  int       `json:"minutes"`
	TargetMS int64     `json:"targetMS"`
	Status   string    `json:"status"`
	Snapshot *gexReply `json:"snapshot,omitempty"`
}
type gexHistory struct {
	Status      string            `json:"status"`
	AnchorMS    int64             `json:"anchorMS"`
	ThroughMS   int64             `json:"throughMS"`
	Session     string            `json:"session"`
	Timeline    []gexHistoryPoint `json:"timeline"`
	Comparisons []gexComparison   `json:"comparisons"`
}

// Changes compare observations of the same OI model, never inferred order flow.
func usableGEXHistory(r gexReply) bool {
	return r.Status == "ready" && r.Coverage.OIFraction >= .9 && r.Coverage.MissingOI == 0 &&
		float64(r.Coverage.Included)/float64(r.Coverage.Seen) >= .8 &&
		(*r.Gross == 0 || r.UnderlyingMS > 0 && r.UnderlyingMS <= r.AsOfMS && r.AsOfMS-r.UnderlyingMS <= gexMaxAgeMS)
}

func (a *gexArchiveStore) historyAt(seed gexReply, clock, anchor time.Time) *gexHistory {
	date := clock.In(gexLocation()).Format("2006-01-02")
	h := &gexHistory{Status: "replay-unavailable", AnchorMS: anchor.UnixMilli(), ThroughMS: clock.UnixMilli(), Session: date,
		Timeline: []gexHistoryPoint{}, Comparisons: []gexComparison{}}
	if !gexStockSymbol.MatchString(seed.Symbol) || anchor.After(clock) || anchor.In(gexLocation()).Format("2006-01-02") != date {
		return h
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	items, status := a.loadLocked(seed.Symbol, date)
	if status != "ready" {
		h.Status = status
		return h
	}
	eligible := make([]gexReply, 0, len(items))
	for _, r := range items {
		if r.MaxDTE != seed.MaxDTE || r.AsOfMS > clock.UnixMilli() || !gexRTH(time.UnixMilli(r.AsOfMS)) {
			continue
		}
		// A repeated append after a process restart is one observation, not a step.
		if len(eligible) > 0 && eligible[len(eligible)-1].AsOfMS == r.AsOfMS {
			eligible[len(eligible)-1] = r
		} else {
			eligible = append(eligible, r)
		}
	}
	if len(eligible) > 4096 {
		h.Status = "history-too-large"
		return h
	}
	for _, r := range eligible {
		point := gexHistoryPoint{AsOfMS: r.AsOfMS, Spot: r.Spot, Status: r.Status}
		if usableGEXHistory(r) {
			point.Net = r.Net
		} else {
			point.Status = "unusable"
		}
		h.Timeline = append(h.Timeline, point)
	}
	if len(eligible) > 0 {
		h.Status = "ready"
	}
	for _, minutes := range []int{1, 5, 15, 30} {
		target := anchor.Add(-time.Duration(minutes) * time.Minute).UnixMilli()
		comp := gexComparison{Minutes: minutes, TargetMS: target, Status: "no-recording"}
		for i := len(eligible) - 1; i >= 0; i-- {
			r := eligible[i]
			if r.AsOfMS > target {
				continue
			}
			switch {
			case target-r.AsOfMS > gexMaxAgeMS:
				comp.Status = "gap"
			case !usableGEXHistory(r):
				comp.Status = "unusable"
			default:
				r.Generation = seed.Generation
				r.Replay = true
				r.History = nil
				comp.Status = "ready"
				comp.Snapshot = &r
			}
			break
		}
		h.Comparisons = append(h.Comparisons, comp)
	}
	// Keep even unusually wide chains from producing an unbounded UI response.
	if body, err := json.Marshal(h); err != nil || len(body) > 4<<20 {
		h.Status = "history-too-large"
		h.Comparisons = []gexComparison{}
	}
	return h
}

// Read-only scrub: the clock and selected stock belong to the server. This
// endpoint never switches symbols, seeks playback, or fetches a current chain.
func (s *Server) handleGEXHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
			http.Error(w, "same origin required", 403)
			return
		}
	}
	q := r.URL.Query()
	symbol := tape.NormalizeSymbol(q.Get("symbol"))
	dte := 120
	valid := len(q["symbol"]) == 1
	for key, values := range q {
		if (key != "symbol" && key != "dte" && key != "at") || len(values) != 1 {
			valid = false
		}
	}
	if q.Has("dte") {
		var err error
		dte, err = strconv.Atoi(q.Get("dte"))
		valid = valid && err == nil
	}
	clock, mode, _, _ := s.panelClock()
	at := clock
	if q.Has("at") {
		ms, err := strconv.ParseInt(q.Get("at"), 10, 64)
		valid = valid && err == nil && ms > 0
		at = time.UnixMilli(ms)
	}
	if !valid || !gexStockSymbol.MatchString(symbol) || !validGEXDTE(dte) || symbol != s.store.Active() || at.After(clock) || at.In(gexLocation()).Format("2006-01-02") != clock.In(gexLocation()).Format("2006-01-02") {
		http.Error(w, "selected symbol, supported scope and a time within this session at or before the clock required", 400)
		return
	}
	seed := gexReply{SchemaVersion: 1, Symbol: symbol, Generation: s.store.Generation(symbol), MaxDTE: dte, Model: gexModel, Replay: true}
	if mode != "live" && mode != "massive" && mode != "replay" && mode != "render" {
		seed.Status = "live-only"
		writeJSON(w, 200, seed)
		return
	}
	reply := s.gex.archive.replayAt(seed, at)
	anchor := at
	if reply.AsOfMS > 0 {
		anchor = time.UnixMilli(reply.AsOfMS)
		// Scrubbing presents the observation at its own time, clearly recorded.
		reply = s.gex.archive.replayAt(seed, anchor)
	}
	reply.History = s.gex.archive.historyAt(seed, clock, anchor)
	current, currentMode, _, _ := s.panelClock()
	if s.store.Active() != symbol || s.store.Generation(symbol) != seed.Generation || currentMode != mode || current.Before(clock) || current.In(gexLocation()).Format("2006-01-02") != clock.In(gexLocation()).Format("2006-01-02") {
		seed.Status = "context-changed"
		reply = seed
	}
	writeJSON(w, 200, reply)
}
