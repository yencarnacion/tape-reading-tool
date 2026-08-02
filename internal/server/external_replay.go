package server

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

type externalReplayState struct {
	Attached            bool    `json:"attached"`
	ControllerID        string  `json:"controller_id,omitempty"`
	ControllerSessionID string  `json:"controller_session_id,omitempty"`
	Sequence            uint64  `json:"sequence"`
	Generation          uint64  `json:"generation"`
	Symbol              string  `json:"symbol,omitempty"`
	TargetUS            int64   `json:"target_us"`
	Playing             bool    `json:"playing"`
	Speed               float64 `json:"speed"`
	FastFollow          bool    `json:"fast_follow"`
	State               string  `json:"state"`
	Error               string  `json:"error,omitempty"`
}

type externalControlRequest struct {
	ProtocolVersion     int     `json:"protocol_version"`
	ControllerID        string  `json:"controller_id"`
	ControllerSessionID string  `json:"controller_session_id"`
	Sequence            uint64  `json:"sequence"`
	Action              string  `json:"action"`
	Symbol              string  `json:"symbol"`
	Source              string  `json:"source"`
	Provider            string  `json:"provider"`
	TargetUS            int64   `json:"target_us"`
	WarmupStartUS       int64   `json:"warmup_start_us"`
	RangeEndUS          int64   `json:"range_end_us"`
	Playing             bool    `json:"playing"`
	Speed               float64 `json:"speed"`
}

func (s *Server) externalStatus() map[string]any {
	s.externalMu.Lock()
	state := s.external
	s.externalMu.Unlock()
	result := map[string]any{"protocol_version": 1, "enabled": s.cfg.ExternalReplay.Enabled, "mode": s.mode, "capable": s.mode == "replay" && s.cfg.ExternalReplay.Enabled, "control": state}
	if replay, ok := s.feed.(*feed.Replay); ok {
		result["replay"] = replay.Status()
	}
	return result
}

func (s *Server) handleExternalReplayStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.externalClientAllowed(r) {
		http.Error(w, "external replay is loopback-only", http.StatusForbidden)
		return
	}
	writeJSON(w, http.StatusOK, s.externalStatus())
}

func (s *Server) handleExternalReplayControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.cfg.ExternalReplay.Enabled {
		http.Error(w, "external replay control is disabled", http.StatusNotFound)
		return
	}
	if !s.externalClientAllowed(r) {
		http.Error(w, "external replay is loopback-only", http.StatusForbidden)
		return
	}
	if !s.externalTokenAllowed(r) {
		http.Error(w, "invalid external replay token", http.StatusUnauthorized)
		return
	}
	if s.mode != "replay" {
		http.Error(w, fmt.Sprintf("external replay requires replay mode; current mode is %s", s.mode), http.StatusConflict)
		return
	}
	replay, ok := s.feed.(*feed.Replay)
	if !ok {
		http.Error(w, "external replay requires replay mode", http.StatusConflict)
		return
	}
	defer r.Body.Close()
	var request externalControlRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || request.ProtocolVersion != 1 || request.ControllerSessionID == "" || request.Sequence == 0 {
		http.Error(w, "invalid protocol version or controller sequence", http.StatusBadRequest)
		return
	}
	s.externalMu.Lock()
	current := s.external
	if current.Attached && current.ControllerSessionID != request.ControllerSessionID {
		s.externalMu.Unlock()
		http.Error(w, "another controller session owns external replay", http.StatusConflict)
		return
	}
	if current.Attached && request.Sequence < current.Sequence {
		s.externalMu.Unlock()
		http.Error(w, "stale controller sequence", http.StatusConflict)
		return
	}
	if current.Attached && request.Sequence == current.Sequence {
		s.externalMu.Unlock()
		writeJSON(w, http.StatusOK, s.externalStatus())
		return
	}
	s.externalMu.Unlock()
	if strings.EqualFold(request.Action, "detach") {
		replay.Pause()
		s.externalMu.Lock()
		s.external = externalReplayState{State: "detached"}
		s.externalMu.Unlock()
		writeJSON(w, http.StatusOK, s.externalStatus())
		return
	}
	if !strings.EqualFold(request.Action, "cue") && !strings.EqualFold(request.Action, "sync") {
		http.Error(w, "action must be cue, sync, or detach", http.StatusBadRequest)
		return
	}
	if s.recorder == nil {
		http.Error(w, "historical database is unavailable", http.StatusServiceUnavailable)
		return
	}
	request.Symbol = tape.NormalizeSymbol(request.Symbol)
	request.Source = strings.ToLower(request.Source)
	request.Provider = strings.ToLower(request.Provider)
	if request.Symbol == "" || request.Source != "historical" || request.Provider == "" || request.Provider == "all" || request.TargetUS <= 0 || request.RangeEndUS < request.TargetUS || request.Speed < .1 || request.Speed > 20 {
		http.Error(w, "invalid historical replay request", http.StatusBadRequest)
		return
	}
	if request.WarmupStartUS <= 0 {
		warmup, _ := time.ParseDuration(s.cfg.ExternalReplay.DefaultWarmup)
		request.WarmupStartUS = request.TargetUS - warmup.Microseconds()
	}
	for _, kind := range []string{"minute_bars", "trades", "quotes"} {
		_, missing, err := s.recorder.CoverageIntervals(r.Context(), request.Symbol, request.Provider, kind, request.WarmupStartUS, request.RangeEndUS)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if len(missing) > 0 {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "historical data incomplete", "kind": kind, "missing": missing})
			return
		}
	}
	fast := request.Speed > s.cfg.ExternalReplay.MaxDetailedSpeed
	playing := request.Playing && !fast
	err := replay.Cue(feed.ReplayRequest{Symbol: request.Symbol, Source: request.Source, Provider: request.Provider, StartUS: request.TargetUS, EndUS: request.RangeEndUS, Speed: request.Speed}, request.WarmupStartUS, request.TargetUS, playing)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	status := replay.Status()
	state := "paused"
	if request.Playing {
		state = "following"
	}
	if fast {
		state = "fast_follow"
	}
	s.externalMu.Lock()
	s.external = externalReplayState{Attached: true, ControllerID: request.ControllerID, ControllerSessionID: request.ControllerSessionID, Sequence: request.Sequence, Generation: status.Generation, Symbol: request.Symbol, TargetUS: request.TargetUS, Playing: request.Playing, Speed: request.Speed, FastFollow: fast, State: state}
	s.externalMu.Unlock()
	writeJSON(w, http.StatusOK, s.externalStatus())
}

func (s *Server) handleCoverageCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.externalClientAllowed(r) {
		http.Error(w, "historical coverage is loopback-only", http.StatusForbidden)
		return
	}
	if s.recorder == nil {
		http.Error(w, "historical database is unavailable", http.StatusServiceUnavailable)
		return
	}
	var request struct {
		ProtocolVersion int                `json:"protocol_version"`
		Requirements    []storage.Coverage `json:"requirements"`
	}
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || request.ProtocolVersion != 1 || len(request.Requirements) > 256 {
		http.Error(w, "invalid coverage request", http.StatusBadRequest)
		return
	}
	results := make([]map[string]any, 0, len(request.Requirements))
	for _, requirement := range request.Requirements {
		covered, missing, err := s.recorder.CoverageIntervals(r.Context(), requirement.Symbol, requirement.Provider, requirement.Kind, requirement.StartUS, requirement.EndUS)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		results = append(results, map[string]any{"requirement": requirement, "complete": len(missing) == 0, "covered": covered, "missing": missing})
	}
	writeJSON(w, http.StatusOK, map[string]any{"protocol_version": 1, "results": results})
}

func (s *Server) externalClientAllowed(r *http.Request) bool {
	if !s.cfg.ExternalReplay.LoopbackOnly {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
func (s *Server) externalTokenAllowed(r *http.Request) bool {
	expected := s.cfg.ExternalReplay.Token
	if expected == "" {
		return true
	}
	actual := r.Header.Get("X-Tape-Control-Token")
	return len(actual) == len(expected) && subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}

func (s *Server) detachExternalForManualAction() {
	s.externalMu.Lock()
	if s.external.Attached {
		s.external = externalReplayState{State: "detached"}
	}
	s.externalMu.Unlock()
}
