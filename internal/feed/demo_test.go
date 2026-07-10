package feed

import (
	"context"
	"testing"
	"time"

	"tape-reading-tool/internal/tape"
)

func TestDemoProducesTrades(t *testing.T) {
	store := tape.NewStore("AAPL", 1000, 4)
	demo := NewDemo(store)
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() {
		demo.Run(ctx)
		close(done)
	}()
	<-done

	snapshot := store.Snapshot("AAPL", 1000)
	if len(snapshot.Trades) == 0 {
		t.Fatal("demo produced no trades")
	}
	if snapshot.Quote.Bid <= 0 || snapshot.Quote.Ask <= snapshot.Quote.Bid {
		t.Fatalf("invalid demo quote: %+v", snapshot.Quote)
	}
}
