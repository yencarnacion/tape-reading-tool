package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

const minuteUS = int64(time.Minute / time.Microsecond)

// externalFixture builds a replay-mode server over a database that already has
// complete coverage for two symbols, which is the state a controller requires.
type externalFixture struct {
	server   *Server
	store    *tape.Store
	replay   *feed.Replay
	database *storage.Database
	baseUS   int64
}

// newExternalFixture builds the server. skipCoverage names data kinds whose
// completed-download record is deliberately withheld for AAPL, which is how an
// incomplete-data cue is exercised without deleting rows behind the API.
func newExternalFixture(t *testing.T, mutate func(*config.Config), skipCoverage ...string) *externalFixture {
	t.Helper()
	withheld := make(map[string]bool, len(skipCoverage))
	for _, kind := range skipCoverage {
		withheld[kind] = true
	}
	cfg := config.Defaults()
	cfg.Storage.Path = filepath.Join(t.TempDir(), "tape.db")
	cfg.Storage.FlushInterval = "5ms"
	cfg.ExternalReplay.Enabled = true
	cfg.ExternalReplay.DefaultWarmup = "60s"
	if mutate != nil {
		mutate(&cfg)
	}
	database, err := storage.Open(cfg.Storage)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })

	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 7, 2, 9, 30, 0, 0, location).UnixMicro()
	ctx := context.Background()
	for _, symbol := range []string{"AAPL", "NVDA"} {
		price := 100.0
		if symbol == "NVDA" {
			price = 500.0
		}
		trades := make([]storage.TradeRecord, 0, 60)
		quotes := make([]storage.QuoteRecord, 0, 60)
		bars := make([]storage.MinuteBar, 0, 10)
		for i := range 60 {
			at := base + int64(i)*int64(time.Second/time.Microsecond)
			trades = append(trades, storage.TradeRecord{
				Symbol: symbol, EventUS: at, MarketTimeUS: at, ExchangeTimeMS: at / 1000,
				Price: price + float64(i)*0.01, Size: 100, Class: tape.AtAsk, Side: 1,
				Source: "historical", Provider: "massive",
			})
			quotes = append(quotes, storage.QuoteRecord{
				Symbol: symbol, EventUS: at, Bid: price - 0.01, Ask: price + 0.01,
				BidSize: 10, AskSize: 10, Source: "historical", Provider: "massive",
			})
		}
		for i := range 10 {
			bars = append(bars, storage.MinuteBar{
				TimeUS: base - int64(10-i)*minuteUS, Open: price, High: price + 1, Low: price - 1,
				Close: price, Volume: 1000, DollarVolume: price * 1000,
			})
		}
		if err := database.InsertTrades(ctx, trades); err != nil {
			t.Fatal(err)
		}
		if err := database.InsertQuotes(ctx, quotes); err != nil {
			t.Fatal(err)
		}
		if err := database.UpsertMinuteBars(ctx, symbol, "massive", bars); err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"minute_bars", "trades", "quotes"} {
			if symbol == "AAPL" && withheld[kind] {
				continue
			}
			if err := database.MarkCoverage(ctx, storage.Coverage{
				Symbol: symbol, Provider: "massive", Kind: kind,
				StartUS: base - 20*minuteUS, EndUS: base + 20*minuteUS, RowCount: 60,
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	// The asynchronous writer must land before replay reads the rows back.
	waitForTrades(t, database, "AAPL", base, base+60*int64(time.Second/time.Microsecond), 60)
	waitForTrades(t, database, "NVDA", base, base+60*int64(time.Second/time.Microsecond), 60)

	store := tape.NewStore("AAPL", cfg.Tape.RingSize, cfg.Tape.HistorySize)
	replay := feed.NewReplay(database, store, "historical", "massive", 1)
	server := New(cfg, store, replay)
	server.SetMode("replay")
	server.AttachRecorder(database)
	return &externalFixture{server: server, store: store, replay: replay, database: database, baseUS: base}
}

func waitForTrades(t *testing.T, database *storage.Database, symbol string, startUS, endUS int64, want int64) {
	t.Helper()
	for range 200 {
		dataRange, err := database.DataRange(context.Background(), symbol, "historical", "massive")
		if err != nil {
			t.Fatal(err)
		}
		if dataRange.Trades >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("recorded trades for %s never reached %d", symbol, want)
}

func (f *externalFixture) control(t *testing.T, body map[string]any, headers map[string]string, remote string) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/external-replay/control", bytes.NewReader(encoded))
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	// httptest defaults to a TEST-NET address, which the loopback policy rejects.
	if remote == "" {
		remote = "127.0.0.1:54321"
	}
	request.RemoteAddr = remote
	response := httptest.NewRecorder()
	f.server.handleExternalReplayControl(response, request)
	return response
}

func (f *externalFixture) status(t *testing.T) map[string]any {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/external-replay/status", nil)
	request.RemoteAddr = "127.0.0.1:54321"
	response := httptest.NewRecorder()
	f.server.handleExternalReplayStatus(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func (f *externalFixture) controlState(t *testing.T) map[string]any {
	t.Helper()
	control, _ := f.status(t)["control"].(map[string]any)
	return control
}

func (f *externalFixture) cue(symbol string, sequence uint64, targetOffset time.Duration, playing bool, speed float64) map[string]any {
	target := f.baseUS + int64(targetOffset/time.Microsecond)
	return map[string]any{
		"protocol_version": 1, "controller_id": "local-review-controller",
		"controller_session_id": "session-a", "sequence": sequence, "action": "cue",
		"symbol": symbol, "source": "historical", "provider": "massive",
		"target_us": target, "warmup_start_us": f.baseUS, "range_end_us": f.baseUS + 60*int64(time.Second/time.Microsecond),
		"playing": playing, "speed": speed,
	}
}

func TestCueInReplayModeReconstructsThroughTheTarget(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	response := fixture.control(t, fixture.cue("AAPL", 1, 10*time.Second, false, 1), nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("cue = %d: %s", response.Code, response.Body.String())
	}
	snapshot := fixture.store.Snapshot("AAPL", 0)
	if len(snapshot.Trades) != 11 {
		t.Fatalf("reconstruction must stop at the target: %d trades", len(snapshot.Trades))
	}
	last := snapshot.Trades[len(snapshot.Trades)-1]
	if last.ExchangeTimeMS > (fixture.baseUS+10*int64(time.Second/time.Microsecond))/1000 {
		t.Fatalf("a trade after the target was published: %+v", last)
	}
	if snapshot.Quote.Bid <= 0 || snapshot.Quote.Ask <= 0 {
		t.Fatalf("quotes were not reconstructed: %+v", snapshot.Quote)
	}
	control := fixture.controlState(t)
	if control["state"] != externalStatePaused || control["attached"] != true {
		t.Fatalf("control = %+v", control)
	}
	if control["symbol"] != "AAPL" || control["sequence"].(float64) != 1 {
		t.Fatalf("control = %+v", control)
	}
	if control["last_cue_rows"].(float64) <= 0 || control["cues"].(float64) != 1 {
		t.Fatalf("diagnostics missing: %+v", control)
	}
	if fixture.replay.Status().State != "paused" {
		t.Fatalf("a cue with playing=false must stay paused: %+v", fixture.replay.Status())
	}
}

func TestCueIsRejectedOutsideReplayMode(t *testing.T) {
	for _, mode := range []string{"live", "massive", "demo", "render"} {
		fixture := newExternalFixture(t, nil)
		fixture.server.SetMode(mode)
		response := fixture.control(t, fixture.cue("AAPL", 1, 10*time.Second, false, 1), nil, "")
		if response.Code != http.StatusConflict {
			t.Fatalf("mode %s: cue = %d: %s", mode, response.Code, response.Body.String())
		}
		if !bytes.Contains(response.Body.Bytes(), []byte(mode)) {
			t.Fatalf("mode %s: the conflict must name the current mode: %s", mode, response.Body.String())
		}
		status := fixture.status(t)
		if status["capable"] != false || status["capability"] != "wrong_mode" || status["mode"] != mode {
			t.Fatalf("mode %s: status = %+v", mode, status)
		}
	}
}

func TestStatusDistinguishesDisabledFromReady(t *testing.T) {
	disabled := newExternalFixture(t, func(cfg *config.Config) { cfg.ExternalReplay.Enabled = false })
	status := disabled.status(t)
	if status["enabled"] != false || status["capability"] != "disabled" || status["capable"] != false {
		t.Fatalf("status = %+v", status)
	}
	if code := disabled.control(t, disabled.cue("AAPL", 1, 10*time.Second, false, 1), nil, "").Code; code != http.StatusNotFound {
		t.Fatalf("disabled control = %d", code)
	}
	ready := newExternalFixture(t, nil)
	if status := ready.status(t); status["capability"] != "ready" || status["capable"] != true {
		t.Fatalf("status = %+v", status)
	}
}

func TestMissingCoverageIsReportedPerKindAndLeavesStateUntouched(t *testing.T) {
	for _, kind := range []string{"minute_bars", "trades", "quotes"} {
		fixture := newExternalFixture(t, nil, kind)
		response := fixture.control(t, fixture.cue("AAPL", 1, 10*time.Second, false, 1), nil, "")
		if response.Code != http.StatusConflict {
			t.Fatalf("%s: cue = %d: %s", kind, response.Code, response.Body.String())
		}
		var payload struct {
			Error   string `json:"error"`
			Missing []struct {
				Kind      string             `json:"kind"`
				Intervals []storage.Interval `json:"intervals"`
			} `json:"missing"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if len(payload.Missing) != 1 || payload.Missing[0].Kind != kind || len(payload.Missing[0].Intervals) == 0 {
			t.Fatalf("%s: missing = %+v", kind, payload.Missing)
		}
		if control := fixture.controlState(t); control["state"] != externalStateIncompl || control["attached"] != false {
			t.Fatalf("%s: control = %+v", kind, control)
		}
		if len(fixture.store.Snapshot("AAPL", 0).Trades) != 0 {
			t.Fatalf("%s: an incomplete cue must not touch the display", kind)
		}
	}
}

// The whole point of an atomic cue: nothing from the old symbol may appear after
// the new one is published.
func TestSymbolSwitchIsAtomicWithNoLatePublication(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	if code := fixture.control(t, fixture.cue("AAPL", 1, 30*time.Second, true, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("first cue = %d", code)
	}
	if fixture.store.Active() != "AAPL" {
		t.Fatal("the first cue must activate AAPL")
	}
	if code := fixture.control(t, fixture.cue("NVDA", 2, 10*time.Second, false, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("second cue = %d", code)
	}
	if fixture.store.Active() != "NVDA" {
		t.Fatalf("active = %s", fixture.store.Active())
	}
	nvda := fixture.store.Snapshot("NVDA", 0)
	if len(nvda.Trades) != 11 {
		t.Fatalf("NVDA reconstruction = %d trades", len(nvda.Trades))
	}
	for _, trade := range nvda.Trades {
		if trade.Price < 400 {
			t.Fatalf("an AAPL print leaked into the NVDA tape: %+v", trade)
		}
	}
	// The superseded AAPL generation must be finished, not still writing.
	before := len(fixture.store.Snapshot("AAPL", 0).Trades)
	time.Sleep(120 * time.Millisecond)
	if after := len(fixture.store.Snapshot("AAPL", 0).Trades); after != before {
		t.Fatalf("the cancelled AAPL generation kept publishing: %d then %d", before, after)
	}
	if fixture.replay.Status().Symbol != "NVDA" {
		t.Fatalf("replay status = %+v", fixture.replay.Status())
	}
}

// A rebuilt tape must be identical to the same window replayed print by print,
// and a backward cue must rebuild rather than rewind in place.
func TestBackwardCueRebuildsExactlyAndPublishesANewGeneration(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	if code := fixture.control(t, fixture.cue("AAPL", 1, 40*time.Second, false, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("forward cue = %d", code)
	}
	forward := fixture.store.Snapshot("AAPL", 0)
	forwardGeneration := fixture.store.Generation("AAPL")
	if len(forward.Trades) != 41 {
		t.Fatalf("forward = %d trades", len(forward.Trades))
	}
	if code := fixture.control(t, fixture.cue("AAPL", 2, 15*time.Second, false, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("backward cue = %d", code)
	}
	backward := fixture.store.Snapshot("AAPL", 0)
	if len(backward.Trades) != 16 {
		t.Fatalf("a backward cue must rebuild to the earlier target: %d trades", len(backward.Trades))
	}
	if generation := fixture.store.Generation("AAPL"); generation <= forwardGeneration {
		t.Fatalf("generation did not advance: %d then %d", forwardGeneration, generation)
	}
	// Sequence numbers never repeat, so a stale delta can never look current.
	if backward.Trades[0].Seq <= forward.Trades[len(forward.Trades)-1].Seq {
		t.Fatalf("sequence numbers were reused: %d then %d", forward.Trades[len(forward.Trades)-1].Seq, backward.Trades[0].Seq)
	}
	for index, trade := range backward.Trades {
		if trade.Price != forward.Trades[index].Price || trade.Size != forward.Trades[index].Size {
			t.Fatalf("rebuild differs at %d: %+v vs %+v", index, trade, forward.Trades[index])
		}
	}
}

func TestDuplicateSequenceIsIdempotentAndLowerSequenceIsStale(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	if code := fixture.control(t, fixture.cue("AAPL", 5, 20*time.Second, false, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("cue = %d", code)
	}
	generation := fixture.store.Generation("AAPL")

	duplicate := fixture.cue("AAPL", 5, 40*time.Second, false, 1)
	if code := fixture.control(t, duplicate, nil, "").Code; code != http.StatusOK {
		t.Fatalf("a duplicate sequence must return the current status: %d", code)
	}
	if fixture.store.Generation("AAPL") != generation {
		t.Fatal("a duplicate sequence repeated the work")
	}
	if control := fixture.controlState(t); int64(control["target_us"].(float64)) != fixture.baseUS+20*int64(time.Second/time.Microsecond) {
		t.Fatalf("a duplicate sequence changed the accepted target: %+v", control)
	}

	stale := fixture.control(t, fixture.cue("AAPL", 4, 40*time.Second, false, 1), nil, "")
	if stale.Code != http.StatusConflict {
		t.Fatalf("a lower sequence must be stale: %d", stale.Code)
	}
	if fixture.store.Generation("AAPL") != generation {
		t.Fatal("a stale sequence changed state")
	}
	if control := fixture.controlState(t); control["sequence"].(float64) != 5 {
		t.Fatalf("control = %+v", control)
	}
}

func TestCompetingControllerConflictsUntilTheOwnerDetaches(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	if code := fixture.control(t, fixture.cue("AAPL", 1, 10*time.Second, false, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("owner cue = %d", code)
	}
	intruder := fixture.cue("AAPL", 2, 20*time.Second, false, 1)
	intruder["controller_session_id"] = "session-b"
	response := fixture.control(t, intruder, nil, "")
	if response.Code != http.StatusConflict {
		t.Fatalf("competing controller = %d: %s", response.Code, response.Body.String())
	}
	if control := fixture.controlState(t); control["controller_session_id"] != "session-a" {
		t.Fatalf("ownership changed: %+v", control)
	}

	detach := map[string]any{
		"protocol_version": 1, "controller_session_id": "session-a", "sequence": 2, "action": "detach",
	}
	if code := fixture.control(t, detach, nil, "").Code; code != http.StatusOK {
		t.Fatalf("detach = %d", code)
	}
	if control := fixture.controlState(t); control["attached"] != false || control["state"] != externalStateDetached {
		t.Fatalf("detach left %+v", control)
	}
	if code := fixture.control(t, intruder, nil, "").Code; code != http.StatusOK {
		t.Fatalf("the next controller must be able to take over after a detach: %d", code)
	}
	if control := fixture.controlState(t); control["controller_session_id"] != "session-b" {
		t.Fatalf("control = %+v", control)
	}
}

func TestTokenAndLoopbackAreEnforced(t *testing.T) {
	fixture := newExternalFixture(t, func(cfg *config.Config) { cfg.ExternalReplay.Token = "s3cret-control-token" })
	body := fixture.cue("AAPL", 1, 10*time.Second, false, 1)

	if code := fixture.control(t, body, nil, "").Code; code != http.StatusUnauthorized {
		t.Fatalf("a missing token must be rejected: %d", code)
	}
	if code := fixture.control(t, body, map[string]string{"X-Tape-Control-Token": "wrong"}, "").Code; code != http.StatusUnauthorized {
		t.Fatalf("a wrong token must be rejected: %d", code)
	}
	// A prefix of the real token must not pass a length-then-compare check.
	if code := fixture.control(t, body, map[string]string{"X-Tape-Control-Token": "s3cret"}, "").Code; code != http.StatusUnauthorized {
		t.Fatalf("a token prefix must be rejected: %d", code)
	}
	if code := fixture.control(t, body, map[string]string{"X-Tape-Control-Token": "s3cret-control-token"}, "").Code; code != http.StatusOK {
		t.Fatalf("the configured token must be accepted: %d", code)
	}
	if code := fixture.control(t, body, map[string]string{"X-Tape-Control-Token": "s3cret-control-token"}, "203.0.113.7:5000").Code; code != http.StatusForbidden {
		t.Fatalf("a non-loopback client must be rejected: %d", code)
	}
	if status := fixture.status(t); status["token_required"] != true || status["loopback_only"] != true {
		t.Fatalf("status = %+v", status)
	}

	open := newExternalFixture(t, func(cfg *config.Config) { cfg.ExternalReplay.LoopbackOnly = false })
	if code := open.control(t, open.cue("AAPL", 1, 10*time.Second, false, 1), nil, "203.0.113.7:5000").Code; code != http.StatusOK {
		t.Fatalf("an explicitly opened instance must accept a remote client: %d", code)
	}
}

// Warmup arrives as one published generation, never as incremental prints, so
// the browser's audio path is silent through a cue and through a backward seek.
func TestWarmupAndSeekReconstructionArriveAsASingleGeneration(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	generations := []uint64{fixture.store.Generation("AAPL")}
	counts := []int{}
	// Forward then backward: a seek in either direction is one silent rebuild.
	for sequence, offset := range []time.Duration{45 * time.Second, 5 * time.Second} {
		if code := fixture.control(t, fixture.cue("AAPL", uint64(sequence+1), offset, false, 1), nil, "").Code; code != http.StatusOK {
			t.Fatalf("cue = %d", code)
		}
		generations = append(generations, fixture.store.Generation("AAPL"))
		counts = append(counts, len(fixture.store.Snapshot("AAPL", 0).Trades))
	}
	for index := 1; index < len(generations); index++ {
		if generations[index] != generations[index-1]+1 {
			t.Fatalf("each reconstruction must publish exactly one generation: %v", generations)
		}
	}
	// A rebuilt tape is complete the instant its generation appears, which is
	// what keeps the warmup out of the incremental delta stream.
	for _, count := range counts {
		if count == 0 {
			t.Fatalf("a reconstruction published an empty generation: %v", counts)
		}
	}
}

func TestFastFollowSuppressesDetailedPlaybackAndRebuildsOnSlowdown(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	fast := fixture.cue("AAPL", 1, 20*time.Second, true, 10)
	if code := fixture.control(t, fast, nil, "").Code; code != http.StatusOK {
		t.Fatalf("fast cue = %d", code)
	}
	control := fixture.controlState(t)
	if control["state"] != externalStateFastF || control["fast_follow"] != true {
		t.Fatalf("control = %+v", control)
	}
	if control["playing"] != false {
		t.Fatal("fast follow must not report detailed playback as running")
	}
	if fixture.replay.Status().State == "replaying" {
		t.Fatal("detailed replay must stay suppressed above the threshold")
	}

	// A sync inside fast follow moves the authoritative clock without replaying.
	trackBefore := len(fixture.store.Snapshot("AAPL", 0).Trades)
	track := fixture.cue("AAPL", 2, 30*time.Second, true, 10)
	track["action"] = "sync"
	if code := fixture.control(t, track, nil, "").Code; code != http.StatusOK {
		t.Fatalf("fast sync = %d", code)
	}
	if got := len(fixture.store.Snapshot("AAPL", 0).Trades); got != trackBefore {
		t.Fatalf("fast follow replayed detailed prints: %d then %d", trackBefore, got)
	}
	if control := fixture.controlState(t); int64(control["target_us"].(float64)) != fixture.baseUS+30*int64(time.Second/time.Microsecond) {
		t.Fatalf("the authoritative clock did not advance: %+v", control)
	}

	// Returning to a supported speed rebuilds the exact tape before the label goes.
	slow := fixture.cue("AAPL", 3, 30*time.Second, false, 1)
	slow["action"] = "sync"
	if code := fixture.control(t, slow, nil, "").Code; code != http.StatusOK {
		t.Fatalf("slowdown sync = %d", code)
	}
	control = fixture.controlState(t)
	if control["fast_follow"] != false || control["state"] != externalStatePaused {
		t.Fatalf("control = %+v", control)
	}
	if got := len(fixture.store.Snapshot("AAPL", 0).Trades); got != 31 {
		t.Fatalf("the exact tape was not rebuilt on slowdown: %d trades", got)
	}
}

// Forward drift inside tolerance is corrected in place; anything else rebuilds.
func TestSyncCorrectsSmallForwardDriftWithoutRebuilding(t *testing.T) {
	fixture := newExternalFixture(t, func(cfg *config.Config) { cfg.ExternalReplay.SyncTolerance = "750ms" })
	if code := fixture.control(t, fixture.cue("AAPL", 1, 20*time.Second, false, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("cue = %d", code)
	}
	generation := fixture.store.Generation("AAPL")
	trades := len(fixture.store.Snapshot("AAPL", 0).Trades)

	drift := fixture.cue("AAPL", 2, 20*time.Second+500*time.Millisecond, false, 1)
	drift["action"] = "sync"
	if code := fixture.control(t, drift, nil, "").Code; code != http.StatusOK {
		t.Fatalf("drift sync = %d", code)
	}
	if fixture.store.Generation("AAPL") != generation {
		t.Fatal("a small forward drift must not rebuild")
	}
	if got := len(fixture.store.Snapshot("AAPL", 0).Trades); got != trades {
		t.Fatalf("a drift correction changed the tape: %d then %d", trades, got)
	}
	control := fixture.controlState(t)
	if control["drift_corrections"].(float64) != 1 || int64(control["drift_us"].(float64)) != 500000 {
		t.Fatalf("drift was not reported: %+v", control)
	}

	// A jump beyond tolerance rebuilds deterministically.
	jump := fixture.cue("AAPL", 3, 45*time.Second, false, 1)
	jump["action"] = "sync"
	if code := fixture.control(t, jump, nil, "").Code; code != http.StatusOK {
		t.Fatalf("jump sync = %d", code)
	}
	if fixture.store.Generation("AAPL") == generation {
		t.Fatal("a large discontinuity must rebuild")
	}
	if got := len(fixture.store.Snapshot("AAPL", 0).Trades); got != 46 {
		t.Fatalf("the rebuild did not land on the new target: %d trades", got)
	}

	// Backward movement always rebuilds, never a drift correction.
	generation = fixture.store.Generation("AAPL")
	back := fixture.cue("AAPL", 4, 44*time.Second+900*time.Millisecond, false, 1)
	back["action"] = "sync"
	if code := fixture.control(t, back, nil, "").Code; code != http.StatusOK {
		t.Fatalf("backward sync = %d", code)
	}
	if fixture.store.Generation("AAPL") == generation {
		t.Fatal("backward movement must rebuild")
	}
}

func TestManualTransportAndTickerDetachButDisplaySettingsDoNot(t *testing.T) {
	for _, action := range []string{"pause", "stop", "seek"} {
		fixture := newExternalFixture(t, nil)
		if code := fixture.control(t, fixture.cue("AAPL", 1, 20*time.Second, true, 1), nil, "").Code; code != http.StatusOK {
			t.Fatalf("%s: cue = %d", action, code)
		}
		body := fmt.Sprintf(`{"action":%q,"target_us":%d}`, action, fixture.baseUS+5*int64(time.Second/time.Microsecond))
		request := httptest.NewRequest(http.MethodPost, "/api/replay", bytes.NewBufferString(body))
		request.Header.Set("Content-Type", "application/json")
		fixture.server.handleReplay(httptest.NewRecorder(), request)
		if control := fixture.controlState(t); control["attached"] != false || control["state"] != externalStateDetached {
			t.Fatalf("%s: manual transport must detach: %+v", action, control)
		}
	}

	fixture := newExternalFixture(t, nil)
	if code := fixture.control(t, fixture.cue("AAPL", 1, 20*time.Second, false, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("cue = %d", code)
	}
	tickerRequest := httptest.NewRequest(http.MethodPost, "/api/ticker", bytes.NewBufferString(`{"symbol":"nvda"}`))
	tickerRequest.Header.Set("Content-Type", "application/json")
	fixture.server.handleTicker(httptest.NewRecorder(), tickerRequest)
	if control := fixture.controlState(t); control["attached"] != false {
		t.Fatalf("a manual ticker change must detach: %+v", control)
	}

	attached := newExternalFixture(t, nil)
	if code := attached.control(t, attached.cue("AAPL", 1, 20*time.Second, false, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("cue = %d", code)
	}
	uiRequest := httptest.NewRequest(http.MethodPost, "/api/ui-event", bytes.NewBufferString(`{"symbol":"AAPL","kind":"tick_size","value":50}`))
	uiRequest.Header.Set("Content-Type", "application/json")
	attached.server.handleUIEvent(httptest.NewRecorder(), uiRequest)
	if control := attached.controlState(t); control["attached"] != true {
		t.Fatalf("a display setting must not detach: %+v", control)
	}
}

func TestAudioReadinessIsReportedRatherThanAssumed(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	if status := fixture.status(t); status["ui_audio_ready"] != false {
		t.Fatalf("a browser that never reported must not read as ready: %+v", status)
	}
	post := func(ready bool) {
		body := fmt.Sprintf(`{"audio_ready":%v}`, ready)
		request := httptest.NewRequest(http.MethodPost, "/api/external-replay/ui", bytes.NewBufferString(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		fixture.server.handleExternalReplayUI(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("ui status = %d: %s", response.Code, response.Body.String())
		}
	}
	post(false)
	if status := fixture.status(t); status["ui_audio_ready"] != false {
		t.Fatalf("a locked browser must report not ready: %+v", status)
	}
	post(true)
	if status := fixture.status(t); status["ui_audio_ready"] != true {
		t.Fatalf("an unlocked browser must report ready: %+v", status)
	}
	// A tab that stops reporting goes stale rather than staying healthy forever.
	fixture.server.now = func() time.Time { return time.Now().Add(time.Minute) }
	if status := fixture.status(t); status["ui_audio_ready"] != false {
		t.Fatalf("a stale heartbeat must not read as ready: %+v", status)
	}
}

func TestCoverageCheckIsBatchedAndReadOnly(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	body := map[string]any{
		"protocol_version": 1,
		"requirements": []map[string]any{
			{"symbol": "AAPL", "provider": "massive", "kind": "minute_bars", "start_us": fixture.baseUS, "end_us": fixture.baseUS + minuteUS},
			{"symbol": "AAPL", "provider": "massive", "kind": "trades", "start_us": fixture.baseUS, "end_us": fixture.baseUS + 400*minuteUS},
			{"symbol": "ZZZZ", "provider": "massive", "kind": "quotes", "start_us": fixture.baseUS, "end_us": fixture.baseUS + minuteUS},
		},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/historical/coverage/check", bytes.NewReader(encoded))
	request.RemoteAddr = "127.0.0.1:54321"
	response := httptest.NewRecorder()
	fixture.server.handleCoverageCheck(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("coverage = %d: %s", response.Code, response.Body.String())
	}
	var payload struct {
		ProtocolVersion int `json:"protocol_version"`
		Results         []struct {
			Complete bool               `json:"complete"`
			Covered  []storage.Interval `json:"covered"`
			Missing  []storage.Interval `json:"missing"`
		} `json:"results"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.ProtocolVersion != 1 || len(payload.Results) != 3 {
		t.Fatalf("payload = %+v", payload)
	}
	if !payload.Results[0].Complete {
		t.Fatalf("a covered requirement must be complete: %+v", payload.Results[0])
	}
	if payload.Results[1].Complete || len(payload.Results[1].Missing) != 1 {
		t.Fatalf("a partially covered requirement must report its gap: %+v", payload.Results[1])
	}
	if payload.Results[2].Complete || len(payload.Results[2].Covered) != 0 {
		t.Fatalf("an unknown symbol must report no coverage: %+v", payload.Results[2])
	}
	// A coverage check may never download; nothing about the display changes.
	if len(fixture.store.Snapshot("AAPL", 0).Trades) != 0 {
		t.Fatal("a coverage check changed replay state")
	}
	request = httptest.NewRequest(http.MethodPost, "/api/historical/coverage/check", bytes.NewReader(encoded))
	request.RemoteAddr = "203.0.113.7:5000"
	response = httptest.NewRecorder()
	fixture.server.handleCoverageCheck(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("coverage must be loopback-only: %d", response.Code)
	}
}

func TestControlRejectsMalformedRequests(t *testing.T) {
	fixture := newExternalFixture(t, nil)
	cases := []struct {
		name  string
		mutty func(map[string]any)
	}{
		{"protocol", func(body map[string]any) { body["protocol_version"] = 2 }},
		{"session", func(body map[string]any) { body["controller_session_id"] = "" }},
		{"sequence", func(body map[string]any) { body["sequence"] = 0 }},
		{"action", func(body map[string]any) { body["action"] = "rewind" }},
		{"symbol", func(body map[string]any) { body["symbol"] = "not a symbol" }},
		{"source", func(body map[string]any) { body["source"] = "live" }},
		{"provider", func(body map[string]any) { body["provider"] = "all" }},
		{"target", func(body map[string]any) { body["target_us"] = 0 }},
		{"range", func(body map[string]any) { body["range_end_us"] = 1 }},
		{"speed", func(body map[string]any) { body["speed"] = 99 }},
		{"warmup", func(body map[string]any) { body["warmup_start_us"] = fixture.baseUS + 1e9 }},
	}
	for _, testCase := range cases {
		body := fixture.cue("AAPL", 1, 10*time.Second, false, 1)
		testCase.mutty(body)
		response := fixture.control(t, body, nil, "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d: %s", testCase.name, response.Code, response.Body.String())
		}
	}
	unknown := fixture.cue("AAPL", 1, 10*time.Second, false, 1)
	unknown["surprise"] = true
	if code := fixture.control(t, unknown, nil, "").Code; code != http.StatusBadRequest {
		t.Fatalf("an unknown field must be rejected: %d", code)
	}
}

// Drift correction has to work while playing, which is the only time drift
// occurs. A cue that starts playing publishes the playback generation, not the
// reconstruction's, or every later sync would see a mismatch and rebuild.
func TestDriftIsCorrectedWhilePlaying(t *testing.T) {
	fixture := newExternalFixture(t, func(cfg *config.Config) { cfg.ExternalReplay.SyncTolerance = "750ms" })
	if code := fixture.control(t, fixture.cue("AAPL", 1, 20*time.Second, true, 1), nil, "").Code; code != http.StatusOK {
		t.Fatalf("cue = %d", code)
	}
	control := fixture.controlState(t)
	reported := uint64(control["generation"].(float64))
	_, _, live, playing := fixture.replay.Position()
	if !playing {
		t.Fatal("a cue with playing=true must be replaying")
	}
	if reported != live {
		t.Fatalf("status reported generation %d while the replay is on %d", reported, live)
	}

	drift := fixture.cue("AAPL", 2, 20*time.Second+400*time.Millisecond, true, 1)
	drift["action"] = "sync"
	if code := fixture.control(t, drift, nil, "").Code; code != http.StatusOK {
		t.Fatalf("drift sync = %d", code)
	}
	control = fixture.controlState(t)
	if control["drift_corrections"].(float64) != 1 {
		t.Fatalf("drift while playing was not absorbed: %+v", control)
	}
	if control["state"] != externalStateFollowing || control["playing"] != true {
		t.Fatalf("control = %+v", control)
	}
}
