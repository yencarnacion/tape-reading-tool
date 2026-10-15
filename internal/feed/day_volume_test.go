package feed

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/marketgateway"
	"tape-reading-tool/internal/tape"
	"testing"
	"time"
)

func TestDayVolumeFractionalCounterIsIndependentOfCandlePrices(t *testing.T) {
	s := tape.NewStore("QQQ", 10, 2)
	f := NewGateway(config.MassiveConfig{}, s, nil)
	at := time.Date(2026, 10, 15, 11, 16, 0, 0, time.UTC).UnixMilli()
	event := func(symbol, raw string, stamp int64) {
		f.event("QQQ", marketgateway.Event{Symbol: symbol, Channel: "A", EventMS: stamp, Data: json.RawMessage(raw)})
	}
	// Observed QQQ counter; the same interval's minute bars summed to 878084.41931.
	event("QQQ", fmt.Sprintf(`{"sym":"QQQ","av":1316237,"dav":"1316237.651295","e":%d}`, at), at)
	got := s.Snapshot("QQQ", 10)
	if got.Quote.DayVolume != 1316237.651295 || got.Quote.DayVolumeMS != at || len(got.Trades) != 0 || got.Quote.LastPrice != 0 {
		t.Fatal(got)
	}
	event("QQQ", fmt.Sprintf(`{"av":1,"e":%d}`, at-1), at-1)
	event("QQQ", fmt.Sprintf(`{"dav":"NaN","e":%d}`, at+1), at+1)
	event("OTHER", fmt.Sprintf(`{"av":1,"e":%d}`, at+1), at+1)
	if s.Quote("QQQ").DayVolume != got.Quote.DayVolume {
		t.Fatal("obsolete or malformed event changed counter")
	}
	s.UpdateDayVolume("QQQ", math.NaN(), at+1)
	s.UpdateDayVolume("QQQ", 0, at+86400000)
	if q := s.Quote("QQQ"); q.DayVolume != 0 || q.DayVolumeMS != at+86400000 {
		t.Fatal("new-day zero counter was not retained", q)
	}
	s.ClearTopOfBook("QQQ")
	if s.Quote("QQQ").DayVolumeMS != 0 {
		t.Fatal("gap retained old counter")
	}
}
func TestGatewaySnapshotHydratesPremarketCounterWithoutDayBar(t *testing.T) {
	at := time.Now().Truncate(time.Minute).UnixMilli()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ticker":{"updated":%d,"day":{"v":0},"min":{"t":%d,"av":1316237,"dav":"1316237.651295"}}}`, at*1000000, at)
	}))
	defer server.Close()
	s := tape.NewStore("QQQ", 10, 2)
	f := NewGateway(config.MassiveConfig{GatewayURL: server.URL}, s, nil)
	defer f.client.Close()
	f.snapshot(context.Background(), "QQQ")
	if q := s.Quote("QQQ"); q.DayVolume != 1316237.651295 || q.DayVolumeMS != at {
		t.Fatal(q)
	}
	s.UpdateDayVolume("QQQ", 1400000, at+1)
	f.snapshot(context.Background(), "QQQ")
	if s.Quote("QQQ").DayVolume != 1400000 {
		t.Fatal("late snapshot rolled counter backwards")
	}
}
func TestDirectMassiveAggregateCounter(t *testing.T) {
	s := tape.NewStore("QQQ", 10, 2)
	f := NewMassive(config.MassiveConfig{}, s, nil)
	f.handleOutput(json.RawMessage(`{"ev":"A","sym":"QQQ","e":1792062960000,"av":100,"dav":"100.25"}`))
	if s.Quote("QQQ").DayVolume != 100.25 {
		t.Fatal(s.Quote("QQQ"))
	}
	f.handleOutput(json.RawMessage(`{"ev":"A","sym":"OLD","e":1792062960001,"av":1}`))
	if s.Quote("QQQ").DayVolume != 100.25 {
		t.Fatal("old-symbol output leaked")
	}
}
