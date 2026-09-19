package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

const chartHistoryLimit = 5000

// Separate from startup/RVOL and the stream path: at most one background
// history request runs, with a pause between small, cached weekly ranges.
func (s *Server) handleChartHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host != r.Host || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			http.Error(w, "invalid origin", 403)
			return
		}
	}
	symbol := tape.NormalizeSymbol(r.URL.Query().Get("symbol"))
	if symbol == "" || symbol != s.store.Active() {
		http.Error(w, "chart changed", 409)
		return
	}
	if s.recorder == nil {
		http.Error(w, "chart history needs a recording database", 422)
		return
	}
	through := s.now().UTC().Truncate(time.Minute)
	provider := "ibkr"
	switch s.store.Status().Mode {
	case "live":
		if s.rvolMinuteBars == nil {
			http.Error(w, "live history unavailable", 422)
			return
		}
	case "massive":
		provider = "massive"
	case "replay":
		replay, ok := s.feed.(*feed.Replay)
		if !ok {
			http.Error(w, "replay unavailable", 422)
			return
		}
		status := replay.Status()
		canDownload := (status.Provider == "massive" && status.Source == "historical") ||
			(status.Provider == "ibkr" && (status.Source == "historical" || status.Source == "live"))
		if status.Symbol != symbol || !canDownload || status.PositionUS <= 0 {
			http.Error(w, "background replay history requires a specific IBKR or Massive historical provider", 422)
			return
		}
		provider = status.Provider
		through = time.UnixMicro(status.PositionUS).UTC().Truncate(time.Minute)
	default:
		http.Error(w, "history unavailable in this mode", 422)
		return
	}
	select {
	case s.chartHistorySlot <- struct{}{}:
		defer func() { <-s.chartHistorySlot }()
	default:
		w.Header().Set("Retry-After", "10")
		http.Error(w, "background history busy", 503)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Minute)
	defer cancel()
	bars, err := s.loadChartHistory(ctx, symbol, provider, through)
	if err != nil {
		// Provider errors can contain credential-bearing URLs. Never return them.
		http.Error(w, "background history unavailable; chart remains usable", 502)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"symbol": symbol, "provider": provider, "through_us": through.UnixMicro(),
		"bars": bars, "target": chartHistoryLimit, "complete": len(bars) >= chartHistoryLimit,
	})
}

func (s *Server) loadChartHistory(ctx context.Context, symbol, provider string, through time.Time) ([]storage.MinuteBar, error) {
	reader := feed.MinuteBarReader(s.rvolMinuteBars)
	var closeSession func()
	defer func() {
		if closeSession != nil {
			closeSession()
		}
	}()
	// Open a replay history connection lazily, only if cached coverage is missing,
	// and reuse it for this whole job. Live mode retains its existing connection.
	fetch := s.chartHistoryFetch
	if fetch == nil {
		fetch = func(ctx context.Context, symbol, provider string, start, end time.Time) error {
			if provider == "massive" {
				return s.fetchChartHistoryRange(ctx, symbol, provider, start, end)
			}
			if reader == nil {
				open := s.chartHistoryOpenIBKR
				if open == nil {
					open = func(ctx context.Context) (feed.MinuteBarReader, func(), error) {
						return feed.OpenIBKRMinuteHistory(ctx, s.cfg.IBKR)
					}
				}
				var err error
				reader, closeSession, err = open(ctx)
				if err != nil {
					return err
				}
			}
			return s.saveIBKRChartHistory(ctx, symbol, start, end, reader)
		}
	}
	// Walk from newest to oldest, checking coverage (including empty weekends)
	// rather than assuming that an old cached block is current and contiguous.
	end := through
	var bars []storage.MinuteBar
	for page := 0; page < 13; page++ { // bounded to 91 calendar days for sparse/new symbols
		start := end.AddDate(0, 0, -7)
		_, missing, err := s.recorder.CoverageIntervals(ctx, symbol, provider, "minute_bars", start.UnixMicro(), end.UnixMicro()-1)
		if err != nil {
			return nil, err
		}
		for _, gap := range missing {
			// A cancellation or ticker change prevents the next provider request.
			if s.store.Active() != symbol {
				return nil, fmt.Errorf("chart changed")
			}
			timer := time.NewTimer(time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
			if err := fetch(ctx, symbol, provider, time.UnixMicro(gap.StartUS), time.UnixMicro(gap.EndUS+1)); err != nil {
				return nil, err
			}
		}
		bars, err = s.recorder.RecentCachedMinuteBars(ctx, symbol, provider, through.UnixMicro(), chartHistoryLimit)
		if err != nil {
			return nil, err
		}
		// Only count candles from the verified contiguous time window.
		for len(bars) > 0 && bars[0].TimeUS < start.UnixMicro() {
			bars = bars[1:]
		}
		if len(bars) >= chartHistoryLimit {
			return bars, nil
		}
		end = start
	}
	return bars, nil
}

func (s *Server) fetchChartHistoryRange(ctx context.Context, symbol, provider string, start, end time.Time) error {
	if provider == "massive" {
		return feed.DownloadMassiveMinuteBars(ctx, s.cfg.Massive, s.recorder, feed.HistoricalOptions{
			Symbol: symbol, Start: start, End: end.Add(-time.Microsecond),
		})
	}
	return s.saveIBKRChartHistory(ctx, symbol, start, end, s.rvolMinuteBars)
}

func (s *Server) saveIBKRChartHistory(ctx context.Context, symbol string, start, end time.Time, reader feed.MinuteBarReader) error {
	if reader == nil {
		return fmt.Errorf("IBKR history unavailable")
	}
	// IBKR returns a seven-day window. An effectively unlimited result count
	// avoids marking truncated windows covered; only the requested gap is saved.
	bars, err := reader(ctx, symbol, end, 11000)
	if err != nil {
		return err
	}
	filtered := make([]storage.MinuteBar, 0, len(bars))
	for _, bar := range bars {
		if bar.TimeUS >= start.UnixMicro() && bar.TimeUS < end.UnixMicro() {
			filtered = append(filtered, bar)
		}
	}
	if err := s.recorder.UpsertMinuteBars(ctx, symbol, "ibkr", filtered); err != nil {
		return err
	}
	return s.recorder.MarkCoverage(ctx, storage.Coverage{Symbol: symbol, Provider: "ibkr", Kind: "minute_bars", StartUS: start.UnixMicro(), EndUS: end.UnixMicro() - 1, RowCount: int64(len(filtered))})
}
