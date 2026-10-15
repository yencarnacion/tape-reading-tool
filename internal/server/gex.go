package server

// GEX is a positioning proxy over a separately paginated chain. It does not
// reuse the IV panel's ATM basket or infer dealer inventory from option flow.
import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"tape-reading-tool/internal/tape"
)

const gexModel = "calls-positive-puts-negative"
const gexMaxPages = 64
const gexMaxAgeMS = 90000

type gexBucket struct {
	Strike float64 `json:"strike,omitempty"`
	Expiry string  `json:"expiry,omitempty"`
	Call   float64 `json:"call"`
	Put    float64 `json:"put"`
	Net    float64 `json:"net"`
}

type gexCoverage struct {
	Seen         int     `json:"seen"`
	Included     int     `json:"included"`
	MissingGamma int     `json:"missingGamma"`
	MissingOI    int     `json:"missingOI"`
	Nonstandard  int     `json:"nonstandard"`
	Invalid      int     `json:"invalid"`
	KnownOI      float64 `json:"knownOI"`
	IncludedOI   float64 `json:"includedOI"`
	OIFraction   float64 `json:"oiFraction"`
}

type gexReply struct {
	SchemaVersion  int         `json:"schemaVersion"`
	Symbol         string      `json:"symbol"`
	Generation     uint64      `json:"generation"`
	Status         string      `json:"status"`
	AsOfMS         int64       `json:"asOfMS"`
	Spot           float64     `json:"spot"`
	SpotMS         int64       `json:"spotMS"`
	UnderlyingMS   int64       `json:"underlyingMS"`
	MaxDTE         int         `json:"maxDTE"`
	ThroughExpiry  string      `json:"throughExpiry"`
	Model          string      `json:"model"`
	OIConvention   string      `json:"oiConvention"`
	GreekTimeKnown bool        `json:"greekTimeKnown"`
	Complete       bool        `json:"complete"`
	Net            *float64    `json:"net"`
	Gross          *float64    `json:"gross"`
	Call           *float64    `json:"call"`
	Put            *float64    `json:"put"`
	Coverage       gexCoverage `json:"coverage"`
	Strikes        []gexBucket `json:"strikes"`
	Expiries       []gexBucket `json:"expiries"`
	Source         string      `json:"source"`
	Replay         bool        `json:"replay,omitempty"`
	Recording      string      `json:"recording,omitempty"`
}

type gexContract struct {
	Details struct {
		Ticker string  `json:"ticker"`
		Expiry string  `json:"expiration_date"`
		Kind   string  `json:"contract_type"`
		Strike float64 `json:"strike_price"`
		Shares int     `json:"shares_per_contract"`
	} `json:"details"`
	Greeks struct {
		Gamma *float64 `json:"gamma"`
	} `json:"greeks"`
	OI         *float64 `json:"open_interest"`
	Underlying struct {
		Ticker    string  `json:"ticker"`
		Price     float64 `json:"price"`
		Updated   int64   `json:"last_updated"`
		Timeframe string  `json:"timeframe"`
	} `json:"underlying_asset"`
}

type gexPending struct {
	done    chan struct{}
	reply   gexReply
	expires time.Time
}

type gexService struct {
	gateway *optionsService
	now     func() time.Time
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	mu      sync.Mutex
	cache   map[string]*gexPending
	archive *gexArchiveStore
}

func newGEXService(gateway *optionsService, now func() time.Time) *gexService {
	ctx, cancel := context.WithCancel(context.Background())
	return &gexService{gateway: gateway, now: now, ctx: ctx, cancel: cancel,
		cache: make(map[string]*gexPending), archive: newGEXArchiveStore()}
}

func (s *gexService) close()       { s.mu.Lock(); s.cancel(); s.mu.Unlock(); s.wg.Wait() }
func validGEXDTE(dte int) bool     { return dte == 30 || dte == 60 || dte == 120 }
func finiteGEX(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
func gexLocation() *time.Location  { loc, _ := time.LoadLocation("America/New_York"); return loc }
func gexRTH(at time.Time) bool {
	at = at.In(gexLocation())
	minute := at.Hour()*60 + at.Minute()
	return at.Weekday() != time.Saturday && at.Weekday() != time.Sunday && minute >= 570 && minute < 960
}

func (s *Server) handleGEX(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
			http.Error(w, "same origin required", 403)
			return
		}
	}
	query := r.URL.Query()
	symbol := tape.NormalizeSymbol(query.Get("symbol"))
	dte := 120
	valid := len(query["symbol"]) == 1
	for key, values := range query {
		if (key != "symbol" && key != "dte") || len(values) != 1 {
			valid = false
		}
	}
	if query.Has("dte") {
		var err error
		dte, err = strconv.Atoi(query.Get("dte"))
		valid = valid && err == nil
	}
	if !valid || !validGEXDTE(dte) || symbol == "" || symbol != s.store.Active() {
		http.Error(w, "selected symbol and supported expiry window required", 400)
		return
	}
	clock, mode, _, _ := s.panelClock()
	seed := gexReply{SchemaVersion: 1, Symbol: symbol, Generation: s.store.Generation(symbol),
		Status: "unavailable", MaxDTE: dte, Model: gexModel, Source: "Local options chain snapshot",
		OIConvention: "previous trading day; reporting date not supplied", Strikes: []gexBucket{}, Expiries: []gexBucket{}}
	var reply gexReply
	if mode == "replay" || mode == "render" {
		reply = s.gex.archive.replayAt(seed, clock)
	} else if mode != "live" && mode != "massive" || s.store.Status().Mode == "replay" {
		reply = seed
		reply.Status = "live-only"
	} else if !gexRTH(clock) {
		reply = seed
		reply.Status = "market-closed"
	} else {
		snapshot := s.store.Snapshot(symbol, 1)
		seed.Spot, seed.SpotMS = snapshot.Quote.LastPrice, snapshot.Quote.LastTimeMS
		age := clock.UnixMilli() - seed.SpotMS
		if !snapshot.Status.Connected || !finiteGEX(seed.Spot) || seed.Spot <= 0 || age < -2000 || age > 20000 {
			reply = seed
			reply.Status = "waiting-tape"
		} else {
			reply = s.gex.get(r.Context(), seed, clock)
		}
	}
	currentClock, currentMode, _, _ := s.panelClock()
	if s.store.Active() != symbol || s.store.Generation(symbol) != seed.Generation || currentMode != mode || (mode != "replay" && mode != "render" && s.store.Status().Mode == "replay") {
		reply = seed
		reply.Status = "context-changed"
	} else if !reply.Replay && (!gexRTH(currentClock) || currentClock.In(gexLocation()).Format("2006-01-02") != clock.In(gexLocation()).Format("2006-01-02")) {
		reply = seed
		reply.Status = "market-closed"
	} else if !reply.Replay && reply.Complete && reply.Net != nil {
		// HTTP work, never a stock-feed callback; write only the selected timeline.
		reply.Recording = s.gex.archive.record(reply)
	}
	writeJSON(w, 200, reply)
}

func (s *gexService) get(ctx context.Context, seed gexReply, now time.Time) gexReply {
	key := fmt.Sprintf("%s/%d/%s/%d", seed.Symbol, seed.Generation, now.In(gexLocation()).Format("2006-01-02"), seed.MaxDTE)
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		seed.Status = "unavailable"
		return seed
	}
	for k, entry := range s.cache {
		if !entry.expires.IsZero() && !now.Before(entry.expires) {
			delete(s.cache, k)
		}
	}
	pending := s.cache[key]
	// A moved stock deserves a new chain, but at most once every 15 seconds.
	if pending != nil && !pending.expires.IsZero() && pending.reply.Spot > 0 &&
		math.Abs(seed.Spot/pending.reply.Spot-1) >= .01 && now.UnixMilli()-pending.reply.AsOfMS >= 15000 {
		delete(s.cache, key)
		pending = nil
	}
	if pending == nil {
		if len(s.cache) >= 16 {
			s.mu.Unlock()
			seed.Status = "busy"
			return seed
		}
		pending = &gexPending{done: make(chan struct{})}
		s.cache[key] = pending
		s.wg.Add(1)
		go func(entry *gexPending) {
			defer s.wg.Done()
			request, cancel := context.WithTimeout(s.ctx, 20*time.Second)
			defer cancel()
			result := s.fetch(request, seed, now)
			s.mu.Lock()
			entry.reply = result
			ttl := 60 * time.Second
			if !result.Complete {
				ttl = 15 * time.Second
			}
			entry.expires = s.now().Add(ttl)
			close(entry.done)
			s.mu.Unlock()
		}(pending)
	}
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		seed.Status = "unavailable"
		return seed
	case <-pending.done:
		return pending.reply
	}
}

func (s *gexService) fetch(ctx context.Context, seed gexReply, began time.Time) gexReply {
	if s.gateway.base == "" {
		seed.Status = "not-configured"
		return seed
	}
	base, valid := optionsLocalURL(s.gateway.base)
	if !valid {
		seed.Status = "gateway-config"
		return seed
	}
	date := began.In(gexLocation()).Format("2006-01-02")
	through := began.In(gexLocation()).AddDate(0, 0, seed.MaxDTE).Format("2006-01-02")
	path := strings.TrimRight(base.Path, "/") + "/rest/v3/snapshot/options/" + url.PathEscape(seed.Symbol)
	target := *base
	target.Path = path
	target.RawQuery = url.Values{"limit": {"250"}, "sort": {"expiration_date"}, "order": {"asc"}, "expiration_date.gte": {date}, "expiration_date.lte": {through}}.Encode()
	seenPages, seenContracts := map[string]bool{}, map[string]bool{}
	contracts := make([]gexContract, 0)
	for page := 0; page < gexMaxPages; page++ {
		if seenPages[target.String()] {
			seed.Status = "invalid-data"
			return seed
		}
		seenPages[target.String()] = true
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			seed.Status = "gateway-config"
			return seed
		}
		request.Header.Set("X-DaiDai-Priority", "interactive")
		if s.gateway.token != "" {
			request.Header.Set("Authorization", "Bearer "+s.gateway.token)
		}
		response, err := s.gateway.client.Do(request)
		if err != nil {
			seed.Status = "gateway-offline"
			return seed
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
		response.Body.Close()
		if readErr != nil || len(body) > 4<<20 {
			seed.Status = "invalid-data"
			return seed
		}
		if response.StatusCode != 200 {
			seed.Status = "gateway-unavailable"
			if response.StatusCode == 401 || response.StatusCode == 403 {
				seed.Status = "access-denied"
			}
			if response.StatusCode == 429 {
				seed.Status = "rate-limited"
			}
			return seed
		}
		var payload struct {
			Status  string        `json:"status"`
			Next    string        `json:"next_url"`
			Results []gexContract `json:"results"`
		}
		if json.Unmarshal(body, &payload) != nil || (payload.Status != "OK" && payload.Status != "DELAYED") {
			seed.Status = "invalid-data"
			return seed
		}
		if payload.Status == "DELAYED" {
			seed.Status = "delayed"
			return seed
		}
		if len(payload.Results) > 250 {
			seed.Status = "invalid-data"
			return seed
		}
		for _, contract := range payload.Results {
			if contract.Details.Ticker == "" || seenContracts[contract.Details.Ticker] ||
				(contract.Underlying.Ticker != "" && tape.NormalizeSymbol(contract.Underlying.Ticker) != seed.Symbol) {
				seed.Status = "invalid-data"
				return seed
			}
			seenContracts[contract.Details.Ticker] = true
			contracts = append(contracts, contract)
		}
		if payload.Next == "" {
			seed.ThroughExpiry = through
			return calculateGEX(seed, contracts, date, through, s.now())
		}
		next, err := url.Parse(payload.Next)
		if err != nil || next.IsAbs() || next.Host != "" || next.Path != path || next.Fragment != "" || next.Query().Has("apiKey") || next.Query().Has("apikey") {
			seed.Status = "invalid-data"
			return seed
		}
		target = *base
		target.Path = next.Path
		target.RawQuery = next.RawQuery
	}
	seed.Status = "chain-too-large" // No directional number from a truncated chain.
	return seed
}

func gexTimestampMS(timestamp int64) int64 {
	if timestamp > 1e16 {
		return timestamp / 1e6
	}
	if timestamp > 1e14 {
		return timestamp / 1000
	}
	return timestamp
}

func calculateGEX(reply gexReply, contracts []gexContract, date, through string, at time.Time) gexReply {
	if !finiteGEX(reply.Spot) || reply.Spot <= 0 {
		reply.Status = "invalid-data"
		return reply
	}
	reply.AsOfMS = at.UnixMilli()
	reply.Complete = true
	strikes, expiries := map[float64]*gexBucket{}, map[string]*gexBucket{}
	call, put := 0.0, 0.0
	unknownFreshness, stale, delayed := false, false, false
	for _, contract := range contracts {
		detail := contract.Details
		if detail.Expiry < date || detail.Expiry > through {
			reply.Complete = false
			reply.Status = "invalid-data"
			return reply
		}
		if parsed, err := time.Parse("2006-01-02", detail.Expiry); err != nil || parsed.Format("2006-01-02") != detail.Expiry {
			reply.Complete = false
			reply.Status = "invalid-data"
			return reply
		}
		reply.Coverage.Seen++
		validOI := contract.OI != nil && finiteGEX(*contract.OI) && *contract.OI >= 0 && *contract.OI <= 1e12 && math.Trunc(*contract.OI) == *contract.OI
		if validOI {
			reply.Coverage.KnownOI += *contract.OI
		} else {
			reply.Coverage.MissingOI++
		}
		if detail.Shares != 100 {
			reply.Coverage.Nonstandard++
			continue
		}
		if !finiteGEX(detail.Strike) || detail.Strike <= 0 || (detail.Kind != "call" && detail.Kind != "put") {
			reply.Coverage.Invalid++
			continue
		}
		if !validOI {
			continue
		}
		// Known zero open interest has exactly zero exposure, even without gamma.
		if *contract.OI > 0 && (contract.Greeks.Gamma == nil || !finiteGEX(*contract.Greeks.Gamma) || *contract.Greeks.Gamma < 0) {
			reply.Coverage.MissingGamma++
			continue
		}
		value := 0.0
		if *contract.OI > 0 {
			value = *contract.Greeks.Gamma * *contract.OI * 100 * reply.Spot * reply.Spot * .01
			if !finiteGEX(value) {
				reply.Coverage.Invalid++
				continue
			}
			updated := gexTimestampMS(contract.Underlying.Updated)
			if updated <= 0 {
				unknownFreshness = true
			} else {
				if reply.UnderlyingMS == 0 || updated < reply.UnderlyingMS {
					reply.UnderlyingMS = updated
				}
				if reply.AsOfMS-updated > gexMaxAgeMS || updated > reply.AsOfMS+2000 {
					stale = true
				}
			}
			if contract.Underlying.Timeframe == "DELAYED" {
				delayed = true
			}
			if !finiteGEX(contract.Underlying.Price) || contract.Underlying.Price <= 0 {
				unknownFreshness = true
			} else if math.Abs(contract.Underlying.Price/reply.Spot-1) > .01 {
				stale = true
			}
		}
		reply.Coverage.Included++
		reply.Coverage.IncludedOI += *contract.OI
		if detail.Kind == "put" {
			value = -value
			put += value
		} else {
			call += value
		}
		if strikes[detail.Strike] == nil {
			strikes[detail.Strike] = &gexBucket{Strike: detail.Strike}
		}
		if expiries[detail.Expiry] == nil {
			expiries[detail.Expiry] = &gexBucket{Expiry: detail.Expiry}
		}
		for _, bucket := range []*gexBucket{strikes[detail.Strike], expiries[detail.Expiry]} {
			if detail.Kind == "call" {
				bucket.Call += value
			} else {
				bucket.Put += value
			}
			bucket.Net += value
		}
	}
	if reply.Coverage.Seen == 0 {
		reply.Status = "no-options"
		return reply
	}
	if reply.Coverage.Included == 0 {
		reply.Status = "insufficient"
		return reply
	}
	if reply.Coverage.KnownOI > 0 {
		reply.Coverage.OIFraction = reply.Coverage.IncludedOI / reply.Coverage.KnownOI
	} else if reply.Coverage.MissingOI == 0 {
		reply.Coverage.OIFraction = 1
	}
	net, gross := call+put, call-put
	if !finiteGEX(net) || !finiteGEX(gross) {
		reply.Status = "invalid-data"
		return reply
	}
	reply.Net, reply.Gross, reply.Call, reply.Put = &net, &gross, &call, &put
	for _, bucket := range strikes {
		reply.Strikes = append(reply.Strikes, *bucket)
	}
	for _, bucket := range expiries {
		reply.Expiries = append(reply.Expiries, *bucket)
	}
	sort.Slice(reply.Strikes, func(i, j int) bool { return reply.Strikes[i].Strike < reply.Strikes[j].Strike })
	sort.Slice(reply.Expiries, func(i, j int) bool { return reply.Expiries[i].Expiry < reply.Expiries[j].Expiry })
	reply.Status = "ready"
	if reply.Coverage.OIFraction < .9 || float64(reply.Coverage.Included)/float64(reply.Coverage.Seen) < .8 || reply.Coverage.MissingOI > 0 {
		reply.Status = "poor-coverage"
	}
	if unknownFreshness && gross > 0 {
		reply.Status = "freshness-unknown"
	}
	if stale {
		reply.Status = "stale"
	}
	if delayed {
		reply.Status = "delayed"
	}
	return reply
}
