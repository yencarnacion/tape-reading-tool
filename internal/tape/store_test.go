package tape

import (
	"testing"
	"time"
)

func TestTradeClassificationAndDirection(t *testing.T) {
	store := NewStore("AAPL", 100, 4)
	store.UpdateQuote("AAPL", 100, 101, 500, 600)
	store.UpdatePreviousClose("AAPL", 99.5)
	now := time.Unix(1_700_000_000, 0)
	prices := []float64{99, 100, 100.5, 101, 102}
	wantClasses := []Classification{BelowBid, AtBid, Between, AtAsk, AboveAsk}
	wantSides := []int8{-1, -1, 1, 1, 1}
	for i, price := range prices {
		trade := store.AddTrade("AAPL", now.Add(time.Duration(i)*time.Second), now, price, 100)
		if trade.Class != wantClasses[i] {
			t.Errorf("price %.2f class = %q, want %q", price, trade.Class, wantClasses[i])
		}
		if trade.Side != wantSides[i] {
			t.Errorf("price %.2f side = %d, want %d", price, trade.Side, wantSides[i])
		}
	}

	snapshot := store.Snapshot("AAPL", 10)
	if snapshot.Quote.Bid != 100 || snapshot.Quote.Ask != 101 || snapshot.Quote.PreviousClose != 99.5 {
		t.Fatalf("quote = %+v", snapshot.Quote)
	}
	if len(snapshot.Trades) != len(prices) {
		t.Fatalf("got %d trades, want %d", len(snapshot.Trades), len(prices))
	}
}

func TestTradeKeepsMicrosecondReceiptTimeSeparateFromExchangeTime(t *testing.T) {
	store := NewStore("AAPL", 100, 4)
	exchangeTime := time.Unix(1_700_000_000, 0)
	received := time.Unix(1_700_000_001, 987_654_000)
	trade := store.AddTrade("AAPL", exchangeTime, received, 100, 25)

	if trade.ExchangeTimeMS != exchangeTime.UnixMilli() {
		t.Fatalf("exchange time = %d, want %d", trade.ExchangeTimeMS, exchangeTime.UnixMilli())
	}
	if trade.ReceivedUS != received.UnixMicro() {
		t.Fatalf("receipt time = %d, want %d", trade.ReceivedUS, received.UnixMicro())
	}
	if trade.ReceivedUS%1000 != 654 {
		t.Fatalf("receipt time lost sub-millisecond precision: %d", trade.ReceivedUS)
	}
}

func TestBetweenTradesUseTickRule(t *testing.T) {
	store := NewStore("AAPL", 100, 4)
	now := time.Unix(1_700_000_000, 0)
	first := store.AddTrade("AAPL", now, now, 10, 1)
	up := store.AddTrade("AAPL", now, now, 10.01, 1)
	repeat := store.AddTrade("AAPL", now, now, 10.01, 1)
	down := store.AddTrade("AAPL", now, now, 10, 1)
	if first.Side != 0 || up.Side != 1 || repeat.Side != 1 || down.Side != -1 {
		t.Fatalf("unexpected sides: %d %d %d %d", first.Side, up.Side, repeat.Side, down.Side)
	}
}

func TestRingSinceReportsOverrun(t *testing.T) {
	store := NewStore("AAPL", 3, 4)
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < 5; i++ {
		store.AddTrade("AAPL", now, now, 10+float64(i), 1)
	}
	trades, _, dropped, more := store.Since("AAPL", 0, 10)
	if dropped != 2 {
		t.Fatalf("dropped = %d, want 2", dropped)
	}
	if more {
		t.Fatal("unexpected more flag")
	}
	if len(trades) != 3 || trades[0].Seq != 3 || trades[2].Seq != 5 {
		t.Fatalf("unexpected retained trades: %+v", trades)
	}

	first, _, dropped, more := store.Since("AAPL", 2, 2)
	if dropped != 0 || !more || len(first) != 2 || first[0].Seq != 3 || first[1].Seq != 4 {
		t.Fatalf("unexpected limited batch: trades=%+v dropped=%d more=%v", first, dropped, more)
	}
}

func TestActivateMaintainsMRUHistory(t *testing.T) {
	store := NewStore("AAPL", 100, 3)
	for _, symbol := range []string{"MSFT", "NVDA", "AAPL", "TSLA"} {
		if !store.Activate(symbol) {
			t.Fatalf("Activate(%q) failed", symbol)
		}
	}
	want := []string{"TSLA", "AAPL", "NVDA"}
	got := store.Symbols()
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("history = %v, want %v", got, want)
		}
	}
	if store.Activate("bad symbol") {
		t.Fatal("invalid symbol was accepted")
	}
}

func TestClearPreservesSequenceAndAdvancesGeneration(t *testing.T) {
	store := NewStore("AAPL", 100, 4)
	now := time.Now()
	first := store.AddTrade("AAPL", now, now, 100, 10)
	generation := store.Generation("AAPL")
	store.Clear("AAPL")
	second := store.AddTrade("AAPL", now, now, 101, 20)
	if second.Seq <= first.Seq {
		t.Fatalf("sequence was reused: first=%d second=%d", first.Seq, second.Seq)
	}
	if store.Generation("AAPL") != generation+1 {
		t.Fatalf("generation = %d, want %d", store.Generation("AAPL"), generation+1)
	}
	if snapshot := store.Snapshot("AAPL", 10); len(snapshot.Trades) != 1 || snapshot.Trades[0].Price != 101 {
		t.Fatalf("snapshot after clear = %+v", snapshot.Trades)
	}
}
