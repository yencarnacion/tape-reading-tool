package server

// The forecasting boundary is deliberately separate from the feed and order
// interfaces. Only server-owned, completed market-minute history goes upstream.
import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

const forecastMinuteUS = int64(time.Minute / time.Microsecond)

type forecastConfig struct {
	URL, Key, Session, Error string
	Paths                    int
	Enabled                  bool
}

// Configuration is operator-owned, loaded once after .env, never accepted from
// a browser. In particular, this endpoint is NOT an arbitrary URL proxy.
func loadForecastConfig() forecastConfig {
	c := forecastConfig{URL: "http://10.17.17.99:8787", Paths: 32, Session: "extended", Enabled: true}
	if v := os.Getenv("KRONOS_ENABLED"); v != "" {
		b, e := strconv.ParseBool(v)
		if e != nil {
			c.Error = "KRONOS_ENABLED must be true or false"
		}
		c.Enabled = b
	}
	if v := strings.TrimSpace(os.Getenv("KRONOS_URL")); v != "" {
		c.URL = strings.TrimRight(v, "/")
	}
	u, e := url.Parse(c.URL)
	if e != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		c.Error = "KRONOS_URL must be an HTTP(S) base URL without credentials, query, or fragment"
	} else if u.Scheme == "http" {
		ip := net.ParseIP(u.Hostname())
		local := strings.EqualFold(u.Hostname(), "localhost") || (ip != nil && (ip.IsLoopback() || ip.IsPrivate()))
		if !local && os.Getenv("KRONOS_ALLOW_INSECURE_HTTP") != "true" {
			c.Error = "Use HTTPS for a domain/public server, or explicitly allow insecure HTTP"
		}
	}
	if v := os.Getenv("KRONOS_PATHS"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 8 || n > 128 {
			c.Error = "KRONOS_PATHS must be 8 through 128"
		} else {
			c.Paths = n
		}
	}
	if v := os.Getenv("KRONOS_SESSION"); v != "" {
		c.Session = v
	}
	if c.Session != "regular" && c.Session != "extended" {
		c.Error = "KRONOS_SESSION must be regular or extended"
	}
	c.Key = strings.TrimSpace(os.Getenv("KRONOS_API_KEY"))
	if c.Key == "" {
		path := os.Getenv("KRONOS_API_KEY_FILE")
		explicit := path != ""
		home, _ := os.UserHomeDir()
		if !explicit {
			path = filepath.Join(home, ".config", "tape-reading-tool", "kronos-api-key")
		}
		if strings.HasPrefix(path, "~/") {
			path = filepath.Join(home, path[2:])
		}
		stat, err := os.Stat(path)
		if err == nil {
			if !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 4096 {
				c.Error = "Kronos key file must be a private regular file (chmod 600), at most 4096 bytes"
			} else if b, err := os.ReadFile(path); err == nil {
				c.Key = strings.TrimSpace(string(b))
			} else {
				c.Error = "Cannot read Kronos key file"
			}
		} else if explicit {
			c.Error = "Cannot read KRONOS_API_KEY_FILE"
		}
	}
	if c.Key != "" && (len(c.Key) < 32 || len(c.Key) > 1024 || strings.ContainsAny(c.Key, "\r\n")) {
		c.Error = "Kronos bearer key must be 32–1024 characters without line breaks"
	}
	return c
}

type forecastReply struct {
	State      string          `json:"state"`
	Message    string          `json:"message"`
	Symbol     string          `json:"symbol"`
	Generation uint64          `json:"generation"`
	OriginUS   int64           `json:"origin_us"`
	ClockUS    int64           `json:"clock_us"`
	Result     json.RawMessage `json:"result,omitempty"`
}

type forecastService struct {
	mu       sync.Mutex
	config   forecastConfig
	client   *http.Client
	entries  map[string]forecastReply
	order    []string
	busy     bool
	cooldown time.Time
	nonce    string
	ctx      context.Context
	cancel   context.CancelFunc
}

func newForecastService(c forecastConfig) *forecastService {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil // Do not route LAN bearer traffic through an ambient proxy.
	transport.DialContext = (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 5 * time.Second
	transport.ResponseHeaderTimeout = 125 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		cancel()
		c.Error = "Cannot initialize forecast request identity"
	}
	return &forecastService{config: c, client: &http.Client{Transport: transport, Timeout: 130 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		entries: make(map[string]forecastReply), nonce: hex.EncodeToString(nonce), ctx: ctx, cancel: cancel}
}

// Strict origin equality, not substring matching. JSON + custom header prevents
// cross-site forms; Sec-Fetch-Site also rejects same-site, cross-origin pages.
func forecastSameOrigin(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		if err != nil || u.User != nil || u.Scheme != scheme || !strings.EqualFold(u.Host, r.Host) || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return false
		}
	}
	return r.Header.Get("X-Tape-Forecast") == "1" && strings.Split(r.Header.Get("Content-Type"), ";")[0] == "application/json"
}

func (s *Server) handleForecast(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "POST required", 405)
		return
	}
	if !forecastSameOrigin(r) {
		http.Error(w, "same-origin JSON request required", 403)
		return
	}
	defer r.Body.Close()
	var input struct {
		Symbol string `json:"symbol"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&input); err != nil {
		http.Error(w, "invalid forecast request", 400)
		return
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		http.Error(w, "one JSON object required", 400)
		return
	}
	symbol := tape.NormalizeSymbol(input.Symbol)
	if symbol == "" || symbol != s.store.Active() {
		http.Error(w, "forecast symbol is not the active symbol", 409)
		return
	}
	snap := s.store.Snapshot(symbol, 1)
	now := s.now().UTC()
	origin := now.Truncate(time.Minute)
	reply := forecastReply{Symbol: symbol, Generation: snap.Generation, OriginUS: origin.UnixMicro(), ClockUS: now.UnixMicro()}
	finish := func(state, message string) { reply.State = state; reply.Message = message; writeJSON(w, 200, reply) }
	f := s.forecast
	if f == nil {
		finish("disabled", "Forecasting is not configured")
		return
	}
	c := f.config
	if !c.Enabled {
		finish("disabled", "Forecasting disabled by the operator")
		return
	}
	if c.Error != "" {
		finish("configuration", c.Error)
		return
	}
	if c.Key == "" {
		finish("key_required", "Set KRONOS_API_KEY_FILE on the tape backend, then restart it")
		return
	}
	// Do not label receipt-time reconstruction, demo prints, or replay history as
	// causally available live market bars. Those adapters need separate qualification.
	if snap.Status.Mode != "live" || s.rvolMinuteBars == nil {
		finish("unsupported_mode", "Automatic forecasting currently requires the IBKR live minute-history adapter")
		return
	}
	if !snap.Status.Connected {
		finish("feed_offline", "Waiting for the live market-data connection")
		return
	}
	if s.cfg.IBKR.MarketDataType != 1 {
		finish("delayed_feed", "Forecasting requires real-time market data (market_data_type: 1)")
		return
	}
	if !forecastScheduled(origin, 10, c.Session) {
		finish("outside_session", "Waiting for an eligible trading-session minute")
		return
	}
	key := fmt.Sprintf("%s:%d:%d", symbol, snap.Generation, origin.UnixMicro())
	f.mu.Lock()
	if cached, ok := f.entries[key]; ok {
		retryHistory := (cached.State == "history_unavailable" || cached.State == "input_unavailable") && now.UnixMicro()-cached.ClockUS >= (5*time.Second).Microseconds()
		if !retryHistory {
			cached.ClockUS = now.UnixMicro()
			f.mu.Unlock()
			writeJSON(w, 200, cached)
			return
		}
		delete(f.entries, key)
		for i, old := range f.order {
			if old == key {
				f.order = append(f.order[:i], f.order[i+1:]...)
				break
			}
		}
	}
	if f.busy || now.Before(f.cooldown) {
		f.mu.Unlock()
		finish("busy", "Kronos is finishing earlier work; no new request queued")
		return
	}
	// Start immediately with the latest completed minute, even mid-minute.
	// The reference and future grid remain anchored to that candle's close.
	reply.State, reply.Message = "running", "Generating model paths"
	f.entries[key] = reply
	f.order = append(f.order, key)
	if len(f.order) > 16 {
		delete(f.entries, f.order[0])
		f.order = f.order[1:]
	}
	f.busy = true
	f.mu.Unlock()
	// Lifetime is owned by the backend, not by a browser HTTP connection. A symbol
	// switch/abort cannot release the in-flight slot while GPU work still runs.
	go s.runForecast(key, reply, origin)
	writeJSON(w, 200, reply)
}

// A conservative clock gate only. The upstream's pinned XNYS calendar is the
// authority for holidays and early closes; its rejection is never overridden.
// A schedule cannot promise absence of future halts.
func forecastScheduled(origin time.Time, horizon int, session string) bool {
	et, err := time.LoadLocation("America/New_York")
	if err != nil {
		return false
	}
	local := origin.In(et)
	if local.Weekday() == time.Saturday || local.Weekday() == time.Sunday {
		return false
	}
	minute := local.Hour()*60 + local.Minute()
	start, end := 9*60+30, 16*60
	if session == "extended" {
		start, end = 4*60, 20*60
	}
	return minute > start && minute+horizon <= end
}

func (s *Server) completedForecastBars(ctx context.Context, symbol string, origin time.Time) ([]storage.MinuteBar, error) {
	// Reuse the core RVOL history cache and provider connection. No new feed,
	// subscription, alternate provider, or browser-generated candles.
	s.rvolMu.Lock()
	defer s.rvolMu.Unlock()
	if entry, ok := s.rvolCache[symbol]; ok && entry.throughUS == origin.UnixMicro() {
		return append([]storage.MinuteBar(nil), entry.bars...), nil
	}
	limit := 960
	if s.liveXtra {
		limit = 2200
	}
	bars, err := s.rvolMinuteBars(ctx, symbol, origin, limit)
	if err != nil {
		return nil, err
	}
	s.rvolCache[symbol] = rvolHistoryCache{throughUS: origin.UnixMicro(), bars: append([]storage.MinuteBar(nil), bars...)}
	return bars, nil
}

type forecastBar struct {
	Timestamp string  `json:"timestamp"`
	Open      float64 `json:"open"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Close     float64 `json:"close"`
	Volume    float64 `json:"volume"`
}

func forecastWindow(bars []storage.MinuteBar, origin time.Time, session string) ([]forecastBar, error) {
	et, err := time.LoadLocation("America/New_York")
	if err != nil {
		return nil, err
	}
	day := origin.In(et).Format("2006-01-02")
	start := 9*60 + 30
	if session == "extended" {
		start = 4 * 60
	}
	selected := make([]storage.MinuteBar, 0, 240)
	for _, b := range bars {
		t := time.UnixMicro(b.TimeUS).In(et)
		if b.TimeUS >= origin.UnixMicro() || t.Format("2006-01-02") != day || t.Hour()*60+t.Minute() < start {
			continue
		}
		selected = append(selected, b)
	}
	if len(selected) > 240 {
		selected = selected[len(selected)-240:]
	}
	if len(selected) < 32 {
		return nil, fmt.Errorf("Need at least 32 completed same-session bars; available %d (target 240)", len(selected))
	}
	if selected[len(selected)-1].TimeUS+forecastMinuteUS != origin.UnixMicro() {
		return nil, errors.New("Latest market-minute bar is not yet available; no stale-data fallback")
	}
	result := make([]forecastBar, 0, len(selected))
	for i, b := range selected {
		if b.TimeUS%forecastMinuteUS != 0 || (i > 0 && b.TimeUS-selected[i-1].TimeUS != forecastMinuteUS) {
			return nil, errors.New("History has a missing, duplicate, or out-of-order minute; no padding")
		}
		values := []float64{b.Open, b.High, b.Low, b.Close, b.Volume}
		for j, v := range values {
			if math.IsNaN(v) || math.IsInf(v, 0) || (j < 4 && v <= 0) || v < 0 {
				return nil, errors.New("History contains invalid price or volume values")
			}
		}
		if b.Low > math.Min(b.Open, b.Close) || b.High < math.Max(b.Open, b.Close) {
			return nil, errors.New("History contains invalid OHLC ordering")
		}
		result = append(result, forecastBar{time.UnixMicro(b.TimeUS).UTC().Format(time.RFC3339), b.Open, b.High, b.Low, b.Close, b.Volume})
	}
	return result, nil
}

func forecastPayload(symbol, requestID string, origin, asOf time.Time, bars []forecastBar, c forecastConfig) map[string]any {
	future := make([]string, 10)
	for i := range future {
		future[i] = origin.Add(time.Duration(i) * time.Minute).Format(time.RFC3339)
	}
	return map[string]any{
		"schema_version": "1.0", "request_id": requestID, "model_id": "kronos-base", "symbol": symbol, "mode": "live",
		"as_of": asOf.Format(time.RFC3339Nano), "bar_seconds": 60, "timezone": "America/New_York", "timestamp_semantics": "bar_open",
		"calendar": "XNYS", "session_policy": c.Session,
		"source": map[string]any{"provider": "ibkr_completed_TRADES_minutes", "price_adjustment": "unadjusted", "finalized": true,
			"volume_unit": "shares", "amount_unit": "USD", "availability": "as_of_snapshot", "future_session_confirmed": true},
		"bars": bars, "future_bar_timestamps": future, "horizons_bars": []int{1, 3, 5, 10},
		"reference": map[string]any{"kind": "last_closed_close"},
		"sampling":  map[string]any{"paths": c.Paths, "temperature": 1.0, "top_p": 1.0, "top_k": 0},
		"events":    map[string]any{"terminal_thresholds_bps": []float64{10, -10}, "reach_thresholds_bps": []float64{}},
		// Spark defaults to a 10-second origin window. Explicitly allow a
		// mid-minute start; runForecast still requires the current minute origin.
		"options": map[string]any{"raw_paths": false, "allow_stale_research": true, "invalid_output_policy": "unknown_no_repair_v1"},
	}
}

func (f *forecastService) call(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, f.config.URL+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, errors.New("invalid configured service URL")
	}
	if path != "/ready" {
		req.Header.Set("Authorization", "Bearer "+f.config.Key)
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := f.client.Do(req)
	if err != nil {
		return nil, 0, errors.New("Kronos connection failed or timed out")
	} // Never echo a transport URL/header.
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(data) > 2<<20 {
		return nil, response.StatusCode, errors.New("Kronos response is unreadable or too large")
	}
	return data, response.StatusCode, nil
}

func (s *Server) runForecast(key string, reply forecastReply, origin time.Time) {
	f := s.forecast
	uncertain := false
	defer func() {
		if recover() != nil {
			reply.State = "error"
			reply.Message = "Forecast worker failed; tape continues"
			uncertain = true
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.entries[key] = reply
		f.busy = false
		// A failed connection after POST does not prove remote GPU work stopped.
		if uncertain {
			f.cooldown = time.Now().Add(135 * time.Second)
		}
	}()
	fail := func(state, message string) { reply.State = state; reply.Message = message }
	ctx, cancel := context.WithTimeout(f.ctx, 135*time.Second)
	defer cancel()
	readyCtx, readyCancel := context.WithTimeout(ctx, 3*time.Second)
	data, status, err := f.call(readyCtx, "GET", "/ready", nil)
	readyCancel()
	if err != nil {
		fail("offline", "Kronos is unreachable from the tape backend")
		return
	}
	var ready struct {
		Ready bool `json:"ready"`
	}
	if status != 200 || json.Unmarshal(data, &ready) != nil || !ready.Ready {
		fail("not_ready", "Kronos is alive but has not passed model readiness")
		return
	}
	historyCtx, historyCancel := context.WithTimeout(ctx, 6*time.Second)
	bars, err := s.completedForecastBars(historyCtx, reply.Symbol, origin)
	historyCancel()
	if err != nil {
		fail("history_unavailable", "Completed market-minute history is unavailable")
		return
	}
	window, err := forecastWindow(bars, origin, f.config.Session)
	if err != nil {
		// An early poll may precede IBKR finalization. Fetch history again on
		// the next retry rather than retaining an incomplete minute in cache.
		s.rvolMu.Lock()
		if entry, ok := s.rvolCache[reply.Symbol]; ok && entry.throughUS == origin.UnixMicro() {
			delete(s.rvolCache, reply.Symbol)
		}
		s.rvolMu.Unlock()
		fail("input_unavailable", err.Error())
		return
	}
	snap := s.store.Snapshot(reply.Symbol, 1)
	if s.store.Active() != reply.Symbol || snap.Generation != reply.Generation || snap.Status.Mode != "live" || !snap.Status.Connected {
		fail("superseded", "Symbol or data generation changed before inference")
		return
	}
	now := s.now().UTC()
	if now.Sub(origin) >= time.Minute || now.Before(origin) {
		fail("late_input", "A newer completed minute is available; updating forecast input")
		return
	}
	hash := sha256.Sum256([]byte(f.nonce + ":" + key))
	requestID := "tape-v1." + hex.EncodeToString(hash[:])
	body, err := json.Marshal(forecastPayload(reply.Symbol, requestID, origin, now, window, f.config))
	if err != nil {
		fail("input_invalid", "Could not encode numerical candles")
		return
	}
	data, status, err = f.call(ctx, "POST", "/v1/forecast", body)
	if err != nil {
		uncertain = true
		fail("offline", "Forecast transport failed; waiting for outstanding work to expire")
		return
	}
	if status != 200 {
		switch status {
		case 401, 403:
			fail("key_rejected", "Kronos rejected the server-side API key")
		case 422:
			fail("input_rejected", "Kronos rejected the input/session/profile; inspect its server log")
		case 429:
			fail("busy", "Kronos queue is full; this origin will not be resampled")
		case 503:
			fail("not_ready", "Kronos model is not ready")
		default:
			uncertain = true
			fail("service_error", fmt.Sprintf("Kronos returned HTTP %d; no replacement forecast generated", status))
		}
		return
	}
	if err := validateForecastReply(data, reply.Symbol, requestID, origin, f.config.Paths, window[len(window)-1].Close); err != nil {
		fail("invalid_response", err.Error())
		return
	}
	reply.State = "forecast"
	reply.Message = "Uncalibrated model-generated frequencies, not trading or fill odds"
	reply.Result = data
}

func validateForecastReply(data []byte, symbol, requestID string, origin time.Time, paths int, ref float64) error {
	var r struct {
		Schema    string                     `json:"schema_version"`
		Symbol    string                     `json:"symbol"`
		RequestID string                     `json:"request_id"`
		Model     string                     `json:"model_id"`
		Mode      string                     `json:"mode"`
		Origin    time.Time                  `json:"forecast_origin"`
		Reference float64                    `json:"reference_price"`
		Kind      string                     `json:"reference_kind"`
		Paths     int                        `json:"paths_attempted"`
		Horizons  map[string]json.RawMessage `json:"horizons"`
		Status    string                     `json:"status"`
		Seconds   int                        `json:"bar_seconds"`
	}
	if json.Unmarshal(data, &r) != nil || r.Schema != "1.0" || r.Symbol != symbol || r.RequestID != requestID || r.Model != "kronos-base" || r.Mode != "live" || !r.Origin.Equal(origin) || r.Reference != ref || r.Kind != "last_closed_close" || r.Paths != paths || r.Seconds != 60 {
		return errors.New("Kronos response identity or numerical contract did not match the request")
	}
	if r.Status != "ok" && r.Status != "late" && r.Status != "invalid_output" {
		return errors.New("Unsupported Kronos result status")
	}
	for _, h := range []string{"1", "3", "5", "10"} {
		if len(r.Horizons[h]) == 0 || string(r.Horizons[h]) == "null" {
			return errors.New("Kronos response is missing a requested horizon")
		}
	}
	return nil
}
