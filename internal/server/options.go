package server

// The options panel consumes a configured local gateway with Massive-compatible
// REST responses. It never reads a Massive key or opens an options WebSocket.
import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"tape-reading-tool/internal/tape"
)

type optionContract struct {
	Ticker       string  `json:"ticker"`
	Expiry       string  `json:"expiry"`
	Kind         string  `json:"kind"`
	Strike       float64 `json:"strike"`
	IV           float64 `json:"iv"`
	Delta        float64 `json:"delta"`
	Bid          float64 `json:"bid"`
	Ask          float64 `json:"ask"`
	QuoteMS      int64   `json:"quoteMS"`
	Timeframe    string  `json:"timeframe"`
	Volume       float64 `json:"volume"`
	OpenInterest float64 `json:"openInterest"`
	BidSize      float64 `json:"bidSize,omitempty"`
	AskSize      float64 `json:"askSize,omitempty"`
}

type optionsReply struct {
	SchemaVersion int              `json:"schemaVersion"`
	Symbol        string           `json:"symbol"`
	Generation    uint64           `json:"generation"`
	Source        string           `json:"source"`
	Status        string           `json:"status"`
	AsOfMS        int64            `json:"asOfMS"`
	Spot          float64          `json:"spot"`
	Contracts     []optionContract `json:"contracts"`
	Estimated     bool             `json:"estimated,omitempty"`
	Replay        bool             `json:"replay,omitempty"`
	Method        string           `json:"method,omitempty"`
	Samples       []optionsReply   `json:"samples,omitempty"`
	Quality       *optionQuality   `json:"quality,omitempty"`
}

type optionQuality struct {
	IVBid     float64 `json:"ivBid"`
	IVAsk     float64 `json:"ivAsk"`
	MaxSpread float64 `json:"maxSpread"`
	Contracts int     `json:"contracts"`
}

type optionsPending struct {
	done    chan struct{}
	reply   optionsReply
	expires time.Time
}
type optionsService struct {
	base, token string
	client      *http.Client
	mu          sync.Mutex
	cache       map[string]*optionsPending
	archiveMu   sync.Mutex
	archiveDir  string
	archives    map[string]*optionsArchive
}

func newOptionsService() *optionsService {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("TAPE_OPTIONS_GATEWAY_URL")), "/")
	if base == "" {
		base = strings.TrimRight(strings.TrimSpace(os.Getenv("MARKET_DATA_GATEWAY_URL")), "/")
	}
	token := os.Getenv("TAPE_OPTIONS_GATEWAY_TOKEN")
	if token == "" {
		token = os.Getenv("MARKET_DATA_GATEWAY_TOKEN")
	}
	dir := os.Getenv("TAPE_OPTIONS_REPLAY_DIR")
	if dir == "" {
		dir = "data/options-replay"
	}
	return &optionsService{base: base, token: token, archiveDir: dir, archives: make(map[string]*optionsArchive), cache: make(map[string]*optionsPending), client: &http.Client{Timeout: 6 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func optionsLocalURL(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, false
	}
	ip := net.ParseIP(u.Hostname())
	return u, strings.EqualFold(u.Hostname(), "localhost") || (ip != nil && ip.IsLoopback())
}

func (s *Server) handleOptions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	// A local, same-origin browser can ask only for the selected stock. The URL
	// and optional local gateway token are operator configuration, never query input.
	if origin := r.Header.Get("Origin"); origin != "" {
		u, e := url.Parse(origin)
		if e != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
			http.Error(w, "same origin required", 403)
			return
		}
	}
	symbol := tape.NormalizeSymbol(r.URL.Query().Get("symbol"))
	q := r.URL.Query()
	validQuery := len(q["symbol"]) == 1
	for key, values := range q {
		if (key != "symbol" && key != "afterMS") || len(values) != 1 {
			validQuery = false
		}
	}
	after := int64(0)
	if q.Has("afterMS") {
		var err error
		after, err = strconv.ParseInt(q.Get("afterMS"), 10, 64)
		if err != nil || after < 0 {
			validQuery = false
		}
	}
	if symbol == "" || symbol != s.store.Active() || !validQuery {
		http.Error(w, "selected symbol required", 400)
		return
	}
	reply := optionsReply{SchemaVersion: 1, Symbol: symbol, Generation: s.store.Generation(symbol), Source: "Local options gateway", Status: "unavailable", Contracts: []optionContract{}}
	mode := s.mode
	if mode == "replay" || mode == "render" {
		clock, _, _, _ := s.panelClock()
		reply = s.options.replayAt(reply, clock, after)
		if s.store.Active() != symbol || s.store.Generation(symbol) != reply.Generation {
			reply.Status = "context-changed"
			reply.Contracts = []optionContract{}
			reply.Samples = nil
		}
		writeJSON(w, 200, reply)
		return
	}
	if mode != "live" && mode != "massive" {
		reply.Status = "live-only"
		writeJSON(w, 200, reply)
		return
	}
	if s.store.Status().Mode == "replay" {
		reply.Status = "live-only"
		writeJSON(w, 200, reply)
		return
	}
	if s.options.base == "" {
		reply.Status = "not-configured"
		writeJSON(w, 200, reply)
		return
	}
	loc, _ := time.LoadLocation("America/New_York")
	now := s.now().In(loc)
	minute := now.Hour()*60 + now.Minute()
	if now.Weekday() == time.Saturday || now.Weekday() == time.Sunday || minute < 570 || minute >= 960 {
		reply.Status = "market-closed"
		writeJSON(w, 200, reply)
		return
	}
	snap := s.store.Snapshot(symbol, 1)
	if !snap.Status.Connected || len(snap.Trades) == 0 {
		reply.Status = "waiting-tape"
		writeJSON(w, 200, reply)
		return
	}
	last := snap.Trades[len(snap.Trades)-1]
	age := now.UnixMilli() - last.ExchangeTimeMS
	if last.Price <= 0 || math.IsNaN(last.Price) || math.IsInf(last.Price, 0) || age < -2000 || age > 20000 {
		reply.Status = "waiting-tape"
		writeJSON(w, 200, reply)
		return
	}
	reply.Spot = last.Price
	reply = s.options.get(r.Context(), reply, now)
	// Symbol changes and replay transitions while the request was pending must
	// not return a valid reading for the new timeline.
	if s.store.Active() != symbol || s.store.Generation(symbol) != reply.Generation || s.store.Status().Mode == "replay" {
		reply.Status = "context-changed"
		reply.Contracts = []optionContract{}
	}
	writeJSON(w, 200, reply)
}

func (s *optionsService) get(ctx context.Context, seed optionsReply, now time.Time) optionsReply {
	key := fmt.Sprintf("%s/%d", seed.Symbol, seed.Generation)
	s.mu.Lock()
	pending := s.cache[key]
	if pending != nil && !pending.expires.IsZero() && !time.Now().Before(pending.expires) {
		delete(s.cache, key)
		pending = nil
	}
	if pending == nil {
		// A bounded cache includes in-flight requests. Refuse overload rather than
		// evicting a pending request and creating duplicate work.
		for k, p := range s.cache {
			if !p.expires.IsZero() && !time.Now().Before(p.expires) {
				delete(s.cache, k)
			}
		}
		if len(s.cache) >= 16 {
			s.mu.Unlock()
			seed.Status = "busy"
			return seed
		}
		pending = &optionsPending{done: make(chan struct{})}
		s.cache[key] = pending
		go func(p *optionsPending, requestSeed optionsReply) {
			requestCtx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
			defer cancel()
			result := s.fetch(requestCtx, requestSeed, now)
			s.mu.Lock()
			p.reply = result
			p.expires = time.Now().Add(5 * time.Second)
			close(p.done)
			s.mu.Unlock()
		}(pending, seed)
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

func (s *optionsService) fetch(ctx context.Context, reply optionsReply, now time.Time) optionsReply {
	if s.base == "" {
		reply.Status = "not-configured"
		return reply
	}
	base, valid := optionsLocalURL(s.base)
	if !valid {
		reply.Status = "gateway-config"
		return reply
	}
	path := strings.TrimRight(base.Path, "/") + "/rest/v3/snapshot/options/" + url.PathEscape(reply.Symbol)
	q := url.Values{"limit": {"250"}, "sort": {"expiration_date"}, "order": {"asc"}, "expiration_date.gte": {now.Format("2006-01-02")}, "expiration_date.lte": {now.AddDate(0, 0, 45).Format("2006-01-02")}, "strike_price.gte": {fmt.Sprintf("%.4f", reply.Spot*.90)}, "strike_price.lte": {fmt.Sprintf("%.4f", reply.Spot*1.10)}}
	target := *base
	target.Path = path
	target.RawQuery = q.Encode()
	contracts := []optionContract{}
	for page := 0; page < 8; page++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if s.token != "" {
			req.Header.Set("Authorization", "Bearer "+s.token)
		}
		res, err := s.client.Do(req)
		if err != nil {
			reply.Status = "gateway-offline"
			return reply
		}
		body, err := io.ReadAll(io.LimitReader(res.Body, (4<<20)+1))
		res.Body.Close()
		if err != nil || len(body) > 4<<20 {
			reply.Status = "invalid-data"
			return reply
		}
		if res.StatusCode != 200 {
			reply.Status = "gateway-unavailable"
			switch res.StatusCode {
			case 401, 403:
				reply.Status = "access-denied"
			case 400, 404:
				reply.Status = "gateway-update"
			case 429:
				reply.Status = "rate-limited"
			}
			return reply
		}
		var payload struct {
			Status  string `json:"status"`
			Next    string `json:"next_url"`
			Results []struct {
				Details struct {
					Ticker string  `json:"ticker"`
					Expiry string  `json:"expiration_date"`
					Kind   string  `json:"contract_type"`
					Strike float64 `json:"strike_price"`
					Shares int     `json:"shares_per_contract"`
				} `json:"details"`
				IV     float64 `json:"implied_volatility"`
				Greeks struct {
					Delta float64 `json:"delta"`
				} `json:"greeks"`
				Quote struct {
					Bid       float64 `json:"bid"`
					Ask       float64 `json:"ask"`
					Updated   int64   `json:"last_updated"`
					Timeframe string  `json:"timeframe"`
				} `json:"last_quote"`
				Day struct {
					Volume float64 `json:"volume"`
				} `json:"day"`
				OI float64 `json:"open_interest"`
			} `json:"results"`
		}
		if json.Unmarshal(body, &payload) != nil || (payload.Status != "OK" && payload.Status != "DELAYED") {
			reply.Status = "invalid-data"
			return reply
		}
		if payload.Status == "DELAYED" {
			reply.Status = "delayed"
			return reply
		}
		for _, c := range payload.Results {
			// Nonstandard adjusted contracts do not describe 100 shares of this stock.
			if c.Details.Shares != 100 {
				continue
			}
			contracts = append(contracts, optionContract{Ticker: c.Details.Ticker, Expiry: c.Details.Expiry, Kind: c.Details.Kind, Strike: c.Details.Strike, IV: c.IV, Delta: c.Greeks.Delta, Bid: c.Quote.Bid, Ask: c.Quote.Ask, QuoteMS: c.Quote.Updated / 1e6, Timeframe: c.Quote.Timeframe, Volume: c.Day.Volume, OpenInterest: c.OI})
		}
		// Sorted expiration pagination: once a third expiry is present, the
		// first two are complete. This also handles monthly-only stocks while
		// avoiding an entire multi-year chain on liquid daily-expiry names.
		expiries := map[string]bool{}
		for _, c := range contracts {
			expiries[c.Expiry] = true
		}
		if payload.Next == "" || len(expiries) >= 3 {
			if len(expiries) >= 3 {
				dates := make([]string, 0, len(expiries))
				for date := range expiries {
					dates = append(dates, date)
				}
				sort.Strings(dates)
				kept := contracts[:0]
				for _, c := range contracts {
					if c.Expiry <= dates[1] {
						kept = append(kept, c)
					}
				}
				contracts = kept
			}
			reply.Status = "ready"
			if len(contracts) == 0 {
				reply.Status = "no-options"
			}
			reply.Contracts = contracts
			reply.AsOfMS = now.UnixMilli()
			return reply
		}
		next, err := url.Parse(payload.Next)
		// The gateway rewrites pagination to its own path. Never follow an upstream URL,
		// redirect, another endpoint, or a client-supplied API key.
		if err != nil || next.IsAbs() || next.Host != "" || next.Path != path || next.Fragment != "" || next.Query().Has("apiKey") || next.Query().Has("apikey") {
			reply.Status = "invalid-data"
			return reply
		}
		target = *base
		target.Path = next.Path
		target.RawQuery = next.RawQuery
	}
	reply.Status = "chain-too-large" // partial chains cannot silently select a biased ATM basket
	return reply
}
