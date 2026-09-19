package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

func forecastTestBars(origin time.Time, count int) []storage.MinuteBar {
	bars := make([]storage.MinuteBar, count)
	for i := range bars {
		bars[i] = storage.MinuteBar{TimeUS: origin.Add(time.Duration(i-count) * time.Minute).UnixMicro(), Open: 100, High: 101, Low: 99, Close: 100, Volume: 1000}
	}
	return bars
}
func TestForecastWindowIsCompletedContiguousAndSameSession(t *testing.T) {
	origin := time.Date(2026, 9, 18, 14, 17, 0, 0, time.UTC)
	bars := forecastTestBars(origin, 240)
	// A forming bar and yesterday's data must never enter the model window.
	input := append([]storage.MinuteBar{forecastTestBars(origin.Add(-24*time.Hour), 1)[0]}, bars...)
	input = append(input, storage.MinuteBar{TimeUS: origin.UnixMicro(), Close: 9999})
	window, err := forecastWindow(input, origin, "extended")
	if err != nil || len(window) != 240 || window[239].Close != 100 {
		t.Fatalf("window=%d err=%v", len(window), err)
	}
	for name, mutate := range map[string]func([]storage.MinuteBar) []storage.MinuteBar{
		"short":           func(b []storage.MinuteBar) []storage.MinuteBar { return b[:20] },
		"stale":           func(b []storage.MinuteBar) []storage.MinuteBar { return b[:239] },
		"gap":             func(b []storage.MinuteBar) []storage.MinuteBar { return append(b[:50], b[51:]...) },
		"duplicate":       func(b []storage.MinuteBar) []storage.MinuteBar { b[50] = b[49]; return b },
		"nan":             func(b []storage.MinuteBar) []storage.MinuteBar { b[50].High = math.NaN(); return b },
		"bad-ohlc":        func(b []storage.MinuteBar) []storage.MinuteBar { b[50].Low = 102; return b },
		"negative-volume": func(b []storage.MinuteBar) []storage.MinuteBar { b[50].Volume = -1; return b },
		"unaligned":       func(b []storage.MinuteBar) []storage.MinuteBar { b[50].TimeUS++; return b },
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := forecastWindow(mutate(append([]storage.MinuteBar(nil), bars...)), origin, "extended"); err == nil {
				t.Fatal("accepted invalid history")
			}
		})
	}
	if _, err := forecastWindow(bars, origin, "regular"); err != nil {
		t.Fatal(err)
	}
	if forecastScheduled(time.Date(2026, 9, 19, 14, 0, 0, 0, time.UTC), 10, "regular") {
		t.Fatal("Saturday accepted")
	}
	if forecastScheduled(time.Date(2026, 9, 18, 19, 55, 0, 0, time.UTC), 10, "regular") {
		t.Fatal("horizon crosses close")
	}
	if !forecastScheduled(time.Date(2026, 3, 9, 13, 40, 0, 0, time.UTC), 10, "regular") {
		t.Fatal("DST session rejected")
	}
}
func TestForecastConfigURLAndKeyBoundaries(t *testing.T) {
	t.Setenv("KRONOS_API_KEY", strings.Repeat("k", 32))
	t.Setenv("KRONOS_API_KEY_FILE", "")
	t.Setenv("KRONOS_ALLOW_INSECURE_HTTP", "")
	t.Setenv("KRONOS_ENABLED", "")
	t.Setenv("KRONOS_PATHS", "")
	t.Setenv("KRONOS_SESSION", "")
	for _, v := range []string{"http://10.17.17.99:8787", "http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787", "https://forecast.example.org/kronos"} {
		t.Setenv("KRONOS_URL", v)
		c := loadForecastConfig()
		if c.Error != "" {
			t.Errorf("%s: %s", v, c.Error)
		}
	}
	for _, v := range []string{"http://public.example.com", "https://user:secret@example.com", "file:///etc/passwd", "https://example.com?key=secret", "https://example.com#x", "bad-url"} {
		t.Setenv("KRONOS_URL", v)
		if loadForecastConfig().Error == "" {
			t.Errorf("accepted unsafe URL %s", v)
		}
	}
	t.Setenv("KRONOS_URL", "https://example.com")
	t.Setenv("KRONOS_API_KEY", "")
	path := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(path, []byte(strings.Repeat("k", 32)), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KRONOS_API_KEY_FILE", path)
	if c := loadForecastConfig(); c.Error != "" || len(c.Key) != 32 {
		t.Fatalf("private key: %+v", c)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if loadForecastConfig().Error == "" {
		t.Fatal("accepted readable key file")
	}
}
func TestForecastSameOriginProtection(t *testing.T) {
	for _, origin := range []string{"http://example.com", "http://example.com.evil", "http://evil/?url=//example.com", "null", "https://example.com"} {
		r := httptest.NewRequest("POST", "http://example.com/api/forecast", nil)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Tape-Forecast", "1")
		r.Header.Set("Origin", origin)
		want := origin == "http://example.com"
		if forecastSameOrigin(r) != want {
			t.Errorf("origin %s accepted=%v", origin, !want)
		}
	}
	r := httptest.NewRequest("POST", "http://localhost/api/forecast", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Tape-Forecast", "1")
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	if forecastSameOrigin(r) {
		t.Fatal("cross-site accepted")
	}
	r.Header.Del("Sec-Fetch-Site")
	r.Header.Del("X-Tape-Forecast")
	if forecastSameOrigin(r) {
		t.Fatal("simple request accepted")
	}
}
func mockForecastWire(input map[string]any) []byte {
	bars := input["bars"].([]any)
	last := bars[len(bars)-1].(map[string]any)
	lastTime, _ := time.Parse(time.RFC3339, last["timestamp"].(string))
	// Identity fixture only. Full statistical contracts are checked in JS and
	// against the real Pydantic launcher fixture by the Python contract check.
	b, _ := json.Marshal(map[string]any{"schema_version": "1.0", "symbol": input["symbol"], "request_id": input["request_id"], "model_id": "kronos-base", "mode": "live",
		"forecast_origin": lastTime.Add(time.Minute), "reference_price": last["close"], "reference_kind": "last_closed_close", "paths_attempted": 32, "bar_seconds": 60, "status": "ok",
		"horizons": map[string]any{"1": map[string]any{}, "3": map[string]any{}, "5": map[string]any{}, "10": map[string]any{}}})
	return b
}
func forecastTestServer(t *testing.T, remote string, now time.Time) *Server {
	t.Helper()
	store := tape.NewStore("QQQ", 100, 4)
	store.SetStatus(tape.FeedStatus{Mode: "live", State: "live", Connected: true})
	s := New(config.Defaults(), store, &stubFeed{})
	s.forecast.cancel()
	s.forecast = newForecastService(forecastConfig{Enabled: true, URL: remote, Key: strings.Repeat("k", 32), Paths: 32, Session: "extended"})
	s.now = func() time.Time { return now }
	s.rvolMinuteBars = func(context.Context, string, time.Time, int) ([]storage.MinuteBar, error) {
		return forecastTestBars(now.Truncate(time.Minute), 240), nil
	}
	t.Cleanup(s.forecast.cancel)
	return s
}
func postForecast(s *Server, symbol string) (forecastReply, int) {
	r := httptest.NewRequest("POST", "http://localhost/api/forecast", strings.NewReader(`{"symbol":"`+symbol+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Tape-Forecast", "1")
	w := httptest.NewRecorder()
	s.handleForecast(w, r)
	var reply forecastReply
	_ = json.Unmarshal(w.Body.Bytes(), &reply)
	return reply, w.Code
}
func waitForecast(t *testing.T, s *Server) forecastReply {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, code := postForecast(s, "QQQ")
		if code != 200 {
			t.Fatalf("status %d", code)
		}
		if r.State != "running" {
			return r
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("forecast did not settle")
	return forecastReply{}
}
func TestForecastProxyDedupeAuthAndCanonicalRequest(t *testing.T) {
	var calls atomic.Int32
	seen := make(chan map[string]any, 1)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ready" {
			_, _ = io.WriteString(w, `{"ready":true}`)
			return
		}
		if r.URL.Path != "/v1/forecast" {
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("k", 32) {
			t.Error("missing private bearer")
		}
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		seen <- input
		_, _ = w.Write(mockForecastWire(input))
	}))
	defer remote.Close()
	s := forecastTestServer(t, remote.URL, time.Date(2026, 9, 18, 14, 17, 2, 0, time.UTC))
	if r, _ := postForecast(s, "QQQ"); r.State != "running" {
		t.Fatalf("initial state %s", r.State)
	}
	final := waitForecast(t, s)
	if final.State != "forecast" {
		t.Fatalf("%+v", final)
	}
	for i := 0; i < 10; i++ {
		postForecast(s, "QQQ")
	}
	if calls.Load() != 1 {
		t.Fatalf("duplicate inference calls %d", calls.Load())
	}
	input := <-seen
	if input["as_of"] != "2026-09-18T14:17:02Z" || input["mode"] != "live" {
		t.Fatalf("bad clock/mode %v", input)
	}
	future := input["future_bar_timestamps"].([]any)
	if future[0] != "2026-09-18T14:17:00Z" || future[9] != "2026-09-18T14:26:00Z" {
		t.Fatal(future)
	}
	options := input["options"].(map[string]any)
	if options["allow_stale_research"] != true {
		t.Fatal("mid-minute requests must opt into Spark's extended origin window")
	}
	if bytes.Contains(final.Result, []byte(strings.Repeat("k", 32))) {
		t.Fatal("bearer in response")
	}
	if _, code := postForecast(s, "AAPL"); code != 409 {
		t.Fatal("accepted inactive symbol")
	}
	if len(input["bars"].([]any)) != 240 {
		t.Fatal("context wrong")
	}
}
func TestForecastDoesNotLaunchForReplayOrMissingKey(t *testing.T) {
	s := forecastTestServer(t, "http://127.0.0.1:1", time.Date(2026, 9, 18, 14, 17, 20, 0, time.UTC))
	s.store.SetStatus(tape.FeedStatus{Mode: "replay", Connected: true})
	if r, _ := postForecast(s, "QQQ"); r.State != "unsupported_mode" {
		t.Fatal(r)
	}
	s.forecast.config.Key = ""
	if r, _ := postForecast(s, "QQQ"); r.State != "key_required" {
		t.Fatal(r)
	}
}
func TestForecastStartsImmediatelyThroughoutMinute(t *testing.T) {
	for _, second := range []int{0, 20, 59} {
		t.Run(time.Duration(second*int(time.Second)).String(), func(t *testing.T) {
			var calls atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/ready" {
					_, _ = io.WriteString(w, `{"ready":true}`)
					return
				}
				calls.Add(1)
				var input map[string]any
				_ = json.NewDecoder(r.Body).Decode(&input)
				if input["options"].(map[string]any)["allow_stale_research"] != true {
					t.Error("Spark mid-minute permission missing")
				}
				_, _ = w.Write(mockForecastWire(input))
			}))
			defer remote.Close()
			s := forecastTestServer(t, remote.URL, time.Date(2026, 9, 18, 14, 17, second, 0, time.UTC))
			if r, _ := postForecast(s, "QQQ"); r.State != "running" {
				t.Fatalf("did not start immediately: %+v", r)
			}
			if r := waitForecast(t, s); r.State != "forecast" {
				t.Fatal(r)
			}
			postForecast(s, "QQQ")
			if calls.Load() != 1 {
				t.Fatal("same-minute forecast was resampled")
			}
		})
	}
}

func TestForecastRetriesIncompleteHistoryWithoutWaitingForNextMinute(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ready" {
			_, _ = io.WriteString(w, `{"ready":true}`)
			return
		}
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		_, _ = w.Write(mockForecastWire(input))
	}))
	defer remote.Close()
	origin := time.Date(2026, 9, 18, 14, 17, 0, 0, time.UTC)
	s := forecastTestServer(t, remote.URL, origin)
	var clock atomic.Int64
	clock.Store(origin.UnixNano())
	s.now = func() time.Time { return time.Unix(0, clock.Load()) }
	var historyCalls atomic.Int32
	s.rvolMinuteBars = func(context.Context, string, time.Time, int) ([]storage.MinuteBar, error) {
		bars := forecastTestBars(origin, 240)
		if historyCalls.Add(1) == 1 {
			return bars[:239], nil
		}
		return bars, nil
	}
	postForecast(s, "QQQ")
	if r := waitForecast(t, s); r.State != "input_unavailable" {
		t.Fatal(r)
	}
	clock.Store(origin.Add(5 * time.Second).UnixNano())
	postForecast(s, "QQQ")
	if r := waitForecast(t, s); r.State != "forecast" {
		t.Fatal(r)
	}
	if historyCalls.Load() != 2 {
		t.Fatal("incomplete history was not refreshed")
	}
}

func TestForecastAbortDoesNotReleaseBackendWork(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ready" {
			_, _ = io.WriteString(w, `{"ready":true}`)
			return
		}
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		close(entered)
		<-release
		_, _ = w.Write(mockForecastWire(input))
	}))
	defer remote.Close()
	s := forecastTestServer(t, remote.URL, time.Date(2026, 9, 18, 14, 17, 2, 0, time.UTC))
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("POST", "http://localhost/api/forecast", strings.NewReader(`{"symbol":"QQQ"}`)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Tape-Forecast", "1")
	s.handleForecast(httptest.NewRecorder(), r)
	cancel()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("worker did not start")
	}
	s.forecast.mu.Lock()
	busy := s.forecast.busy
	s.forecast.mu.Unlock()
	if !busy {
		t.Error("browser cancel freed in-flight work")
	}
	if reply, _ := postForecast(s, "QQQ"); reply.State != "running" {
		t.Error(reply)
	}
	close(release)
	if reply := waitForecast(t, s); reply.State != "forecast" {
		t.Fatal(reply)
	}
}
func TestForecastProxyNeverFollowsRedirectWithKey(t *testing.T) {
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer target.Close()
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer remote.Close()
	f := newForecastService(forecastConfig{URL: remote.URL, Key: strings.Repeat("k", 32)})
	defer f.cancel()
	_, code, err := f.call(context.Background(), "POST", "/v1/forecast", []byte(`{}`))
	if err != nil || code != 307 || leaked.Load() {
		t.Fatalf("redirect %d %v leaked=%v", code, err, leaked.Load())
	}
}
