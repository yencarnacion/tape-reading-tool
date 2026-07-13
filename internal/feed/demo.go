package feed

import (
	"context"
	"hash/fnv"
	"math"
	"math/rand"
	"sync"
	"time"

	"tape-reading-tool/internal/tape"
)

type Demo struct {
	store  *tape.Store
	mu     sync.Mutex
	symbol string
}

func NewDemo(store *tape.Store) *Demo {
	return &Demo{store: store, symbol: store.Active()}
}

func (d *Demo) SetSymbol(symbol string) {
	symbol = tape.NormalizeSymbol(symbol)
	if symbol == "" {
		return
	}
	d.mu.Lock()
	d.symbol = symbol
	d.mu.Unlock()
}

func (d *Demo) Run(ctx context.Context) {
	rng := rand.New(rand.NewSource(945))
	ticker := time.NewTicker(4 * time.Millisecond)
	defer ticker.Stop()
	d.store.SetStatus(tape.FeedStatus{Mode: "demo", State: "live", Connected: true})

	lastSymbol := ""
	price := 0.0
	direction := 1.0
	started := time.Now()
	for {
		select {
		case <-ctx.Done():
			d.store.SetStatus(tape.FeedStatus{Mode: "demo", State: "stopped"})
			return
		case now := <-ticker.C:
			d.mu.Lock()
			symbol := d.symbol
			d.mu.Unlock()
			if symbol != lastSymbol {
				price = demoBase(symbol)
				d.store.UpdatePreviousClose(symbol, demoPreviousClose(symbol))
				lastSymbol = symbol
			}
			burst := math.Mod(now.Sub(started).Seconds(), 6) < 1.15
			prints := 1
			if burst {
				prints = 3 + rng.Intn(4)
			}
			for i := 0; i < prints; i++ {
				if rng.Float64() < 0.16 {
					direction = -direction
				}
				if rng.Float64() < 0.72 {
					price += direction * 0.01
				}
				price = math.Round(price*100) / 100
				spread := 0.01
				if rng.Float64() < 0.12 {
					spread = 0.02
				}
				bid := price - spread
				ask := price + spread
				d.store.UpdateQuote(symbol, bid, ask, 100+float64(rng.Intn(1500)), 100+float64(rng.Intn(1500)))
				tradePrice := price
				r := rng.Float64()
				switch {
				case r < 0.08:
					tradePrice = bid - 0.01
				case r < 0.43:
					tradePrice = bid
				case r < 0.54:
					tradePrice = price
				case r < 0.92:
					tradePrice = ask
				default:
					tradePrice = ask + 0.01
				}
				size := float64([]int{1, 10, 25, 50, 100, 200, 300, 500}[rng.Intn(8)])
				if rng.Float64() < 0.025 {
					size = float64(1000 + rng.Intn(9001))
				}
				received := time.Now()
				d.store.AddTrade(symbol, received, received, tradePrice, size)
			}
		}
	}
}

func demoBase(symbol string) float64 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(symbol))
	return math.Round((18+float64(h.Sum32()%22000)/100)*100) / 100
}

func demoPreviousClose(symbol string) float64 {
	base := demoBase(symbol)
	h := fnv.New32a()
	_, _ = h.Write([]byte(symbol + "-previous-close"))
	move := (float64(h.Sum32()%401) - 200) / 10000
	return math.Round(base*(1+move)*100) / 100
}
