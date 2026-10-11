package server

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"time"

	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

const cumulativeRVOLLookback = 5

type cumulativeRVOLPoint struct {
	TimeUS int64    `json:"time_us"`
	Ratio  *float64 `json:"ratio"`
	Up     bool     `json:"up"`
}

type cumulativeRVOLResponse struct {
	Symbol           string                `json:"symbol"`
	Provider         string                `json:"provider"`
	SessionDate      string                `json:"session_date"`
	ThroughUS        int64                 `json:"through_us"`
	Status           string                `json:"status"`
	Message          string                `json:"message"`
	BaselineSessions []string              `json:"baseline_sessions"`
	Points           []cumulativeRVOLPoint `json:"points"`
}

// Optional, background-only work. It shares the chart-history gate and cache,
// but never changes the displayed candles, the tick stream, or RVOL PACE.
func (s *Server) handleCumulativeRVOL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
			http.Error(w, "invalid origin", http.StatusForbidden)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	symbol := tape.NormalizeSymbol(r.URL.Query().Get("symbol"))
	if symbol == "" || symbol != s.store.Active() {
		http.Error(w, "chart changed", http.StatusConflict)
		return
	}
	clock, mode, _, provider := s.panelClock()
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		http.Error(w, "session timezone unavailable", http.StatusServiceUnavailable)
		return
	}
	local := clock.In(location)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	// Construct wall-clock session times explicitly (including DST boundaries).
	open := time.Date(local.Year(), local.Month(), local.Day(), 9, 30, 0, 0, location)
	closeTime := time.Date(local.Year(), local.Month(), local.Day(), 16, 0, 0, 0, location)
	through := clock.Truncate(time.Minute)
	if through.After(closeTime) {
		through = closeTime
	}
	result := cumulativeRVOLResponse{Symbol: symbol, Provider: provider, SessionDate: day.Format("2006-01-02"), ThroughUS: through.UnixMicro(), Status: "unavailable", Message: "History unavailable", BaselineSessions: []string{}, Points: []cumulativeRVOLPoint{}}
	if (mode != "live" && mode != "massive" && mode != "replay") || (provider != "ibkr" && provider != "massive") {
		result.Message = "Select an IBKR or Massive feed"
		writeJSON(w, http.StatusOK, result)
		return
	}
	if !through.After(open) || local.Weekday() == time.Saturday || local.Weekday() == time.Sunday {
		result.Status, result.Message = "before-open", "Waiting for a completed RTH minute"
		writeJSON(w, http.StatusOK, result)
		return
	}
	if s.recorder == nil {
		result.Message = "Enable the recording database for RVOL history"
		writeJSON(w, http.StatusOK, result)
		return
	}
	key := "cumulative-rvol|" + provider + "|" + symbol
	unlock, err := s.lockHistory(r.Context(), key)
	if err != nil {
		return
	}
	defer unlock()
	s.panelDataMu.Lock()
	entry, cached := s.panelDataCache[key]
	s.panelDataMu.Unlock()
	if prior, ok := entry.value.(cumulativeRVOLResponse); cached && ok && prior.ThroughUS == result.ThroughUS && (entry.ready || time.Since(entry.at) < 30*time.Second) {
		writeJSON(w, http.StatusOK, prior)
		return
	}
	select {
	case s.chartHistorySlot <- struct{}{}:
		defer func() { <-s.chartHistorySlot }()
	default:
		w.Header().Set("Retry-After", "10")
		http.Error(w, "background history busy", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	prior, today, coveredFrom, err := s.loadCumulativeRVOLHistory(ctx, symbol, provider, mode, day, open, through, location)
	if err == nil {
		result = buildCumulativeRVOL(result, prior, today, coveredFrom, open, through, location)
	}
	// Provider failures may contain credential-bearing URLs. Never expose them
	// or display an old number as the current result after a failed refresh.
	if s.store.Active() != symbol || ctx.Err() != nil {
		http.Error(w, "chart changed or history timed out", http.StatusConflict)
		return
	}
	s.panelDataMu.Lock()
	s.panelDataCache[key] = panelDataCacheEntry{value: result, at: time.Now(), ready: result.Status == "ready"}
	s.panelDataMu.Unlock()
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) loadCumulativeRVOLHistory(ctx context.Context, symbol, provider, mode string, day, open, through time.Time, location *time.Location) ([]storage.MinuteBar, []storage.MinuteBar, time.Time, error) {
	reader := feed.MinuteBarReader(s.rvolMinuteBars)
	var closeSession func()
	defer func() {
		if closeSession != nil {
			closeSession()
		}
	}()
	fetch := func(start, end time.Time) error {
		if s.store.Active() != symbol {
			return fmt.Errorf("chart changed")
		}
		timer := time.NewTimer(time.Second)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
		if s.chartHistoryFetch != nil {
			return s.chartHistoryFetch(ctx, symbol, provider, start, end)
		}
		if provider == "massive" {
			return s.fetchChartHistoryRange(ctx, symbol, provider, start, end)
		}
		if reader == nil {
			var err error
			openHistory := s.chartHistoryOpenIBKR
			if openHistory == nil {
				openHistory = func(ctx context.Context) (feed.MinuteBarReader, func(), error) {
					return feed.OpenIBKRMinuteHistory(ctx, s.cfg.IBKR)
				}
			}
			reader, closeSession, err = openHistory(ctx)
			if err != nil {
				return err
			}
		}
		selected := reader
		if mode == "live" && end.Sub(start) <= 24*time.Hour {
			if source, ok := s.feed.(interface {
				SessionMinuteBars(context.Context, string, time.Time, int) ([]storage.MinuteBar, error)
			}); ok {
				selected = source.SessionMinuteBars
			}
		}
		return s.saveIBKRChartHistory(ctx, symbol, start, end, selected)
	}
	// Refresh today's complete prefix once per minute, including revisions and
	// late aggregates. Replays reuse covered history and never query past their
	// authoritative minute boundary. Prior sessions remain cached on disk.
	covered, err := s.recorder.HasCoverage(ctx, symbol, provider, "minute_bars", open.UnixMicro(), through.UnixMicro()-1)
	if err != nil {
		return nil, nil, day, err
	}
	if !covered || mode != "replay" {
		if err := fetch(open, through); err != nil {
			return nil, nil, day, err
		}
	}
	today, err := s.recorder.CachedMinuteBars(ctx, symbol, provider, open.UnixMicro(), through.UnixMicro())
	if err != nil {
		return nil, nil, day, err
	}
	var prior []storage.MinuteBar
	end := day
	from := day
	for page := 0; page < 4; page++ { // maximum 28 calendar days, including holidays
		from = end.Add(-7 * 24 * time.Hour)
		_, missing, err := s.recorder.CoverageIntervals(ctx, symbol, provider, "minute_bars", from.UnixMicro(), end.UnixMicro()-1)
		if err != nil {
			return nil, nil, from, err
		}
		for _, gap := range missing {
			if err := fetch(time.UnixMicro(gap.StartUS), time.UnixMicro(gap.EndUS+1)); err != nil {
				return nil, nil, from, err
			}
		}
		prior, err = s.recorder.CachedMinuteBars(ctx, symbol, provider, from.UnixMicro(), day.UnixMicro())
		if err != nil {
			return nil, nil, from, err
		}
		if len(rvolSessions(prior, from, day, location)) >= cumulativeRVOLLookback {
			break
		}
		end = from
	}
	return prior, today, from, nil
}

func rvolSessions(bars []storage.MinuteBar, from, before time.Time, location *time.Location) map[string][]storage.MinuteBar {
	sessions := make(map[string][]storage.MinuteBar)
	for _, bar := range bars {
		at := time.UnixMicro(bar.TimeUS).In(location)
		open := time.Date(at.Year(), at.Month(), at.Day(), 9, 30, 0, 0, location)
		minute := at.Hour()*60 + at.Minute()
		if open.Before(from) || !at.Before(before) || at.Weekday() == time.Saturday || at.Weekday() == time.Sunday || minute < 570 || minute >= 960 {
			continue
		}
		date := at.Format("2006-01-02")
		sessions[date] = append(sessions[date], bar)
	}
	return sessions
}

func buildCumulativeRVOL(result cumulativeRVOLResponse, prior, today []storage.MinuteBar, coveredFrom, open, through time.Time, location *time.Location) cumulativeRVOLResponse {
	sessions := rvolSessions(prior, coveredFrom, open, location)
	dates := make([]string, 0, len(sessions))
	for date := range sessions {
		if date < result.SessionDate {
			dates = append(dates, date)
		}
	}
	sort.Strings(dates)
	if len(dates) < cumulativeRVOLLookback {
		result.Status, result.Message = "insufficient", fmt.Sprintf("Need 5 prior sessions (%d available)", len(dates))
		result.BaselineSessions = dates
		return result
	}
	dates = dates[len(dates)-cumulativeRVOLLookback:]
	result.BaselineSessions = dates
	baseline := [390]float64{}
	for _, date := range dates {
		volumes := [390]float64{}
		for _, bar := range sessions[date] {
			if math.IsNaN(bar.Volume) || math.IsInf(bar.Volume, 0) || bar.Volume < 0 {
				return result
			}
			at := time.UnixMicro(bar.TimeUS).In(location)
			volumes[at.Hour()*60+at.Minute()-570] = bar.Volume
		}
		total := 0.0
		for minute, volume := range volumes {
			total += volume
			baseline[minute] += total / cumulativeRVOLLookback
		}
	}
	byMinute := make(map[int64]storage.MinuteBar)
	for _, bar := range today {
		if bar.TimeUS >= open.UnixMicro() && bar.TimeUS < through.UnixMicro() {
			if math.IsNaN(bar.Volume) || math.IsInf(bar.Volume, 0) || bar.Volume < 0 {
				return result
			}
			byMinute[bar.TimeUS] = bar
		}
	}
	if len(byMinute) == 0 {
		result.Status, result.Message = "waiting", "No completed RTH volume yet"
		return result
	}
	total, up, available := 0.0, true, false
	for at, minute := open, 0; at.Before(through) && minute < 390; at, minute = at.Add(time.Minute), minute+1 {
		if bar, ok := byMinute[at.UnixMicro()]; ok {
			total += bar.Volume
			up = bar.Close >= bar.Open
		}
		point := cumulativeRVOLPoint{TimeUS: at.UnixMicro(), Up: up}
		if baseline[minute] > 0 {
			ratio := total / baseline[minute]
			point.Ratio = &ratio
			available = true
		}
		result.Points = append(result.Points, point)
	}
	if available {
		result.Status, result.Message = "ready", "Completed minutes · RTH 09:30–16:00 ET"
	} else {
		result.Status, result.Message = "insufficient", "No baseline volume at this time"
	}
	return result
}
