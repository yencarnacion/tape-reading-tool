package tape

import (
	"math"
	"strings"
	"sync"
	"time"
)

type Classification string

const (
	BelowBid Classification = "below"
	AtBid    Classification = "bid"
	Between  Classification = "mid"
	AtAsk    Classification = "ask"
	AboveAsk Classification = "above"
)

type Trade struct {
	Seq            uint64         `json:"s"`
	ExchangeTimeMS int64          `json:"t"`
	ReceivedUS     int64          `json:"r"`
	Price          float64        `json:"p"`
	Size           float64        `json:"z"`
	Class          Classification `json:"c"`
	Side           int8           `json:"d"`
	Bid            float64        `json:"b,omitempty"`
	Ask            float64        `json:"a,omitempty"`
}

type Quote struct {
	Bid     float64 `json:"bid"`
	Ask     float64 `json:"ask"`
	BidSize float64 `json:"bid_size"`
	AskSize float64 `json:"ask_size"`
}

type FeedStatus struct {
	Mode      string `json:"mode"`
	State     string `json:"state"`
	Message   string `json:"message,omitempty"`
	Connected bool   `json:"connected"`
	UpdatedMS int64  `json:"updated_ms"`
}

type Snapshot struct {
	Symbol  string     `json:"symbol"`
	Quote   Quote      `json:"quote"`
	Trades  []Trade    `json:"trades"`
	History []string   `json:"history"`
	Status  FeedStatus `json:"status"`
}

type Store struct {
	mu          sync.RWMutex
	tapes       map[string]*symbolTape
	active      string
	history     []string
	ringSize    int
	historySize int
	status      FeedStatus
}

type symbolTape struct {
	mu        sync.RWMutex
	symbol    string
	items     []Trade
	start     int
	count     int
	nextSeq   uint64
	quote     Quote
	lastPrice float64
	lastSide  int8
}

func NewStore(defaultSymbol string, ringSize, historySize int) *Store {
	symbol := NormalizeSymbol(defaultSymbol)
	s := &Store{
		tapes: make(map[string]*symbolTape), active: symbol,
		ringSize: ringSize, historySize: historySize,
		status: FeedStatus{State: "starting", UpdatedMS: time.Now().UnixMilli()},
	}
	s.tapes[symbol] = newSymbolTape(symbol, ringSize)
	s.history = []string{symbol}
	return s
}

func NormalizeSymbol(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) < 1 || len(value) > 16 {
		return ""
	}
	for _, r := range value {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '.' && r != '-' {
			return ""
		}
	}
	return value
}

func (s *Store) Activate(symbol string) bool {
	symbol = NormalizeSymbol(symbol)
	if symbol == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tapes[symbol]; !ok {
		s.tapes[symbol] = newSymbolTape(symbol, s.ringSize)
	}
	s.active = symbol
	history := []string{symbol}
	for _, item := range s.history {
		if item != symbol && len(history) < s.historySize {
			history = append(history, item)
		}
	}
	s.history = history
	return true
}

func (s *Store) Active() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.active
}

func (s *Store) Symbols() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string(nil), s.history...)
}

func (s *Store) SetStatus(status FeedStatus) {
	status.UpdatedMS = time.Now().UnixMilli()
	s.mu.Lock()
	s.status = status
	s.mu.Unlock()
}

func (s *Store) Status() FeedStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

func (s *Store) UpdateQuote(symbol string, bid, ask, bidSize, askSize float64) {
	tape := s.getOrCreate(symbol)
	if tape == nil {
		return
	}
	tape.mu.Lock()
	if bid > 0 {
		tape.quote.Bid = bid
	}
	if ask > 0 {
		tape.quote.Ask = ask
	}
	if bidSize >= 0 {
		tape.quote.BidSize = bidSize
	}
	if askSize >= 0 {
		tape.quote.AskSize = askSize
	}
	tape.mu.Unlock()
}

func (s *Store) AddTrade(symbol string, exchangeTime time.Time, received time.Time, price, size float64) Trade {
	tape := s.getOrCreate(symbol)
	if tape == nil || price <= 0 || size < 0 {
		return Trade{}
	}
	return tape.add(exchangeTime, received, price, size)
}

func (s *Store) Snapshot(symbol string, limit int) Snapshot {
	s.mu.RLock()
	if symbol == "" {
		symbol = s.active
	}
	tape := s.tapes[symbol]
	history := append([]string(nil), s.history...)
	status := s.status
	s.mu.RUnlock()
	if tape == nil {
		return Snapshot{Symbol: symbol, History: history, Status: status}
	}
	trades, quote := tape.snapshot(limit)
	return Snapshot{Symbol: symbol, Quote: quote, Trades: trades, History: history, Status: status}
}

func (s *Store) Since(symbol string, seq uint64, limit int) (trades []Trade, quote Quote, dropped uint64, more bool) {
	s.mu.RLock()
	tape := s.tapes[symbol]
	s.mu.RUnlock()
	if tape == nil {
		return nil, Quote{}, 0, false
	}
	return tape.since(seq, limit)
}

func (s *Store) getOrCreate(symbol string) *symbolTape {
	symbol = NormalizeSymbol(symbol)
	if symbol == "" {
		return nil
	}
	s.mu.RLock()
	tape := s.tapes[symbol]
	s.mu.RUnlock()
	if tape != nil {
		return tape
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if tape = s.tapes[symbol]; tape == nil {
		tape = newSymbolTape(symbol, s.ringSize)
		s.tapes[symbol] = tape
	}
	return tape
}

func newSymbolTape(symbol string, size int) *symbolTape {
	return &symbolTape{symbol: symbol, items: make([]Trade, size), nextSeq: 1}
}

func (t *symbolTape) add(exchangeTime, received time.Time, price, size float64) Trade {
	t.mu.Lock()
	defer t.mu.Unlock()
	class := classify(price, t.quote.Bid, t.quote.Ask)
	side := direction(class, price, t.lastPrice, t.lastSide)
	trade := Trade{
		Seq: t.nextSeq, ExchangeTimeMS: exchangeTime.UnixMilli(), ReceivedUS: received.UnixMicro(),
		Price: price, Size: size, Class: class, Side: side, Bid: t.quote.Bid, Ask: t.quote.Ask,
	}
	t.nextSeq++
	if t.count < len(t.items) {
		idx := (t.start + t.count) % len(t.items)
		t.items[idx] = trade
		t.count++
	} else {
		t.items[t.start] = trade
		t.start = (t.start + 1) % len(t.items)
	}
	t.lastPrice = price
	if side != 0 {
		t.lastSide = side
	}
	return trade
}

func (t *symbolTape) snapshot(limit int) ([]Trade, Quote) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if limit <= 0 || limit > t.count {
		limit = t.count
	}
	result := make([]Trade, limit)
	first := t.count - limit
	for i := range result {
		result[i] = t.items[(t.start+first+i)%len(t.items)]
	}
	return result, t.quote
}

func (t *symbolTape) since(seq uint64, limit int) ([]Trade, Quote, uint64, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.count == 0 || limit <= 0 {
		return nil, t.quote, 0, false
	}
	oldest := t.items[t.start].Seq
	wanted := seq + 1
	var dropped uint64
	if wanted < oldest {
		dropped = oldest - wanted
		wanted = oldest
	}
	newest := t.nextSeq - 1
	if wanted > newest {
		return nil, t.quote, dropped, false
	}
	available := int(newest - wanted + 1)
	count := available
	if count > limit {
		count = limit
	}
	result := make([]Trade, count)
	offset := int(wanted - oldest)
	for i := range result {
		result[i] = t.items[(t.start+offset+i)%len(t.items)]
	}
	return result, t.quote, dropped, available > count
}

func classify(price, bid, ask float64) Classification {
	if bid <= 0 || ask <= 0 {
		return Between
	}
	epsilon := math.Max(math.Abs(price), 1) * 1e-9
	if price < bid-epsilon {
		return BelowBid
	}
	if math.Abs(price-bid) <= epsilon {
		return AtBid
	}
	if price > ask+epsilon {
		return AboveAsk
	}
	if math.Abs(price-ask) <= epsilon {
		return AtAsk
	}
	return Between
}

func direction(class Classification, price, lastPrice float64, lastSide int8) int8 {
	switch class {
	case BelowBid, AtBid:
		return -1
	case AtAsk, AboveAsk:
		return 1
	}
	if lastPrice > 0 {
		if price > lastPrice {
			return 1
		}
		if price < lastPrice {
			return -1
		}
	}
	return lastSide
}
