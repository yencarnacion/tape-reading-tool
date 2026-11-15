// Package gexbot adapts classified Gexbot data for causal live/replay displays.
// This package is mirrored in Tape Reading Tool; keep the two copies identical.
package gexbot

import (
	"encoding/json"
	"errors"
	"math"
	"sort"
	"time"
)

const MaxAgeMS int64 = 15000

var NY, _ = time.LoadLocation("America/New_York")
var Kinds = []string{"gex_zero", "gex_one", "gex_full", "orderflow"}

// AvailableMS is receipt time for live captures, provider time for imported
// history. Replay never exposes either a future event or a later receipt.
type Record struct {
	Version     int          `json:"v"`
	Symbol      string       `json:"symbol"`
	Kind        string       `json:"kind"`
	TimeMS      int64        `json:"timeMS"`
	AvailableMS int64        `json:"availableMS"`
	Origin      string       `json:"origin"`
	Spot        float64      `json:"spot"`
	DTE         *int         `json:"dte,omitempty"`
	NextDTE     *int         `json:"nextDTE,omitempty"`
	Strikes     [][2]float64 `json:"strikes,omitempty"`
	Net         *float64     `json:"net,omitempty"`
	Cumulative  [2]*float64  `json:"cumulative,omitempty"`
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func Date(ms int64) string  { return time.UnixMilli(ms).In(NY).Format("2006-01-02") }
func RTH(ms int64) bool {
	t := time.UnixMilli(ms).In(NY)
	m := t.Hour()*60 + t.Minute()
	return t.Weekday() != time.Saturday && t.Weekday() != time.Sunday && m >= 570 && m <= 960
}
func ValidKind(k string) bool {
	for _, v := range Kinds {
		if k == v {
			return true
		}
	}
	return false
}
func Normalize(body []byte, symbol, kind string, received int64, origin string) (Record, error) {
	var p struct {
		Timestamp float64           `json:"timestamp"`
		Ticker    string            `json:"ticker"`
		Spot      *float64          `json:"spot"`
		DTE       *int              `json:"min_dte"`
		NextDTE   *int              `json:"sec_min_dte"`
		Strikes   []json.RawMessage `json:"strikes"`
		Net       *float64          `json:"sum_gex_vol"`
		Agg       *float64          `json:"agg_dex"`
		NextAgg   *float64          `json:"one_agg_dex"`
	}
	fail := errors.New("invalid Gexbot snapshot")
	if json.Unmarshal(body, &p) != nil || p.Ticker != symbol || !ValidKind(kind) || p.Timestamp < 1e9 || p.Timestamp > 1e11 || p.Spot == nil || !finite(*p.Spot) || *p.Spot <= 0 {
		return Record{}, fail
	}
	ms := int64(p.Timestamp * 1000)
	if received == 0 {
		received = ms
	}
	if ms > received+2000 {
		return Record{}, fail
	}
	r := Record{Version: 1, Symbol: symbol, Kind: kind, TimeMS: ms, AvailableMS: received, Origin: origin, Spot: *p.Spot, DTE: p.DTE, NextDTE: p.NextDTE, Net: p.Net}
	if kind == "orderflow" {
		if p.Agg == nil || p.NextAgg == nil || !finite(*p.Agg) || !finite(*p.NextAgg) {
			return Record{}, fail
		}
		r.Cumulative = [2]*float64{p.Agg, p.NextAgg}
		r.DTE = nil
		r.NextDTE = nil
		r.Net = nil
	} else {
		if p.DTE == nil || p.NextDTE == nil || *p.DTE < 0 || *p.NextDTE < 0 || *p.DTE > 366 || *p.NextDTE > 366 || p.Net == nil || !finite(*p.Net) || len(p.Strikes) == 0 || len(p.Strikes) > 20000 {
			return Record{}, fail
		}
		seen := map[float64]bool{}
		for _, raw := range p.Strikes {
			var a []json.RawMessage
			var strike, value float64
			if json.Unmarshal(raw, &a) != nil || len(a) < 2 || json.Unmarshal(a[0], &strike) != nil || json.Unmarshal(a[1], &value) != nil || !finite(strike) || !finite(value) || strike <= 0 || seen[strike] {
				return Record{}, fail
			}
			seen[strike] = true
			// Store the complete source profile; ranking belongs to the display model.
			r.Strikes = append(r.Strikes, [2]float64{strike, value})
		}
		sort.Slice(r.Strikes, func(i, j int) bool { return r.Strikes[i][0] < r.Strikes[j][0] })
	}
	return r, nil
}

type Profile struct {
	Kind    string       `json:"kind"`
	Status  string       `json:"status"`
	TimeMS  int64        `json:"timeMS"`
	Expiry  string       `json:"expiry,omitempty"`
	DTE     *int         `json:"dte,omitempty"`
	Spot    float64      `json:"spot"`
	Net     *float64     `json:"net,omitempty"`
	Strikes [][2]float64 `json:"strikes,omitempty"`
	Origin  string       `json:"origin,omitempty"`
}
type Window struct {
	Seconds   int      `json:"seconds"`
	Delta     *float64 `json:"delta"`
	Prior     *float64 `json:"prior"`
	Agreement float64  `json:"agreement"`
	Samples   int      `json:"samples"`
	Status    string   `json:"status"`
}
type Flow struct {
	Kind       string   `json:"kind"`
	Expiry     string   `json:"expiry,omitempty"`
	Status     string   `json:"status"`
	TimeMS     int64    `json:"timeMS"`
	Origin     string   `json:"origin,omitempty"`
	Cumulative *float64 `json:"cumulative"`
	Windows    []Window `json:"windows"`
}
type View struct {
	Version       int       `json:"version"`
	Symbol        string    `json:"symbol"`
	ClockMS       int64     `json:"clockMS"`
	Replay        bool      `json:"replay"`
	Status        string    `json:"status"`
	Recording     string    `json:"recording,omitempty"`
	HistoryStatus string    `json:"historyStatus,omitempty"`
	Profiles      []Profile `json:"profiles"`
	Flows         []Flow    `json:"flows"`
}

func eligible(r Record, at int64) bool {
	return r.Version == 1 && r.TimeMS <= at && r.AvailableMS <= at && Date(r.TimeMS) == Date(at) && Date(r.AvailableMS) == Date(at)
}
func indexAt(rows []Record, at int64) int {
	i := sort.Search(len(rows), func(i int) bool { return rows[i].AvailableMS > at }) - 1
	for i >= 0 && !eligible(rows[i], at) {
		i--
	}
	return i
}
func stale(r Record, at int64) bool { return at-r.TimeMS > MaxAgeMS || !eligible(r, at) }
func Build(symbol string, at int64, replay bool, records map[string][]Record) View {
	v := View{Version: 1, Symbol: symbol, ClockMS: at, Replay: replay, Status: "unavailable", Profiles: []Profile{}, Flows: []Flow{}}
	for _, k := range Kinds[:3] {
		p := Profile{Kind: k, Status: "not-recorded"}
		rows := records[k]
		i := indexAt(rows, at)
		if i >= 0 {
			r := rows[i]
			p.TimeMS = r.TimeMS
			p.Origin = r.Origin
			if stale(r, at) {
				p.Status = "stale"
			} else {
				p.Status = "ready"
				p.Spot = r.Spot
				p.Net = r.Net
				p.Strikes = r.Strikes
				p.DTE = r.DTE
				if k == "gex_one" {
					p.DTE = r.NextDTE
				}
				if k == "gex_full" {
					p.DTE = nil
				}
				if p.DTE != nil {
					p.Expiry = time.UnixMilli(r.TimeMS).In(NY).AddDate(0, 0, *p.DTE).Format("2006-01-02")
				}
				v.Status = "ready"
			}
		}
		v.Profiles = append(v.Profiles, p)
	}
	rows := records["orderflow"]
	i := indexAt(rows, at)
	for side := 0; side < 2; side++ {
		f := Flow{Kind: Kinds[side], Status: "not-recorded", Expiry: v.Profiles[side].Expiry, Windows: []Window{}}
		if i >= 0 {
			r := rows[i]
			f.TimeMS = r.TimeMS
			f.Origin = r.Origin
			if stale(r, at) {
				f.Status = "stale"
			} else {
				f.Status = "ready"
				f.Cumulative = r.Cumulative[side]
				for _, sec := range []int{15, 60, 300} {
					f.Windows = append(f.Windows, flowWindow(rows, i, side, sec))
				}
			}
		}
		v.Flows = append(v.Flows, f)
	}
	return v
}

// Differences in cumulative transaction delta measure NEW flow. Differences in
// net chain exposure would incorrectly mix repricing with transactions.
func flowWindow(rows []Record, end, side, sec int) Window {
	w := Window{Seconds: sec, Status: "warming"}
	last := rows[end]
	at := last.TimeMS - int64(sec)*1000
	start := indexAt(rows, at)
	if start < 0 || at-rows[start].TimeMS > 5000 || last.Cumulative[side] == nil {
		return w
	}
	gross := 0.0
	for j := start + 1; j <= end; j++ {
		a, b := rows[j-1], rows[j]
		if b.TimeMS-a.TimeMS > MaxAgeMS || b.TimeMS <= a.TimeMS || Date(a.TimeMS) != Date(last.TimeMS) || a.Cumulative[side] == nil || b.Cumulative[side] == nil {
			w.Status = "gap"
			return w
		}
		gross += math.Abs(*b.Cumulative[side] - *a.Cumulative[side])
		w.Samples++
	}
	d := *last.Cumulative[side] - *rows[start].Cumulative[side]
	w.Delta = &d
	w.Status = "ready"
	if gross > 0 {
		w.Agreement = math.Min(1, math.Abs(d)/gross)
	}
	priorEnd := start
	p := flowWindowPrior(rows, priorEnd, side, sec)
	w.Prior = p
	return w
}
func flowWindowPrior(rows []Record, end, side, sec int) *float64 {
	at := rows[end].TimeMS - int64(sec)*1000
	start := indexAt(rows, at)
	if start < 0 || at-rows[start].TimeMS > 5000 {
		return nil
	}
	for j := start + 1; j <= end; j++ {
		if rows[j].TimeMS-rows[j-1].TimeMS > MaxAgeMS || rows[j].Cumulative[side] == nil || rows[j-1].Cumulative[side] == nil {
			return nil
		}
	}
	d := *rows[end].Cumulative[side] - *rows[start].Cumulative[side]
	return &d
}
