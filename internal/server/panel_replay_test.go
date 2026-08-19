package server

import (
	"context"
	"encoding/json"
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

// replayPanelFixture drives the panel data endpoints against a real
// *feed.Replay rather than a stub clock. Everything above this had been checked
// with the replay position simulated, which is exactly where the no-look-ahead
// guarantees are easiest to get wrong: the position only advances when an event
// is emitted, and the browser clock is an extrapolation that outruns it.
type replayPanelFixture struct {
	server   *Server
	replay   *feed.Replay
	location *time.Location
	sessionA time.Time // completed session, two days before the replay session
	sessionB time.Time // completed session, one day before the replay session
	session  time.Time // the replay session itself
	later    time.Time // a completed session after the replay session but before today
}

func (f *replayPanelFixture) at(day time.Time, hour, minute int) int64 {
	return time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, f.location).UnixMicro()
}

func newReplayPanelFixture(t *testing.T) *replayPanelFixture {
	t.Helper()
	cfg := config.Defaults()
	cfg.Storage.Path = filepath.Join(t.TempDir(), "tape.db")
	cfg.Storage.FlushInterval = "5ms"
	database, err := storage.Open(cfg.Storage)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })

	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	fixture := &replayPanelFixture{
		location: location,
		sessionA: time.Date(2026, 7, 20, 0, 0, 0, 0, location),
		sessionB: time.Date(2026, 7, 21, 0, 0, 0, 0, location),
		session:  time.Date(2026, 7, 22, 0, 0, 0, 0, location),
		later:    time.Date(2026, 7, 23, 0, 0, 0, 0, location),
	}
	ctx := context.Background()

	// Completed prior sessions carry only provider minute bars and a completed
	// minute-bar download, which is the shape local replay history really has.
	// `later` is a completed session that falls after the replay session but
	// before any plausible wall clock: it must never reach the baseline.
	for _, day := range []struct {
		date      time.Time
		low, high float64
	}{
		{fixture.sessionA, 90, 99},
		{fixture.sessionB, 100, 105},
		{fixture.later, 1, 1000},
	} {
		bars := []storage.MinuteBar{
			{TimeUS: fixture.at(day.date, 9, 30), Open: day.low, High: day.low, Low: day.low, Close: day.low, Volume: 100},
			{TimeUS: fixture.at(day.date, 12, 0), Open: day.low, High: day.high, Low: day.low, Close: day.high, Volume: 100},
			{TimeUS: fixture.at(day.date, 15, 0), Open: day.high, High: day.high, Low: day.low, Close: day.high, Volume: 100},
		}
		if err := database.UpsertMinuteBars(ctx, "AAPL", "massive", bars); err != nil {
			t.Fatal(err)
		}
		if err := database.MarkCoverage(ctx, storage.Coverage{
			Symbol: "AAPL", Provider: "massive", Kind: "minute_bars",
			StartUS: fixture.at(day.date, 9, 30), EndUS: fixture.at(day.date, 16, 0), RowCount: 3,
		}); err != nil {
			t.Fatal(err)
		}
	}

	// The replay session. The 09:45 print is the session low, and it must stay
	// invisible until the replay position actually reaches it.
	trades := []storage.TradeRecord{
		{Symbol: "AAPL", EventUS: fixture.at(fixture.session, 9, 31), MarketTimeUS: fixture.at(fixture.session, 9, 31), SequenceID: 1, Price: 100, Size: 10, ChartEligible: true, Source: "historical", Provider: "massive"},
		{Symbol: "AAPL", EventUS: fixture.at(fixture.session, 9, 35), MarketTimeUS: fixture.at(fixture.session, 9, 35), SequenceID: 2, Price: 99, Size: 10, ChartEligible: true, Source: "historical", Provider: "massive"},
		{Symbol: "AAPL", EventUS: fixture.at(fixture.session, 9, 45), MarketTimeUS: fixture.at(fixture.session, 9, 45), SequenceID: 3, Price: 95, Size: 10, ChartEligible: true, Source: "historical", Provider: "massive"},
	}
	if err := database.InsertTrades(ctx, trades); err != nil {
		t.Fatal(err)
	}
	if err := database.MarkCoverage(ctx, storage.Coverage{
		Symbol: "AAPL", Provider: "massive", Kind: "trades",
		StartUS: fixture.at(fixture.session, 9, 30), EndUS: fixture.at(fixture.session, 16, 0), RowCount: 3,
	}); err != nil {
		t.Fatal(err)
	}
	waitForTrades(t, database, "AAPL", fixture.at(fixture.session, 9, 30), fixture.at(fixture.session, 16, 0), 3)

	store := tape.NewStore("AAPL", cfg.Tape.RingSize, cfg.Tape.HistorySize)
	replay := feed.NewReplay(database, store, "historical", "massive", 1)
	server := New(cfg, store, replay)
	server.SetMode("replay")
	server.AttachRecorder(database)
	fixture.server, fixture.replay = server, replay

	// Render stepping places the replay position at an exact instant without
	// wall-clock pacing, so the assertions below are about position, not timing.
	if err := replay.PrepareRender(feed.ReplayRequest{
		Symbol: "AAPL", Source: "historical", Provider: "massive",
		StartUS: fixture.at(fixture.session, 9, 30), EndUS: fixture.at(fixture.session, 16, 0), Speed: 1,
	}, fixture.at(fixture.session, 9, 30)); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (f *replayPanelFixture) rth(t *testing.T, rawQuery string) panelRTHResponse {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/panel-data/rth-context?"+rawQuery, nil)
	response := httptest.NewRecorder()
	f.server.handlePanelRTHContext(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("rth-context %s returned %d: %s", rawQuery, response.Code, response.Body.String())
	}
	var payload panelRTHResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func (f *replayPanelFixture) daily(t *testing.T, rawQuery string) panelDailyResponse {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/panel-data/daily-bars?"+rawQuery, nil)
	response := httptest.NewRecorder()
	f.server.handlePanelDailyBars(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("daily-bars %s returned %d: %s", rawQuery, response.Code, response.Body.String())
	}
	var payload panelDailyResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

// The session low formed at 09:45 may not be visible at 09:36, and the browser
// asking for an instant beyond the replay position may not conjure it either.
func TestReplaySessionContextNeverLeaksALaterLow(t *testing.T) {
	fixture := newReplayPanelFixture(t)
	if _, err := fixture.replay.StepRender(fixture.at(fixture.session, 9, 36)); err != nil {
		t.Fatal(err)
	}
	early := fixture.rth(t, "symbol=AAPL&session=2026-07-22")
	if early.Status != "ready" || !early.CompleteFromRTHOpen || early.Low != 99 || early.Last != 99 {
		t.Fatalf("position 09:36 must know only the 09:31 and 09:35 prints: %+v", early)
	}
	if early.ThroughUS != fixture.at(fixture.session, 9, 36) {
		t.Fatalf("as-of instant must be the replay position: %+v", early)
	}

	// A browser clock that has outrun the replay position, and one left over from
	// before a backward seek, both name an instant past the emitted events.
	ahead := fixture.rth(t, "symbol=AAPL&session=2026-07-22&through_us="+formatInt64(fixture.at(fixture.session, 15, 59)))
	if ahead.ThroughUS != fixture.at(fixture.session, 9, 36) || ahead.Low != 99 {
		t.Fatalf("a request beyond the replay position must clamp, not reveal the 09:45 low: %+v", ahead)
	}

	// A cross-session backward seek can leave both the browser's date and clock
	// ahead until the new generation snapshot is applied. The endpoint must use
	// the replay position's session rather than answering for that stale date.
	for _, mode := range []string{"replay", "render"} {
		fixture.server.SetMode(mode)
		stale := fixture.rth(t, "symbol=AAPL&session=2026-07-23&through_us="+formatInt64(fixture.at(fixture.later, 15, 59)))
		if stale.SessionDateET != "2026-07-22" || stale.ThroughUS != fixture.at(fixture.session, 9, 36) || stale.Status != "ready" || stale.Low != 99 {
			t.Fatalf("stale browser session and clock must clamp in %s mode to the authoritative replay session: %+v", mode, stale)
		}
	}
	fixture.server.SetMode("replay")

	if _, err := fixture.replay.StepRender(fixture.at(fixture.session, 9, 46)); err != nil {
		t.Fatal(err)
	}
	arrived := fixture.rth(t, "symbol=AAPL&session=2026-07-22")
	if arrived.Status != "ready" || arrived.Low != 95 || arrived.LowTimeUS != fixture.at(fixture.session, 9, 45) {
		t.Fatalf("position 09:46 must know the 09:45 low: %+v", arrived)
	}
}

// The browser cannot ask for the right session if the wire never tells it where
// the replay is. Every snapshot carries the authoritative instant, and in replay
// and render modes that is the position rather than the wall clock: the browser
// adopts it at each generation boundary because its own clock is an
// extrapolation that a seek invalidates.
func TestReplaySnapshotCarriesTheAuthoritativePosition(t *testing.T) {
	fixture := newReplayPanelFixture(t)
	for _, minute := range []int{36, 46} {
		at := fixture.at(fixture.session, 9, minute)
		if _, err := fixture.replay.StepRender(at); err != nil {
			t.Fatal(err)
		}
		if got := fixture.server.streamTimeMS(); got != at/1000 {
			t.Fatalf("snapshot clock was %d, want the replay position %d", got, at/1000)
		}
	}
	if fixture.server.streamTimeMS()*1000 >= time.Now().UnixMicro() {
		t.Fatal("an older replay must not stamp snapshots with the wall clock")
	}
}

// History for an older replay is chosen from the replay session date. A session
// that is completed, downloaded, and earlier than any real wall clock is still
// in the replay's future, and must not enter the baseline.
func TestReplayDailyHistoryIgnoresTheWallClockDate(t *testing.T) {
	fixture := newReplayPanelFixture(t)
	if _, err := fixture.replay.StepRender(fixture.at(fixture.session, 9, 36)); err != nil {
		t.Fatal(err)
	}
	asOfReplay := fixture.daily(t, "symbol=AAPL&before=2026-07-22&limit=2")
	if asOfReplay.Status != "ready" || len(asOfReplay.Bars) != 2 {
		t.Fatalf("two completed prior sessions were downloaded: %+v", asOfReplay)
	}
	if asOfReplay.Bars[0].SessionDateET != "2026-07-20" || asOfReplay.Bars[1].SessionDateET != "2026-07-21" {
		t.Fatalf("unexpected sessions: %+v", asOfReplay.Bars)
	}
	if asOfReplay.Bars[0].High != 99 || asOfReplay.Bars[0].Low != 90 || asOfReplay.Bars[1].High != 105 || asOfReplay.Bars[1].Low != 100 {
		t.Fatalf("aggregated session ranges are wrong: %+v", asOfReplay.Bars)
	}

	// A browser whose session date came from a stale clock asks past the replay
	// session. The answer must still be as of the replay session.
	asOfToday := fixture.daily(t, "symbol=AAPL&before=2026-08-18&limit=2")
	if asOfToday.BeforeSessionDateET != "2026-07-22" {
		t.Fatalf("as-of session must clamp to the replay session: %+v", asOfToday)
	}
	for _, bar := range asOfToday.Bars {
		if bar.SessionDateET >= "2026-07-22" {
			t.Fatalf("a session at or after the replay session leaked into the baseline: %+v", bar)
		}
	}
}

// Stepping the same prepared render to the same instant twice must produce the
// same answer: the deterministic render mode depends on it.
func TestReplaySessionContextIsRepeatableAtTheSamePosition(t *testing.T) {
	first := newReplayPanelFixture(t)
	if _, err := first.replay.StepRender(first.at(first.session, 9, 40)); err != nil {
		t.Fatal(err)
	}
	second := newReplayPanelFixture(t)
	if _, err := second.replay.StepRender(second.at(second.session, 9, 40)); err != nil {
		t.Fatal(err)
	}
	left := first.rth(t, "symbol=AAPL&session=2026-07-22")
	right := second.rth(t, "symbol=AAPL&session=2026-07-22")
	if left != right {
		t.Fatalf("the same replay position produced different context:\n%+v\n%+v", left, right)
	}
}
