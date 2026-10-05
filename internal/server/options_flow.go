package server

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"tape-reading-tool/internal/tape"
)

type flowWindow struct {
	Seconds          int     `json:"seconds"`
	ObservedSeconds  int     `json:"observedSeconds"`
	CallAsk          float64 `json:"callAsk"`
	CallBid          float64 `json:"callBid"`
	PutAsk           float64 `json:"putAsk"`
	PutBid           float64 `json:"putBid"`
	Unknown          float64 `json:"unknown"`
	Prints           int     `json:"prints"`
	ClassifiedPrints int     `json:"classifiedPrints"`
	LargePrints      int     `json:"largePrints"`
	Bull             float64 `json:"bull"`
	Bear             float64 `json:"bear"`
	Net              float64 `json:"net"`
	Coverage         float64 `json:"coverage"`
	Ready            bool    `json:"ready"`
}
type flowReply struct {
	SchemaVersion   int          `json:"schemaVersion"`
	Symbol          string       `json:"symbol"`
	Generation      uint64       `json:"generation"`
	Status          string       `json:"status"`
	AsOfMS          int64        `json:"asOfMS"`
	StartedMS       int64        `json:"startedMS"`
	LastTradeMS     int64        `json:"lastTradeMS"`
	LastQuoteMS     int64        `json:"lastQuoteMS"`
	Contracts       int          `json:"contracts"`
	UniverseLimited bool         `json:"universeLimited"`
	Windows         []flowWindow `json:"windows"`
	Previous15      flowWindow   `json:"previous15"`
	Rejected        int          `json:"rejected"`
	Recording       string       `json:"recording"`
}

func (s *Server) handleOptionsFlow(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, e := url.Parse(origin)
		if e != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
			http.Error(w, "same origin required", 403)
			return
		}
	}
	q := r.URL.Query()
	symbol := tape.NormalizeSymbol(q.Get("symbol"))
	if len(q) != 1 || len(q["symbol"]) != 1 || symbol == "" || symbol != s.store.Active() {
		http.Error(w, "selected symbol required", 400)
		return
	}
	reply := flowReply{SchemaVersion: 1, Symbol: symbol, Generation: s.store.Generation(symbol), Status: "unavailable", Recording: "off"}
	fail := func(status string) { reply.Status = status; reply.Windows = nil; writeJSON(w, 200, reply) }
	if s.mode == "replay" || s.mode == "render" || s.store.Status().Mode == "replay" {
		fail("replay-unavailable")
		return
	}
	if s.mode != "live" && s.mode != "massive" {
		fail("live-only")
		return
	}
	if s.options.base == "" {
		fail("not-configured")
		return
	}
	base, valid := optionsLocalURL(s.options.base)
	if !valid {
		fail("not-configured")
		return
	}
	now := s.now()
	loc, _ := time.LoadLocation("America/New_York")
	et := now.In(loc)
	minute := et.Hour()*60 + et.Minute()
	if et.Weekday() == time.Saturday || et.Weekday() == time.Sunday || minute < 570 || minute >= 960 {
		fail("market-closed")
		return
	}
	snap := s.store.Snapshot(symbol, 1)
	if !snap.Status.Connected || len(snap.Trades) == 0 {
		fail("waiting-tape")
		return
	}
	trade := snap.Trades[len(snap.Trades)-1]
	age := now.UnixMilli() - trade.ExchangeTimeMS
	if trade.Price <= 0 || math.IsNaN(trade.Price) || math.IsInf(trade.Price, 0) || age < -1000 || age > 20000 {
		fail("waiting-tape")
		return
	}
	base.Path += "/options-flow"
	base.RawQuery = url.Values{"symbol": {symbol}, "spot": {strconv.FormatFloat(trade.Price, 'f', 6, 64)}}.Encode()
	req, _ := http.NewRequestWithContext(r.Context(), "GET", base.String(), nil)
	if s.options.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.options.token)
	}
	res, err := s.options.client.Do(req)
	if err != nil {
		fail("gateway-offline")
		return
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		fail("gateway-upgrade")
		return
	}
	if res.StatusCode != 200 {
		fail("gateway-offline")
		return
	}
	var upstream flowReply
	if json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&upstream) != nil || !validFlowReply(upstream, symbol, now.UnixMilli()) {
		fail("invalid-data")
		return
	}
	if s.store.Active() != symbol || s.store.Generation(symbol) != reply.Generation || s.store.Status().Mode == "replay" {
		fail("context-changed")
		return
	}
	upstream.Generation = reply.Generation
	writeJSON(w, 200, upstream)
}
func validFlowReply(r flowReply, symbol string, now int64) bool {
	if r.SchemaVersion != 1 || r.Symbol != symbol || r.AsOfMS > now+2000 || now-r.AsOfMS > 5000 || r.Contracts < 0 || r.Contracts > 80 {
		return false
	}
	switch r.Status {
	case "connecting", "streaming", "collecting", "ready", "stale", "gateway-offline", "not-entitled", "delayed", "invalid-data", "no-options", "market-closed", "refreshing":
	default:
		return false
	}
	switch r.Recording {
	case "off", "recording", "incomplete", "failed":
	default:
		return false
	}
	if len(r.Windows) == 0 {
		return r.Status != "ready" && r.Status != "stale"
	}
	if len(r.Windows) != 3 || r.StartedMS <= 0 || r.StartedMS > r.AsOfMS || r.LastTradeMS > r.AsOfMS+1000 || r.LastQuoteMS > r.AsOfMS+1000 {
		return false
	}
	windows := append(append([]flowWindow{}, r.Windows...), r.Previous15)
	for i, w := range windows {
		if w.Seconds != []int{15, 60, 300, 15}[i] || w.ObservedSeconds < 0 || w.ObservedSeconds > w.Seconds || w.Prints < 0 || w.ClassifiedPrints < 0 || w.ClassifiedPrints > w.Prints || w.LargePrints < 0 || w.LargePrints > w.ClassifiedPrints || w.Coverage < 0 || w.Coverage > 1 {
			return false
		}
		for _, v := range []float64{w.CallAsk, w.CallBid, w.PutAsk, w.PutBid, w.Unknown, w.Bull, w.Bear} {
			if v < 0 || v > 1e15 {
				return false
			}
		}
		if math.Abs(w.Bull-w.CallAsk-w.PutBid) > .01 || math.Abs(w.Bear-w.CallBid-w.PutAsk) > .01 || math.Abs(w.Net-w.Bull+w.Bear) > .01 {
			return false
		}
		total := w.Bull + w.Bear + w.Unknown
		coverage := 0.0
		if total > 0 {
			coverage = (w.Bull + w.Bear) / total
		}
		if math.Abs(w.Coverage-coverage) > 1e-6 {
			return false
		}
		if w.Ready && (w.ObservedSeconds < w.Seconds || w.ClassifiedPrints < 5 || w.Bull+w.Bear < 10000 || w.Coverage < .6) {
			return false
		}
	}
	return true
}
