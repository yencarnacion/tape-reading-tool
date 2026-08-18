package server

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"time"

	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

const panelDataSchemaVersion = 1

type panelDataCacheEntry struct {
	value any
	at    time.Time
}

type panelDailyBar struct {
	SessionDateET string  `json:"sessionDateET"`
	Open          float64 `json:"open"`
	High          float64 `json:"high"`
	Low           float64 `json:"low"`
	Close         float64 `json:"close"`
	Volume        float64 `json:"volume"`
	StartUS       int64   `json:"startUS"`
	EndUS         int64   `json:"endUS"`
	Complete      bool    `json:"complete"`
}

type panelDailyResponse struct {
	SchemaVersion       int             `json:"schemaVersion"`
	Symbol              string          `json:"symbol"`
	Timezone            string          `json:"timezone"`
	Session             string          `json:"session"`
	ThroughUS           int64           `json:"throughUS"`
	BeforeSessionDateET string          `json:"beforeSessionDateET"`
	RequestedSessions   int             `json:"requestedSessions"`
	CompleteSessions    int             `json:"completeSessions"`
	Source              string          `json:"source"`
	Provider            string          `json:"provider"`
	Adjustment          string          `json:"adjustment"`
	Status              string          `json:"status"`
	Message             string          `json:"message,omitempty"`
	Bars                []panelDailyBar `json:"bars"`
}

type panelRTHResponse struct {
	SchemaVersion       int     `json:"schemaVersion"`
	Symbol              string  `json:"symbol"`
	SessionDateET       string  `json:"sessionDateET"`
	ThroughUS           int64   `json:"throughUS"`
	Open                float64 `json:"open,omitempty"`
	High                float64 `json:"high,omitempty"`
	Low                 float64 `json:"low,omitempty"`
	LowTimeUS           int64   `json:"lowTimeUS,omitempty"`
	Last                float64 `json:"last,omitempty"`
	LastTimeUS          int64   `json:"lastTimeUS,omitempty"`
	EligibleTradeCount  int64   `json:"eligibleTradeCount"`
	CompleteFromRTHOpen bool    `json:"completeFromRTHOpen"`
	Source              string  `json:"source"`
	Provider            string  `json:"provider"`
	Mode                string  `json:"mode"`
	Status              string  `json:"status"`
	Message             string  `json:"message,omitempty"`
}

func (s *Server) panelClock() (time.Time, string, string, string) {
	mode, source, provider := s.mode, "live", "ibkr"
	clock := s.now()
	if replay, ok := s.feed.(*feed.Replay); ok {
		state := replay.Status()
		if state.PositionUS > 0 {
			clock = time.UnixMicro(state.PositionUS)
		}
		source, provider = state.Source, state.Provider
	}
	if mode == "massive" {
		provider = "massive"
	}
	if mode == "demo" {
		source, provider = "demo", "demo"
	}
	return clock, mode, source, provider
}

func (s *Server) panelRequest(r *http.Request) (symbol string, before time.Time, limit int, err error) {
	symbol = tape.NormalizeSymbol(r.URL.Query().Get("symbol"))
	if symbol == "" {
		return "", time.Time{}, 0, fmt.Errorf("invalid symbol")
	}
	limit, err = strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit < 1 || limit > 90 {
		return "", time.Time{}, 0, fmt.Errorf("limit must be between 1 and 90")
	}
	location, locationErr := time.LoadLocation(s.cfg.App.Timezone)
	if locationErr != nil {
		return "", time.Time{}, 0, locationErr
	}
	before, err = time.ParseInLocation("2006-01-02", r.URL.Query().Get("before"), location)
	if err != nil {
		return "", time.Time{}, 0, fmt.Errorf("before must be YYYY-MM-DD")
	}
	return symbol, before, limit, nil
}

func (s *Server) handlePanelDailyBars(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	symbol, before, limit, err := s.panelRequest(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	clock, mode, source, provider := s.panelClock()
	location, _ := time.LoadLocation(s.cfg.App.Timezone)
	clockLocal := clock.In(location)
	clockSession := time.Date(clockLocal.Year(), clockLocal.Month(), clockLocal.Day(), 0, 0, 0, 0, location)
	if before.After(clockSession) { // an older replay may never ask beyond its own session
		before = clockSession
	}
	key := fmt.Sprintf("daily|%s|%s|%s|%s|%s|%d", symbol, mode, source, provider, before.Format("2006-01-02"), limit)
	s.panelDataMu.Lock()
	if cached, ok := s.panelDataCache[key]; ok {
		s.panelDataMu.Unlock()
		writeJSON(w, http.StatusOK, cached.value)
		return
	}
	defer s.panelDataMu.Unlock()
	response := panelDailyResponse{SchemaVersion: panelDataSchemaVersion, Symbol: symbol, Timezone: s.cfg.App.Timezone, Session: "RTH", ThroughUS: clock.UnixMicro(), BeforeSessionDateET: before.Format("2006-01-02"), RequestedSessions: limit, Source: source, Provider: provider, Adjustment: "provider-consistent", Status: "insufficient", Bars: []panelDailyBar{}}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if mode == "demo" {
		response.Adjustment = "synthetic-unadjusted"
		response.Bars = demoDailyBars(before, limit, location)
	} else if mode == "live" && s.dailyBars != nil {
		response.Adjustment = "ibkr-provider"
		response.Message = "IBKR adjustment semantics are provider-defined; no cross-provider normalization is applied"
		bars, requestErr := s.dailyBars(ctx, symbol, before, limit)
		if requestErr != nil {
			response.Status, response.Message = "unavailable", requestErr.Error()
		} else {
			response.Bars = convertDailyBars(bars, before, location)
		}
	} else if s.recorder != nil && provider != "all" {
		historySource := source
		if mode == "massive" {
			historySource = "historical"
		}
		response.Source = historySource
		if provider == "massive" {
			response.Adjustment = "unadjusted"
		} else {
			response.Adjustment = "raw-recorded"
		}
		response.Bars, err = s.localCompletedDailyBars(ctx, symbol, historySource, provider, before, limit, location)
		if err != nil {
			response.Status, response.Message = "unavailable", err.Error()
		}
	} else {
		response.Status, response.Message = "unavailable", "completed RTH history is unavailable"
	}
	response.CompleteSessions = len(response.Bars)
	if response.CompleteSessions == limit {
		response.Status = "ready"
	}
	s.panelDataCache[key] = panelDataCacheEntry{value: response, at: s.now()}
	writeJSON(w, http.StatusOK, response)
}

func convertDailyBars(bars []storage.MinuteBar, before time.Time, location *time.Location) []panelDailyBar {
	result := make([]panelDailyBar, 0, len(bars))
	for _, bar := range bars {
		// IBKR encodes one-day bars as YYYYMMDD; the feed adapter stores that
		// calendar date at UTC midnight. Reinterpret the calendar components in
		// the application timezone instead of shifting midnight to the prior ET day.
		raw := time.UnixMicro(bar.TimeUS).UTC()
		date := time.Date(raw.Year(), raw.Month(), raw.Day(), 0, 0, 0, 0, location)
		if !date.Before(before) || !validOHLC(bar) {
			continue
		}
		start := time.Date(date.Year(), date.Month(), date.Day(), 9, 30, 0, 0, location)
		end := time.Date(date.Year(), date.Month(), date.Day(), 16, 0, 0, 0, location)
		result = append(result, panelDailyBar{SessionDateET: date.Format("2006-01-02"), Open: bar.Open, High: bar.High, Low: bar.Low, Close: bar.Close, Volume: bar.Volume, StartUS: start.UnixMicro(), EndUS: end.UnixMicro(), Complete: true})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].SessionDateET < result[j].SessionDateET })
	return result
}

func validOHLC(bar storage.MinuteBar) bool {
	return bar.Open > 0 && bar.High > 0 && bar.Low > 0 && bar.Close > 0 && bar.High >= bar.Low && !math.IsNaN(bar.High) && !math.IsInf(bar.High, 0)
}

func demoDailyBars(before time.Time, limit int, location *time.Location) []panelDailyBar {
	result := make([]panelDailyBar, 0, limit)
	for day, index := before.AddDate(0, 0, -1), 0; len(result) < limit; day = day.AddDate(0, 0, -1) {
		if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
			continue
		}
		low := 40 + float64(index%7)*.35
		dailyRange := .045 + float64(index%5)*.002
		start := time.Date(day.Year(), day.Month(), day.Day(), 9, 30, 0, 0, location)
		end := time.Date(day.Year(), day.Month(), day.Day(), 16, 0, 0, 0, location)
		result = append(result, panelDailyBar{SessionDateET: day.Format("2006-01-02"), Open: low * 1.01, High: low * (1 + dailyRange), Low: low, Close: low * 1.025, Volume: 1_000_000 + float64(index)*10_000, StartUS: start.UnixMicro(), EndUS: end.UnixMicro(), Complete: true})
		index++
	}
	sort.Slice(result, func(i, j int) bool { return result[i].SessionDateET < result[j].SessionDateET })
	return result
}

func (s *Server) localCompletedDailyBars(ctx context.Context, symbol, source, provider string, before time.Time, limit int, location *time.Location) ([]panelDailyBar, error) {
	result := make([]panelDailyBar, 0, limit)
	for day, checked := before.AddDate(0, 0, -1), 0; len(result) < limit && checked < 180; day, checked = day.AddDate(0, 0, -1), checked+1 {
		if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
			continue
		}
		start := time.Date(day.Year(), day.Month(), day.Day(), 9, 30, 0, 0, location)
		end := time.Date(day.Year(), day.Month(), day.Day(), 16, 0, 0, 0, location)
		covered, err := s.recorder.HasCoverage(ctx, symbol, provider, "trades", start.UnixMicro(), end.UnixMicro()-1)
		if err != nil {
			return nil, err
		}
		if !covered {
			covered, err = s.recorder.HasCoverage(ctx, symbol, provider, "minute_bars", start.UnixMicro(), end.UnixMicro()-1)
			if err != nil {
				return nil, err
			}
		}
		if !covered {
			continue
		}
		bars, err := s.recorder.MinuteBars(ctx, symbol, source, provider, start.UnixMicro(), end.UnixMicro()-1)
		if err != nil {
			return nil, err
		}
		if bar, ok := aggregateRTHBars(bars); ok {
			bar.SessionDateET, bar.StartUS, bar.EndUS, bar.Complete = day.Format("2006-01-02"), start.UnixMicro(), end.UnixMicro(), true
			result = append(result, bar)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].SessionDateET < result[j].SessionDateET })
	return result, nil
}

func aggregateRTHBars(bars []storage.MinuteBar) (panelDailyBar, bool) {
	if len(bars) == 0 {
		return panelDailyBar{}, false
	}
	result := panelDailyBar{Open: bars[0].Open, High: bars[0].High, Low: bars[0].Low, Close: bars[0].Close}
	for _, bar := range bars {
		if !validOHLC(bar) {
			continue
		}
		result.High = math.Max(result.High, bar.High)
		result.Low = math.Min(result.Low, bar.Low)
		result.Close = bar.Close
		result.Volume += bar.Volume
	}
	return result, result.Open > 0 && result.Low > 0 && result.High >= result.Low && result.Close > 0
}

func (s *Server) handlePanelRTHContext(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	symbol := tape.NormalizeSymbol(r.URL.Query().Get("symbol"))
	if symbol == "" {
		http.Error(w, "invalid symbol", http.StatusBadRequest)
		return
	}
	clock, mode, source, provider := s.panelClock()
	location, _ := time.LoadLocation(s.cfg.App.Timezone)
	local := clock.In(location)
	session := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	if requested := r.URL.Query().Get("session"); requested != "" {
		parsed, err := time.ParseInLocation("2006-01-02", requested, location)
		if err != nil {
			http.Error(w, "session must be YYYY-MM-DD", http.StatusBadRequest)
			return
		}
		session = parsed
	}
	throughUS := clock.UnixMicro()
	if raw := r.URL.Query().Get("through_us"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 || parsed > throughUS {
			http.Error(w, "invalid through_us", http.StatusBadRequest)
			return
		}
		throughUS = parsed
	}
	start := time.Date(session.Year(), session.Month(), session.Day(), 9, 30, 0, 0, location)
	closeTime := time.Date(session.Year(), session.Month(), session.Day(), 16, 0, 0, 0, location)
	response := panelRTHResponse{SchemaVersion: panelDataSchemaVersion, Symbol: symbol, SessionDateET: session.Format("2006-01-02"), ThroughUS: throughUS, Source: source, Provider: provider, Mode: mode, Status: "building"}
	if throughUS < start.UnixMicro() {
		response.Status = "before-open"
		writeJSON(w, http.StatusOK, response)
		return
	}
	endUS := min(throughUS, closeTime.UnixMicro()-1)
	var bars []storage.MinuteBar
	var complete bool
	var err error
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if mode == "demo" {
		low := 45.0
		last := 47.25
		response.Open, response.High, response.Low, response.LowTimeUS, response.Last, response.LastTimeUS, response.EligibleTradeCount, response.CompleteFromRTHOpen = 46, 48, low, start.Add(2*time.Minute).UnixMicro(), last, endUS, 1000, true
		if throughUS >= closeTime.UnixMicro() {
			response.Status = "closed"
		} else {
			response.Status = "ready"
		}
		writeJSON(w, http.StatusOK, response)
		return
	}
	if mode == "live" && provider == "ibkr" && s.rvolMinuteBars != nil {
		bars, err = s.rvolMinuteBars(ctx, symbol, time.UnixMicro(endUS+1), 960)
		bars = barsInside(bars, start.UnixMicro(), endUS)
		complete = err == nil
	} else if s.recorder != nil && provider != "all" {
		var stats storage.SessionTradeStats
		stats, err = s.recorder.EligibleSessionTradeStats(ctx, symbol, source, provider, start.UnixMicro(), endUS, throughUS)
		if err == nil {
			complete, err = s.recorder.HasCoverage(ctx, symbol, provider, "trades", start.UnixMicro(), endUS)
			if err == nil && !complete {
				complete, err = s.recorder.HasCoverage(ctx, symbol, provider, "minute_bars", start.UnixMicro(), endUS)
			}
			if err == nil && !complete && mode == "massive" && source == "live" {
				complete = s.symbolActiveAt(symbol) > 0 && s.symbolActiveAt(symbol) <= start.UnixMicro()
			}
		}
		if err == nil && complete && stats.Count > 0 {
			response.CompleteFromRTHOpen = true
			response.Open, response.High, response.Low, response.LowTimeUS = stats.Open, stats.High, stats.Low, stats.LowTimeUS
			response.Last, response.LastTimeUS, response.EligibleTradeCount = stats.Last, stats.LastTimeUS, stats.Count
			response.Status = "ready"
			if throughUS >= closeTime.UnixMicro() {
				response.Status = "closed"
			}
			writeJSON(w, http.StatusOK, response)
			return
		}
		if err == nil && complete {
			bars, err = s.recorder.MinuteBars(ctx, symbol, source, provider, start.UnixMicro(), endUS)
		}
	}
	if err != nil {
		response.Status, response.Message = "unavailable", err.Error()
		writeJSON(w, http.StatusOK, response)
		return
	}
	response.CompleteFromRTHOpen = complete
	if !complete {
		response.Status, response.Message = "incomplete", "session data does not reach 09:30 ET"
		writeJSON(w, http.StatusOK, response)
		return
	}
	if daily, ok := aggregateRTHBars(bars); ok {
		response.Open, response.High, response.Low, response.Last = daily.Open, daily.High, daily.Low, daily.Close
		response.LowTimeUS, response.LastTimeUS, response.EligibleTradeCount = findTimes(bars, daily.Low), bars[len(bars)-1].TimeUS, int64(len(bars))
		response.Status = "ready"
		if throughUS >= closeTime.UnixMicro() {
			response.Status = "closed"
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func findTimes(bars []storage.MinuteBar, low float64) int64 {
	for _, bar := range bars {
		if bar.Low == low {
			return bar.TimeUS
		}
	}
	return 0
}

func barsInside(bars []storage.MinuteBar, startUS, endUS int64) []storage.MinuteBar {
	result := make([]storage.MinuteBar, 0, len(bars))
	for _, bar := range bars {
		if bar.TimeUS >= startUS && bar.TimeUS <= endUS {
			result = append(result, bar)
		}
	}
	return result
}

func (s *Server) noteSymbolActive(symbol string, atUS int64) {
	s.symbolActiveMu.Lock()
	s.symbolActiveUS[symbol] = atUS
	s.symbolActiveMu.Unlock()
}

func (s *Server) symbolActiveAt(symbol string) int64 {
	s.symbolActiveMu.RLock()
	atUS := s.symbolActiveUS[symbol]
	s.symbolActiveMu.RUnlock()
	return atUS
}
