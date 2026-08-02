package server

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

// External control states. They are also the badge labels the public UI shows,
// so a controller and an operator always describe the session the same way.
const (
	externalStateDetached  = "detached"
	externalStateCueing    = "cueing"
	externalStatePaused    = "paused"
	externalStateFollowing = "following"
	externalStateFastF     = "fast_follow"
	externalStateIncompl   = "data_incomplete"
	externalStateError     = "error"
)

type externalReplayState struct {
	Attached            bool           `json:"attached"`
	ControllerID        string         `json:"controller_id,omitempty"`
	ControllerSessionID string         `json:"controller_session_id,omitempty"`
	Sequence            uint64         `json:"sequence"`
	Generation          uint64         `json:"generation"`
	Symbol              string         `json:"symbol,omitempty"`
	TargetUS            int64          `json:"target_us"`
	Playing             bool           `json:"playing"`
	Speed               float64        `json:"speed"`
	FastFollow          bool           `json:"fast_follow"`
	State               string         `json:"state"`
	DriftUS             int64          `json:"drift_us"`
	DriftCorrections    uint64         `json:"drift_corrections"`
	Cues                uint64         `json:"cues"`
	LastCueMS           int64          `json:"last_cue_ms"`
	LastCueRows         int            `json:"last_cue_rows"`
	Error               string         `json:"error,omitempty"`
	Missing             []missingRange `json:"missing,omitempty"`
}

type missingRange struct {
	Kind      string             `json:"kind"`
	Intervals []storage.Interval `json:"intervals"`
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

// uiAudioState is the browser heartbeat. Only the newest report is kept, so a
// noisy or reloading tab cannot grow this into an unbounded queue.
type uiAudioState struct {
	Ready      bool  `json:"ready"`
	ReportedMS int64 `json:"reported_ms"`
}

func (s *Server) externalStatus() map[string]any {
	s.externalMu.Lock()
	state := s.external
	audio := s.uiAudio
	s.externalMu.Unlock()
	capability := "ready"
	switch {
	case !s.cfg.ExternalReplay.Enabled:
		capability = "disabled"
	case s.mode != "replay":
		capability = "wrong_mode"
	}
	// A tab that has never unlocked Web Audio cannot play historical sound, so a
	// controller is told that rather than being left to assume a healthy session.
	audioReady := audio.Ready && audio.ReportedMS > 0 && s.now().UnixMilli()-audio.ReportedMS < 5000
	result := map[string]any{
		"protocol_version":   1,
		"enabled":            s.cfg.ExternalReplay.Enabled,
		"mode":               s.mode,
		"capable":            capability == "ready",
		"capability":         capability,
		"loopback_only":      s.cfg.ExternalReplay.LoopbackOnly,
		"token_required":     s.cfg.ExternalReplay.Token != "",
		"max_detailed_speed": s.cfg.ExternalReplay.MaxDetailedSpeed,
		"sync_tolerance":     s.cfg.ExternalReplay.SyncTolerance,
		"ui_audio_ready":     audioReady,
		"control":            state,
	}
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

// handleExternalReplayUI accepts the browser's bounded audio heartbeat. It is
// same-origin only and never mutates replay state.
func (s *Server) handleExternalReplayUI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.externalClientAllowed(r) {
		http.Error(w, "external replay UI status is loopback-only", http.StatusForbidden)
		return
	}
	defer r.Body.Close()
	var request struct {
		AudioReady bool `json:"audio_ready"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		http.Error(w, "invalid ui status", http.StatusBadRequest)
		return
	}
	s.externalMu.Lock()
	s.uiAudio = uiAudioState{Ready: request.AudioReady, ReportedMS: s.now().UnixMilli()}
	s.externalMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))

	// One control operation runs at a time. Ownership, ordering, and the
	// reconstruction it authorises have to be decided together, or two
	// controllers could both pass the sequence check and then race the rebuild.
	s.externalControlMu.Lock()
	defer s.externalControlMu.Unlock()

	s.externalMu.Lock()
	current := s.external
	s.externalMu.Unlock()
	if current.Attached && current.ControllerSessionID != request.ControllerSessionID {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "another controller session owns external replay",
			"owner": current.ControllerSessionID, "status": s.externalStatus(),
		})
		return
	}
	if current.Attached && request.Sequence < current.Sequence {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "stale controller sequence", "accepted_sequence": current.Sequence, "status": s.externalStatus(),
		})
		return
	}
	if current.Attached && request.Sequence == current.Sequence {
		// Idempotent: the same accepted sequence never repeats the work.
		writeJSON(w, http.StatusOK, s.externalStatus())
		return
	}

	switch request.Action {
	case "detach":
		s.releaseExternal(replay, externalStateDetached)
		writeJSON(w, http.StatusOK, s.externalStatus())
		return
	case "cue", "sync":
	default:
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
	if request.Speed == 0 {
		request.Speed = 1
	}
	if request.Symbol == "" || request.Source != "historical" || request.Provider == "" || request.Provider == "all" ||
		request.TargetUS <= 0 || request.RangeEndUS < request.TargetUS || request.Speed < .1 || request.Speed > 20 {
		http.Error(w, "invalid historical replay request", http.StatusBadRequest)
		return
	}
	if request.WarmupStartUS <= 0 {
		warmup, _ := time.ParseDuration(s.cfg.ExternalReplay.DefaultWarmup)
		request.WarmupStartUS = request.TargetUS - warmup.Microseconds()
	}
	if request.WarmupStartUS <= 0 || request.WarmupStartUS > request.TargetUS {
		http.Error(w, "warmup_start_us must be positive and at or before target_us", http.StatusBadRequest)
		return
	}

	fast := request.Speed > s.cfg.ExternalReplay.MaxDetailedSpeed
	tolerance, _ := time.ParseDuration(s.cfg.ExternalReplay.SyncTolerance)

	// A sync that only nudges the clock forward inside tolerance, on the same
	// symbol and the same generation, is corrected in place. Anything else -
	// a backward move, a symbol change, a large jump, a generation mismatch, or
	// a change of detailed/fast mode - rebuilds deterministically.
	if request.Action == "sync" && current.Attached {
		symbol, positionUS, generation, _ := replay.Position()
		drift := request.TargetUS - positionUS
		sameGeneration := generation == current.Generation
		if symbol == request.Symbol && sameGeneration && drift >= 0 && drift <= tolerance.Microseconds() &&
			fast == current.FastFollow && !fast && request.Speed == current.Speed {
			s.externalMu.Lock()
			s.external.Sequence = request.Sequence
			s.external.TargetUS = request.TargetUS
			s.external.Speed = request.Speed
			s.external.Playing = request.Playing
			s.external.DriftUS = drift
			s.external.DriftCorrections++
			s.external.State = externalStatePaused
			if request.Playing {
				s.external.State = externalStateFollowing
			}
			s.external.Error = ""
			s.external.Missing = nil
			s.externalMu.Unlock()
			if err := s.applyExternalTransport(replay, request.Playing); err != nil {
				s.recordExternalError(err.Error())
			} else {
				_, _, transportGeneration, _ := replay.Position()
				s.externalMu.Lock()
				s.external.Generation = transportGeneration
				s.externalMu.Unlock()
			}
			writeJSON(w, http.StatusOK, s.externalStatus())
			return
		}
		// Fast follow keeps the historical clock and the compact-bar chart moving
		// without pretending the detailed tape is current.
		if symbol == request.Symbol && fast && current.FastFollow && request.TargetUS >= positionUS {
			if err := replay.Track(request.Symbol, request.TargetUS); err == nil {
				_, _, trackedGeneration, _ := replay.Position()
				s.externalMu.Lock()
				s.external.Sequence = request.Sequence
				s.external.TargetUS = request.TargetUS
				s.external.Speed = request.Speed
				s.external.Playing = false
				s.external.Generation = trackedGeneration
				s.external.DriftUS = drift
				s.external.State = externalStateFastF
				s.external.Error = ""
				s.external.Missing = nil
				s.externalMu.Unlock()
				writeJSON(w, http.StatusOK, s.externalStatus())
				return
			}
		}
	}

	// Coverage is checked before any state changes, so an incomplete request
	// leaves the current display exactly as it was.
	missing := make([]missingRange, 0, 3)
	for _, kind := range []string{"minute_bars", "trades", "quotes"} {
		_, gaps, err := s.recorder.CoverageIntervals(r.Context(), request.Symbol, request.Provider, kind, request.WarmupStartUS, request.RangeEndUS)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if len(gaps) > 0 {
			missing = append(missing, missingRange{Kind: kind, Intervals: gaps})
		}
	}
	if len(missing) > 0 {
		log.Printf("external cue rejected symbol=%s target_us=%d reason=data_incomplete kinds=%d", request.Symbol, request.TargetUS, len(missing))
		s.externalMu.Lock()
		s.external.State = externalStateIncompl
		s.external.Error = "historical data incomplete"
		s.external.Missing = missing
		s.externalMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "historical data incomplete", "missing": missing, "status": s.externalStatus(),
		})
		return
	}

	s.markExternalCueing(request)
	// Fast follow still reconstructs once on entry so the chart and clock are
	// exact; it simply does not stream detailed prints afterwards.
	playing := request.Playing && !fast
	report, err := replay.Cue(r.Context(), feed.ReplayRequest{
		Symbol: request.Symbol, Source: request.Source, Provider: request.Provider,
		StartUS: request.TargetUS, EndUS: request.RangeEndUS, Speed: request.Speed,
	}, request.WarmupStartUS, request.TargetUS, playing)
	if err != nil {
		s.recordExternalError(err.Error())
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error(), "status": s.externalStatus()})
		return
	}

	state := externalStatePaused
	if playing {
		state = externalStateFollowing
	}
	if fast {
		state = externalStateFastF
	}
	s.externalMu.Lock()
	s.external = externalReplayState{
		Attached: true, ControllerID: request.ControllerID, ControllerSessionID: request.ControllerSessionID,
		Sequence: request.Sequence, Generation: report.Generation, Symbol: request.Symbol,
		TargetUS: request.TargetUS, Playing: playing, Speed: request.Speed, FastFollow: fast, State: state,
		DriftCorrections: current.DriftCorrections, Cues: current.Cues + 1,
		LastCueMS: report.Duration.Milliseconds(), LastCueRows: report.Rows,
	}
	s.externalMu.Unlock()
	writeJSON(w, http.StatusOK, s.externalStatus())
}

// applyExternalTransport moves an already reconstructed replay between playing
// and paused without rebuilding it.
func (s *Server) applyExternalTransport(replay *feed.Replay, playing bool) error {
	status := replay.Status()
	switch {
	case playing && status.State == "paused":
		return replay.Resume()
	case !playing && status.State == "replaying":
		return replay.Pause()
	}
	return nil
}

func (s *Server) markExternalCueing(request externalControlRequest) {
	s.externalMu.Lock()
	s.external.State = externalStateCueing
	s.external.Symbol = request.Symbol
	s.external.TargetUS = request.TargetUS
	s.external.Error = ""
	s.external.Missing = nil
	s.externalMu.Unlock()
}

func (s *Server) recordExternalError(message string) {
	s.externalMu.Lock()
	s.external.State = externalStateError
	s.external.Error = message
	s.externalMu.Unlock()
}

// releaseExternal drops ownership and leaves the display intact. Pausing is
// deliberate: an autonomous continuation after the controller is gone would be
// ambiguous about who is driving.
func (s *Server) releaseExternal(replay *feed.Replay, state string) {
	if replay != nil {
		_ = replay.Pause()
	}
	s.externalMu.Lock()
	s.external = externalReplayState{State: state}
	s.externalMu.Unlock()
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
	if decoder.Decode(&request) != nil || request.ProtocolVersion != 1 || len(request.Requirements) == 0 || len(request.Requirements) > 256 {
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
		results = append(results, map[string]any{
			"requirement": requirement, "complete": len(missing) == 0,
			"covered": covered, "missing": missing,
		})
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

// detachExternalForManualAction runs before every manual transport or ticker
// action so the operator, not the controller, owns what happens next.
func (s *Server) detachExternalForManualAction() {
	s.externalMu.Lock()
	if s.external.Attached {
		s.external = externalReplayState{State: externalStateDetached}
	}
	s.externalMu.Unlock()
}
