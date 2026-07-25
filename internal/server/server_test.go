package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

type stubFeed struct {
	symbol string
}

func (f *stubFeed) Run(context.Context)     {}
func (f *stubFeed) SetSymbol(symbol string) { f.symbol = symbol }

type stubLiveBarFeed struct {
	stubFeed
	calls     int
	lastLimit int
}

func (f *stubLiveBarFeed) RVOLMinuteBars(_ context.Context, _ string, end time.Time, limit int) ([]storage.MinuteBar, error) {
	f.calls++
	f.lastLimit = limit
	return []storage.MinuteBar{{TimeUS: end.Add(-time.Minute).UnixMicro(), Close: 10, Volume: 100}}, nil
}

func TestTickerHandlerActivatesSymbol(t *testing.T) {
	store := tape.NewStore("AAPL", 100, 4)
	source := &stubFeed{}
	server := New(config.Defaults(), store, source)
	request := httptest.NewRequest(http.MethodPost, "/api/ticker", bytes.NewBufferString(`{"symbol":"nvda"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	server.handleTicker(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if store.Active() != "NVDA" || source.symbol != "NVDA" {
		t.Fatalf("active=%q feed=%q", store.Active(), source.symbol)
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["symbol"] != "NVDA" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestTickerHandlerRejectsInvalidSymbol(t *testing.T) {
	store := tape.NewStore("AAPL", 100, 4)
	server := New(config.Defaults(), store, &stubFeed{})
	request := httptest.NewRequest(http.MethodPost, "/api/ticker", bytes.NewBufferString(`{"symbol":"bad symbol"}`))
	response := httptest.NewRecorder()

	server.handleTicker(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", response.Code)
	}
	if store.Active() != "AAPL" {
		t.Fatalf("active symbol changed to %q", store.Active())
	}
}

func TestRVOLHistoryUsesAndCachesIBKRLiveBars(t *testing.T) {
	store := tape.NewStore("AAPL", 100, 4)
	store.SetStatus(tape.FeedStatus{Mode: "live", State: "live", Connected: true})
	source := &stubLiveBarFeed{}
	server := New(config.Defaults(), store, source)
	now := time.Date(2026, time.July, 18, 10, 31, 42, 0, time.UTC)
	server.now = func() time.Time { return now }

	for range 2 {
		request := httptest.NewRequest(http.MethodGet, "/api/rvol-history?symbol=aapl", nil)
		response := httptest.NewRecorder()
		server.handleRVOLHistory(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		var payload struct {
			Provider  string              `json:"provider"`
			ThroughUS int64               `json:"through_us"`
			Bars      []storage.MinuteBar `json:"bars"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Provider != "ibkr" || payload.ThroughUS != now.Truncate(time.Minute).UnixMicro() || len(payload.Bars) != 1 {
			t.Fatalf("payload = %+v", payload)
		}
	}
	if source.calls != 1 {
		t.Fatalf("IBKR history calls = %d, want 1", source.calls)
	}
	if source.lastLimit != 960 {
		t.Fatalf("IBKR history limit = %d, want 960", source.lastLimit)
	}
}

func TestRVOLHistoryLoadsTwoSessionsForXtraChart(t *testing.T) {
	store := tape.NewStore("AAPL", 100, 4)
	store.SetStatus(tape.FeedStatus{Mode: "live", State: "live", Connected: true})
	source := &stubLiveBarFeed{}
	server := New(config.Defaults(), store, source, true, true)
	server.now = func() time.Time { return time.Date(2026, time.July, 22, 14, 0, 0, 0, time.UTC) }
	request := httptest.NewRequest(http.MethodGet, "/api/rvol-history?symbol=AAPL", nil)
	response := httptest.NewRecorder()

	server.handleRVOLHistory(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if source.lastLimit != 2200 {
		t.Fatalf("IBKR xtra history limit = %d, want 2200", source.lastLimit)
	}
}

func TestRVOLHistoryDoesNotUseMassiveForLiveFallback(t *testing.T) {
	store := tape.NewStore("AAPL", 100, 4)
	store.SetStatus(tape.FeedStatus{Mode: "live", State: "live", Connected: true})
	cfg := config.Defaults()
	cfg.Massive.APIKey = "must-not-be-used"
	server := New(cfg, store, &stubFeed{})
	request := httptest.NewRequest(http.MethodGet, "/api/rvol-history?symbol=AAPL", nil)
	response := httptest.NewRecorder()

	server.handleRVOLHistory(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func liveStore(t *testing.T, ringSize int, prints int) *tape.Store {
	t.Helper()
	store := tape.NewStore("IREN", ringSize, 4)
	store.SetStatus(tape.FeedStatus{Mode: "live", State: "live", Connected: true})
	store.UpdateQuote("IREN", 9.99, 10, 100, 200)
	base := time.Date(2026, 7, 22, 13, 30, 0, 0, time.UTC)
	for i := 0; i < prints; i++ {
		store.AddTrade("IREN", base, base.Add(time.Duration(i)*time.Millisecond), 10, 100)
	}
	return store
}

func tapeRange(t *testing.T, server *Server, query string) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/tape/range?"+query, nil)
	response := httptest.NewRecorder()
	server.handleTapeRange(response, request)
	payload := map[string]any{}
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
	}
	return response.Code, payload
}

func TestTapeRangeServesResidentSequencesFromTheRing(t *testing.T) {
	server := New(config.Defaults(), liveStore(t, 1000, 40), &stubFeed{})
	code, payload := tapeRange(t, server, "symbol=IREN&seq_from=10&seq_to=20")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	trades, _ := payload["trades"].([]any)
	if len(trades) != 11 || payload["served"] != "ring" || payload["complete"] != true {
		t.Fatalf("payload = %+v", payload)
	}
	first, _ := trades[0].(map[string]any)
	if first["s"].(float64) != 10 {
		t.Fatalf("first sequence = %v", first["s"])
	}
	if payload["type"] != "trades" || payload["quote"] == nil {
		t.Fatalf("wire shape does not match a WebSocket batch: %+v", payload)
	}
}

func TestTapeRangePagesWithinTheWebSocketBatchBound(t *testing.T) {
	cfg := config.Defaults()
	cfg.Tape.WebSocketMaxBatch = 8
	server := New(cfg, liveStore(t, 1000, 40), &stubFeed{})
	code, payload := tapeRange(t, server, "seq_from=1&seq_to=40")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	trades, _ := payload["trades"].([]any)
	if len(trades) != 8 || payload["complete"] != false || payload["next_seq_from"].(float64) != 9 {
		t.Fatalf("payload = %+v", payload)
	}
}

func TestTapeRangeReportsTheRingFloorWhenNoRecorderIsAttached(t *testing.T) {
	// Demo mode keeps no recording, so an overwritten range is ring-only.
	store := liveStore(t, 8, 40)
	store.SetStatus(tape.FeedStatus{Mode: "demo", State: "live", Connected: true})
	server := New(config.Defaults(), store, &stubFeed{})
	code, payload := tapeRange(t, server, "seq_from=1&seq_to=40")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if payload["ring_oldest"].(float64) != 33 || payload["served"] != "ring" {
		t.Fatalf("payload = %+v", payload)
	}
	trades, _ := payload["trades"].([]any)
	if len(trades) != 8 {
		t.Fatalf("resident trades = %d, want 8", len(trades))
	}
}

func TestTapeRangeFillsTheLaggedHoleFromStorage(t *testing.T) {
	store := liveStore(t, 8, 40)
	server := New(config.Defaults(), store, &stubFeed{})
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "tape.db")
	recorder, err := storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer recorder.Close()
	server.AttachRecorder(recorder)
	server.processStartUS = 0

	base := time.Date(2026, 7, 22, 13, 30, 0, 0, time.UTC).UnixMicro()
	records := make([]storage.TradeRecord, 0, 32)
	for seq := 1; seq <= 32; seq++ {
		records = append(records, storage.TradeRecord{
			Symbol: "IREN", EventUS: base + int64(seq), ReceivedUS: base + int64(seq), RingSeq: uint64(seq),
			Price: 10, Size: 100, Class: tape.AtBid, Side: -1, Bid: 9.99, Ask: 10,
			ChartEligible: true, Source: "live", Provider: "ibkr",
		})
	}
	if err := recorder.InsertTrades(context.Background(), records); err != nil {
		t.Fatal(err)
	}

	code, payload := tapeRange(t, server, "seq_from=25&seq_to=40")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if payload["served"] != "mixed" || payload["complete"] != true {
		t.Fatalf("payload = %+v", payload)
	}
	trades, _ := payload["trades"].([]any)
	if len(trades) != 16 {
		t.Fatalf("gap-free range = %d trades, want 16", len(trades))
	}
	// The reassembled range must be contiguous across the ring floor at 33.
	for i, item := range trades {
		trade, _ := item.(map[string]any)
		if want := float64(25 + i); trade["s"].(float64) != want {
			t.Fatalf("trade %d sequence = %v, want %v", i, trade["s"], want)
		}
	}
}

func TestTapeRangeNeverReportsAnUnservedRangeAsComplete(t *testing.T) {
	server := New(config.Defaults(), liveStore(t, 1000, 40), &stubFeed{})

	// Entirely above the newest sequence: those prints have not happened yet.
	code, payload := tapeRange(t, server, "seq_from=999999&seq_to=1000000")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	trades, _ := payload["trades"].([]any)
	if len(trades) != 0 {
		t.Fatalf("expected no trades, got %d", len(trades))
	}
	if payload["complete"] != false {
		t.Fatalf("an unserved future range must not be complete: %+v", payload)
	}
	if payload["seq_to"].(float64) != 0 {
		t.Fatalf("seq_to must report what was served, not what was asked for: %+v", payload)
	}
	// The caller must not be told to advance past a range it never received.
	if payload["next_seq_from"].(float64) != 999999 {
		t.Fatalf("next_seq_from = %v, want the unchanged start", payload["next_seq_from"])
	}

	// Straddling the newest sequence: the resident part is served, the rest is not.
	code, payload = tapeRange(t, server, "seq_from=38&seq_to=90")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	trades, _ = payload["trades"].([]any)
	if len(trades) != 3 || payload["complete"] != false || payload["seq_to"].(float64) != 40 {
		t.Fatalf("straddling range = %+v", payload)
	}
	if payload["next_seq_from"].(float64) != 41 {
		t.Fatalf("next_seq_from = %v, want 41", payload["next_seq_from"])
	}

	// Below the ring floor with no recording attached: a hole, not a completion.
	small := liveStore(t, 8, 40)
	code, payload = tapeRange(t, New(config.Defaults(), small, &stubFeed{}), "seq_from=1&seq_to=10")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	trades, _ = payload["trades"].([]any)
	if len(trades) != 0 || payload["complete"] != false || payload["seq_to"].(float64) != 0 {
		t.Fatalf("evicted range = %+v", payload)
	}
}

func TestTapeRangeReportsAPartiallyPersistedRangeAsIncomplete(t *testing.T) {
	// The recording holds only part of what the ring has overwritten, so the
	// reassembled range has a hole in the middle and must say so.
	server := New(config.Defaults(), liveStore(t, 8, 40), &stubFeed{})
	cfg := config.Defaults().Storage
	cfg.Path = filepath.Join(t.TempDir(), "tape.db")
	recorder, err := storage.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer recorder.Close()
	server.AttachRecorder(recorder)
	server.processStartUS = 0

	base := time.Date(2026, 7, 22, 13, 30, 0, 0, time.UTC).UnixMicro()
	records := make([]storage.TradeRecord, 0, 4)
	// Sequences 25 and 26 only; 27 through 32 were never persisted.
	for _, seq := range []uint64{25, 26} {
		records = append(records, storage.TradeRecord{
			Symbol: "IREN", EventUS: base + int64(seq), ReceivedUS: base + int64(seq), RingSeq: seq,
			Price: 10, Size: 100, ChartEligible: true, Source: "live", Provider: "ibkr",
		})
	}
	if err := recorder.InsertTrades(context.Background(), records); err != nil {
		t.Fatal(err)
	}

	code, payload := tapeRange(t, server, "seq_from=25&seq_to=40")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if payload["complete"] != false || payload["contiguous"] != false {
		t.Fatalf("a range with an unfilled hole must be reported: %+v", payload)
	}
	trades, _ := payload["trades"].([]any)
	if len(trades) != 10 {
		t.Fatalf("served %d trades, want 2 from storage plus 8 from the ring", len(trades))
	}
}

func TestTapeRangeRejectsBadRequestsAndNonLiveModes(t *testing.T) {
	server := New(config.Defaults(), liveStore(t, 100, 10), &stubFeed{})
	for _, query := range []string{"seq_from=0&seq_to=5", "seq_from=9&seq_to=4", "seq_from=x&seq_to=4"} {
		if code, _ := tapeRange(t, server, query); code != http.StatusBadRequest {
			t.Fatalf("%q status = %d, want 400", query, code)
		}
	}

	disabled := config.Defaults()
	disabled.Rewind.Enabled = false
	if code, _ := tapeRange(t, New(disabled, liveStore(t, 100, 10), &stubFeed{}), "seq_from=1&seq_to=5"); code != http.StatusConflict {
		t.Fatalf("disabled rewind status = %d, want 409", code)
	}

	replayStore := liveStore(t, 100, 10)
	replayStore.SetStatus(tape.FeedStatus{Mode: "replay", State: "replaying"})
	if code, _ := tapeRange(t, New(config.Defaults(), replayStore, &stubFeed{}), "seq_from=1&seq_to=5"); code != http.StatusConflict {
		t.Fatalf("replay status = %d, want 409", code)
	}
}

func TestUIEventCoalescesAndOnlyAcceptsKnownKinds(t *testing.T) {
	server := New(config.Defaults(), liveStore(t, 100, 4), &stubFeed{})
	now := time.Date(2026, 7, 22, 13, 30, 0, 0, time.UTC)
	server.now = func() time.Time { return now }

	post := func(body string) int {
		request := httptest.NewRequest(http.MethodPost, "/api/ui-event", bytes.NewBufferString(body))
		response := httptest.NewRecorder()
		server.handleUIEvent(response, request)
		return response.Code
	}
	if code := post(`{"kind":"tick_size","symbol":"IREN","value":100}`); code != http.StatusOK {
		t.Fatalf("first tick_size status = %d", code)
	}
	if code := post(`{"kind":"tick_size","symbol":"IREN","value":1000}`); code != http.StatusNoContent {
		t.Fatalf("coalesced status = %d, want 204", code)
	}
	now = now.Add(time.Second)
	if code := post(`{"kind":"tick_size","symbol":"IREN","value":1000}`); code != http.StatusOK {
		t.Fatalf("status after the coalescing window = %d", code)
	}
	if code := post(`{"kind":"symbol","symbol":"IREN"}`); code != http.StatusBadRequest {
		t.Fatalf("symbol kind status = %d, want 400", code)
	}
}

func TestSnapshotAdvertisesRewindConfiguration(t *testing.T) {
	cfg := config.Defaults()
	server := New(cfg, liveStore(t, 100, 4), &stubFeed{})
	server.ReserveRewindPane(true)
	if !server.rewindPane {
		t.Fatal("pane reservation was not applied")
	}
	disabled := config.Defaults()
	disabled.Rewind.Enabled = false
	off := New(disabled, liveStore(t, 100, 4), &stubFeed{})
	off.ReserveRewindPane(true)
	if off.rewindPane {
		t.Fatal("a disabled rewind must never reserve the pane")
	}
}
