package tape

import (
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// observeLikeTheWebSocket runs the exact loop the browser stream runs: watch the
// generation, take a snapshot when it changes, and otherwise deliver whatever
// Since reports as incremental prints. Incremental prints are what the audio
// path sounds, so any warmup print that reaches this path is an audible burst.
func observeLikeTheWebSocket(store *Store, symbol string, stop <-chan struct{}, done chan<- int64) {
	var deltas int64
	generation := store.Generation(symbol)
	var seq uint64
	if trades := store.Snapshot(symbol, 0).Trades; len(trades) > 0 {
		seq = trades[len(trades)-1].Seq
	}
	for {
		select {
		case <-stop:
			done <- deltas
			return
		default:
		}
		if current := store.Generation(symbol); current != generation {
			generation = current
			seq = 0
			if trades := store.Snapshot(symbol, 0).Trades; len(trades) > 0 {
				seq = trades[len(trades)-1].Seq
			}
			continue
		}
		trades, _, _, _, current := store.Since(symbol, seq, 4096)
		// The stream applies the same rule: prints from a generation the browser
		// has not snapshotted are never delivered incrementally.
		if current != generation {
			continue
		}
		if len(trades) > 0 {
			seq = trades[len(trades)-1].Seq
			deltas += int64(len(trades))
		}
		runtime.Gosched()
	}
}

// A reconstruction must be invisible until it is finished. If a browser can
// observe the new generation while it is still filling, the remainder of the
// warmup arrives as incremental prints and the audio engine sounds them.
func TestRebuildIsNeverObservedPartially(t *testing.T) {
	store := NewStore("AAPL", 65536, 8)
	at := time.Date(2026, 7, 2, 9, 30, 0, 0, time.UTC)
	store.AddTrade("AAPL", at, at, 100, 10)

	stop := make(chan struct{})
	done := make(chan int64, 1)
	go observeLikeTheWebSocket(store, "AAPL", stop, done)
	// Let the observer settle on the published generation before the rebuild.
	time.Sleep(20 * time.Millisecond)

	const warmupPrints = 40000
	store.Rebuild("AAPL", func(sink Sink) {
		sink.UpdateQuote(99.99, 100.01, 10, 10)
		for i := range warmupPrints {
			moment := at.Add(time.Duration(i) * time.Millisecond)
			sink.AddTrade(moment, moment, 100+float64(i%7)*0.01, 100)
		}
	})
	time.Sleep(20 * time.Millisecond)
	close(stop)

	if deltas := <-done; deltas != 0 {
		t.Fatalf("%d warmup prints were delivered incrementally and would have been sounded", deltas)
	}
	snapshot := store.Snapshot("AAPL", 0)
	if len(snapshot.Trades) != warmupPrints {
		t.Fatalf("the published generation is incomplete: %d of %d", len(snapshot.Trades), warmupPrints)
	}
	if snapshot.Quote.Bid != 99.99 || snapshot.Quote.Ask != 100.01 {
		t.Fatalf("the rebuilt quote was not published: %+v", snapshot.Quote)
	}
}

// A rebuild replaces the symbol wholesale: no print from the previous
// generation may survive, and its sequence numbers may never be reused.
func TestRebuildReplacesContentAndNeverReusesSequences(t *testing.T) {
	store := NewStore("AAPL", 1024, 8)
	at := time.Date(2026, 7, 2, 9, 30, 0, 0, time.UTC)
	for i := range 5 {
		store.AddTrade("AAPL", at, at, 10+float64(i), 100)
	}
	before := store.Snapshot("AAPL", 0)
	beforeGeneration := store.Generation("AAPL")

	store.Rebuild("AAPL", func(sink Sink) {
		for i := range 3 {
			sink.AddTrade(at, at, 500+float64(i), 50)
		}
	})
	after := store.Snapshot("AAPL", 0)
	if len(after.Trades) != 3 {
		t.Fatalf("rebuild left %d trades", len(after.Trades))
	}
	for _, trade := range after.Trades {
		if trade.Price < 400 {
			t.Fatalf("a print from the replaced generation survived: %+v", trade)
		}
	}
	if store.Generation("AAPL") != beforeGeneration+1 {
		t.Fatalf("generation %d did not advance by one from %d", store.Generation("AAPL"), beforeGeneration)
	}
	if after.Trades[0].Seq <= before.Trades[len(before.Trades)-1].Seq {
		t.Fatalf("sequence numbers were reused: %d then %d", before.Trades[len(before.Trades)-1].Seq, after.Trades[0].Seq)
	}
	if store.Active() != "AAPL" {
		t.Fatalf("rebuild must activate the symbol: %s", store.Active())
	}
}

// A rebuild of one symbol must not disturb another; this is what keeps a cue
// from publishing the outgoing symbol's tape under the incoming symbol.
func TestRebuildLeavesOtherSymbolsUntouched(t *testing.T) {
	store := NewStore("AAPL", 1024, 8)
	at := time.Date(2026, 7, 2, 9, 30, 0, 0, time.UTC)
	store.Activate("NVDA")
	store.AddTrade("NVDA", at, at, 500, 100)
	nvdaGeneration := store.Generation("NVDA")

	store.Rebuild("AAPL", func(sink Sink) { sink.AddTrade(at, at, 100, 100) })

	nvda := store.Snapshot("NVDA", 0)
	if len(nvda.Trades) != 1 || nvda.Trades[0].Price != 500 {
		t.Fatalf("NVDA changed: %+v", nvda.Trades)
	}
	if store.Generation("NVDA") != nvdaGeneration {
		t.Fatal("NVDA's generation changed")
	}
	if store.Active() != "AAPL" || store.Symbols()[0] != "AAPL" {
		t.Fatalf("active=%s history=%v", store.Active(), store.Symbols())
	}
}

// The previous close is feed-supplied reference data rather than replayed tape,
// so a reconstruction must carry it across instead of blanking the day map.
func TestRebuildPreservesThePreviousClose(t *testing.T) {
	store := NewStore("AAPL", 1024, 8)
	at := time.Date(2026, 7, 2, 9, 30, 0, 0, time.UTC)
	store.UpdatePreviousClose("AAPL", 123.45)
	store.Rebuild("AAPL", func(sink Sink) { sink.AddTrade(at, at, 100, 100) })
	if close := store.Snapshot("AAPL", 0).Quote.PreviousClose; close != 123.45 {
		t.Fatalf("previous close = %v", close)
	}
}

func TestPreparedRebuildIsRingBoundedAndStaleStageCannotPublish(t *testing.T) {
	store := NewStore("AAPL", 100, 8)
	at := time.Date(2026, 7, 2, 9, 30, 0, 0, time.UTC)
	older := store.PrepareRebuild("AAPL")
	newer := store.PrepareRebuild("AAPL")
	for i := range 10_000 {
		newer.AddTrade(at.Add(time.Duration(i)*time.Microsecond), at, 100+float64(i%5), 1)
	}
	if !newer.Commit() {
		t.Fatal("newer stage did not publish")
	}
	older.AddTrade(at, at, 1, 1)
	if older.Commit() {
		t.Fatal("a stage based on the replaced tape overwrote the newer rebuild")
	}
	snapshot := store.Snapshot("AAPL", 0)
	if len(snapshot.Trades) != 100 {
		t.Fatalf("staged warmup retained %d trades, want ring capacity 100", len(snapshot.Trades))
	}
	if snapshot.Trades[len(snapshot.Trades)-1].Price == 1 {
		t.Fatal("stale stage content was published")
	}
}

func TestSymbolSinkWritesToThePublishedTape(t *testing.T) {
	store := NewStore("AAPL", 1024, 8)
	at := time.Date(2026, 7, 2, 9, 30, 0, 0, time.UTC)
	sink := store.SymbolSink("AAPL")
	sink.UpdateQuote(10, 10.02, 5, 6)
	sink.AddTrade(at, at, 10.02, 100)
	sink.AddRecordedTrade(at, at, 10, 50, AtBid, -1, 10, 10.02)
	snapshot := store.Snapshot("AAPL", 0)
	if len(snapshot.Trades) != 2 || snapshot.Quote.Bid != 10 || snapshot.Quote.AskSize != 6 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if snapshot.Trades[0].Class != AtAsk || snapshot.Trades[1].Class != AtBid {
		t.Fatalf("classification differs from the live path: %+v", snapshot.Trades)
	}
}

// Rebuild must be safe against the concurrent readers the server actually has.
func TestRebuildIsRaceFreeUnderConcurrentReaders(t *testing.T) {
	store := NewStore("AAPL", 4096, 8)
	at := time.Date(2026, 7, 2, 9, 30, 0, 0, time.UTC)
	var stop atomic.Bool
	readers := make(chan struct{}, 4)
	for range 4 {
		go func() {
			for !stop.Load() {
				store.Snapshot("AAPL", 100)
				store.Generation("AAPL")
				store.Since("AAPL", 0, 64)
				store.Quote("AAPL")
			}
			readers <- struct{}{}
		}()
	}
	for round := range 25 {
		store.Rebuild("AAPL", func(sink Sink) {
			for i := range 200 {
				sink.AddTrade(at, at, 100+float64(round)+float64(i)*0.001, 10)
			}
		})
	}
	stop.Store(true)
	for range 4 {
		<-readers
	}
	if trades := store.Snapshot("AAPL", 0).Trades; len(trades) != 200 {
		t.Fatalf("final snapshot = %d trades", len(trades))
	}
}
