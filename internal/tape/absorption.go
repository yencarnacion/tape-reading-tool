package tape

// Absorption is an inference from eligible executions at a fresh NBBO. It is
// deliberately not an iceberg/order-identity detector. All clocks below are
// receipt clocks, so recordings reproduce what was knowable in live trading.
import (
	"math"
	"sort"
)

const absorptionWindowUS int64 = 5e6
const AbsorptionLookbackUS int64 = 20*60e6 + absorptionWindowUS
const absorptionLifetimeUS int64 = 15 * 60e6

type AbsorptionZone struct {
	ID               int64   `json:"id"`
	Side             string  `json:"side"` // passive side: buy absorbs aggressive sales
	Low              float64 `json:"low"`
	High             float64 `json:"high"`
	DetectedUS       int64   `json:"detected_us"`
	HeldUS           int64   `json:"held_us,omitempty"`
	BrokenUS         int64   `json:"broken_us,omitempty"`
	ExpiresUS        int64   `json:"expires_us"`
	Volume           float64 `json:"volume"`
	RelativeVolume   float64 `json:"relative_volume"`
	ExpectedRange    float64 `json:"expected_range"`
	ResponseDistance float64 `json:"response_distance"`
	Prints           int     `json:"prints"`
	pressureSince    int64
	holdSince        int64
}

type AbsorptionSnapshot struct {
	Revision      int64            `json:"revision"`
	Version       int              `json:"version"`
	AsOfUS        int64            `json:"as_of_us"`
	Ready         bool             `json:"ready"`
	WarmupSeconds int              `json:"warmup_seconds"`
	Zones         []AbsorptionZone `json:"zones"`
}

type absorptionSample struct{ buy, sell, low, high, spread float64 }
type absorptionCluster struct {
	low, high, volume, opposite float64
	firstUS, lastUS             int64
	prints                      int
}
type AbsorptionDetector struct {
	revision                                                             int64
	asOfUS, startUS, bucketUS, lastCheckUS                               int64
	window                                                               absorptionSample
	samples                                                              []absorptionSample
	zones                                                                []AbsorptionZone
	clusters                                                             [2]map[int64]*absorptionCluster
	width, expectedRange, buyBase, sellBase, buyThreshold, sellThreshold float64
	valid                                                                int
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sort.Float64s(values)
	n := len(values)
	if n%2 == 0 {
		return (values[n/2-1] + values[n/2]) / 2
	}
	return values[n/2]
}
func absorptionThreshold(values []float64) (float64, float64) {
	base := median(append([]float64(nil), values...))
	deviations := make([]float64, len(values))
	for i, v := range values {
		deviations[i] = math.Abs(v - base)
	}
	// A minimum floor keeps quiet/empty windows from turning tiny prints into
	// infinite ratios. Both sides have independent, robust recent baselines.
	base = math.Max(25, base)
	return base, math.Max(100, math.Max(3*base, base+3*1.4826*median(deviations)))
}
func (d *AbsorptionDetector) resetWindow(at int64) {
	d.bucketUS = at / absorptionWindowUS * absorptionWindowUS
	d.window = absorptionSample{}
	d.clusters = [2]map[int64]*absorptionCluster{make(map[int64]*absorptionCluster), make(map[int64]*absorptionCluster)}
	ranges, spreads := []float64{}, []float64{}
	for _, s := range d.samples {
		if s.high > 0 {
			ranges = append(ranges, s.high-s.low)
			spreads = append(spreads, s.spread)
		}
	}
	d.expectedRange = math.Max(.01, median(ranges))
	d.width = math.Max(.01, math.Max(d.expectedRange*.20, median(spreads)))
	buy, sell := []float64{}, []float64{}
	for _, s := range d.samples {
		// Compare concentration at a price with usual volume per similarly sized
		// price band, not the day's total volume or the company's market cap.
		bands := math.Max(1, (s.high-s.low)/(2*d.width))
		buy = append(buy, s.buy/bands)
		sell = append(sell, s.sell/bands)
	}
	d.buyBase, d.buyThreshold = absorptionThreshold(buy)
	d.sellBase, d.sellThreshold = absorptionThreshold(sell)
}
func (d *AbsorptionDetector) Add(t Trade, quoteUS int64) {
	// Fully excluded reports are absent from replay's published tape too.
	if t.Flags == RulesPresent || t.Size <= 0 {
		return
	}
	at := t.ReceivedUS
	if at <= 0 || at < d.asOfUS {
		return
	}
	if d.asOfUS > 0 && at-d.asOfUS > 30e6 {
		*d = AbsorptionDetector{}
	}
	if d.startUS == 0 {
		d.startUS = at
		d.resetWindow(at)
		d.revision = at
	}
	d.asOfUS = at
	// Expired zones are retained for a further three minutes for Live Rewind.
	kept := d.zones[:0]
	for _, z := range d.zones {
		if at <= z.ExpiresUS+3*60e6 {
			kept = append(kept, z)
		}
	}
	if len(kept) != len(d.zones) {
		d.revision = at
	}
	d.zones = kept
	if at >= d.bucketUS+absorptionWindowUS {
		d.samples = append(d.samples, d.window)
		if len(d.samples) > 60 {
			d.samples = d.samples[len(d.samples)-60:]
		}
		d.resetWindow(at)
		d.revision = at
	}
	// Reject volume-only, late, off-quote, crossed/locked and stale observations.
	// A midpoint tick-test classification is never treated as a known aggressor.
	if !UpdatesOpenClose(t.Flags) || !UpdatesVolume(t.Flags) || t.Size <= 0 ||
		t.Price <= 0 || math.IsNaN(t.Price) || math.IsInf(t.Price, 0) ||
		math.IsNaN(t.Size) || math.IsInf(t.Size, 0) ||
		t.Bid <= 0 || t.Ask <= t.Bid || math.IsNaN(t.Bid) || math.IsNaN(t.Ask) || math.IsInf(t.Bid, 0) || math.IsInf(t.Ask, 0) || t.Price < t.Bid-1e-7 || t.Price > t.Ask+1e-7 || quoteUS <= 0 || at < quoteUS || at-quoteUS > 2e6 ||
		(t.ExchangeTimeMS > 0 && (at/1000-t.ExchangeTimeMS > 2000 || t.ExchangeTimeMS-at/1000 > 1000)) {
		return
	}
	if d.window.high == 0 {
		d.window.low = t.Price
		d.window.high = t.Price
		d.window.spread = t.Ask - t.Bid
	}
	d.window.low = math.Min(d.window.low, t.Price)
	d.window.high = math.Max(d.window.high, t.Price)
	d.updateZones(t)
	side := -1
	if math.Abs(t.Price-t.Ask) < 1e-7 {
		side = 0
		d.window.buy += t.Size
	}
	if math.Abs(t.Price-t.Bid) < 1e-7 {
		side = 1
		d.window.sell += t.Size
	}
	if side < 0 {
		return
	}
	d.valid++
	// Overlapping bands avoid losing a cluster at an arbitrary bucket boundary.
	key := int64(math.Floor(t.Price / d.width))
	for _, k := range []int64{key, key - 1} {
		c := d.clusters[side][k]
		if c == nil {
			c = &absorptionCluster{low: t.Price, high: t.Price, firstUS: at}
			d.clusters[side][k] = c
		}
		c.low = math.Min(c.low, t.Price)
		c.high = math.Max(c.high, t.Price)
		c.volume += t.Size
		c.lastUS = at
		c.prints++
		if other := d.clusters[1-side][k]; other != nil {
			other.opposite += t.Size
		}
		// Include earlier opposing prints too when this side first visits the band.
		if c.prints == 1 {
			if other := d.clusters[1-side][k]; other != nil {
				c.opposite = other.volume
			}
		}
	}
	if !d.ready() || at-d.lastCheckUS < 100000 {
		return
	}
	d.lastCheckUS = at
	for _, k := range []int64{key, key - 1} {
		c := d.clusters[side][k]
		base, threshold := d.buyBase, d.buyThreshold
		passive := "sell"
		if side == 1 {
			base, threshold = d.sellBase, d.sellThreshold
			passive = "buy"
		}
		if c.volume < threshold || c.prints < 8 || c.lastUS-c.firstUS < 1e6 || c.volume/(c.volume+c.opposite) < .70 {
			continue
		}
		// High volume sweeping rapidly through prices is not absorption. The
		// complete observed window must also show limited movement for this stock.
		if d.window.high-d.window.low > math.Max(2*d.width, .75*d.expectedRange) {
			continue
		}
		duplicate := false
		for _, z := range d.zones {
			if z.Side == passive && z.DetectedUS/60e6 == at/60e6 && c.low <= z.High+d.width && c.high >= z.Low-d.width {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		distance := math.Max(.02, math.Max(2*(t.Ask-t.Bid), .5*d.expectedRange))
		d.revision = at
		d.zones = append(d.zones, AbsorptionZone{ID: at, Side: passive, Low: c.low, High: c.high, DetectedUS: at,
			ExpiresUS: at + absorptionLifetimeUS, Volume: c.volume, RelativeVolume: c.volume / base,
			ExpectedRange: d.expectedRange, ResponseDistance: distance, Prints: c.prints})
		if len(d.zones) > 96 {
			d.zones = d.zones[len(d.zones)-96:]
		}
		break
	}
}
func (d *AbsorptionDetector) ready() bool {
	return len(d.samples) >= 12 && d.valid >= 100 && d.asOfUS-d.startUS >= 60e6
}
func (d *AbsorptionDetector) updateZones(t Trade) {
	for i := range d.zones {
		z := &d.zones[i]
		at := t.ReceivedUS
		if at > z.ExpiresUS || z.BrokenUS > 0 {
			continue
		}
		// Use the quote midpoint for response; alternating bid/ask prints alone
		// must not turn a narrow spread into a breakout or a rejection.
		mid := (t.Bid + t.Ask) / 2
		broken, held := mid < z.Low-z.ResponseDistance, mid > z.High+z.ResponseDistance
		if z.Side == "sell" {
			broken, held = mid > z.High+z.ResponseDistance, mid < z.Low-z.ResponseDistance
		}
		if broken {
			if z.pressureSince == 0 {
				z.pressureSince = at
			}
			if at-z.pressureSince >= 1e6 {
				z.BrokenUS = at
				d.revision = at
			}
		} else {
			z.pressureSince = 0
		}
		if held {
			if z.holdSince == 0 {
				z.holdSince = at
			}
			if at-z.holdSince >= 1e6 && z.HeldUS == 0 {
				z.HeldUS = at
				d.revision = at
			}
		} else {
			z.holdSince = 0
		}
	}
}
func (d *AbsorptionDetector) Snapshot() AbsorptionSnapshot {
	warmup := int((d.asOfUS - d.startUS) / 1e6)
	if warmup > 60 {
		warmup = 60
	}
	return AbsorptionSnapshot{Revision: d.revision, Version: 1, AsOfUS: d.asOfUS, Ready: d.ready(), WarmupSeconds: warmup, Zones: append([]AbsorptionZone{}, d.zones...)}
}

// Absorption is copied under the tape lock; callers cannot mutate detector state.
func (s *Store) Absorption(symbol string) AbsorptionSnapshot {
	t := s.getOrCreate(symbol)
	if t == nil {
		return AbsorptionSnapshot{Version: 1}
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.absorption.Snapshot()
}

// SeedAbsorption copies a reconstructed detector and the preceding quote, but
// deliberately leaves the display ring empty (warmup is not fresh tape/audio).
func (s *Store) SeedAbsorption(symbol string, stage *RebuildStage) {
	t := s.getOrCreate(symbol)
	if t == nil || stage == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.absorption = stage.tape.absorption
	t.quote = stage.tape.quote
	t.quoteUS = stage.tape.quoteUS
}
func (s *Store) UpdateQuoteAt(symbol string, bid, ask, bs, as float64, at int64) Quote {
	t := s.getOrCreate(symbol)
	if t == nil {
		return Quote{}
	}
	return t.updateQuoteAt(bid, ask, bs, as, at)
}
func (t *symbolTape) updateQuoteAt(bid, ask, bs, as float64, at int64) Quote {
	t.mu.Lock()
	defer t.mu.Unlock()
	if at < t.quoteUS {
		return t.quote
	}
	// Invalid/one-sided quotes invalidate inference rather than retaining a stale side.
	t.quote.Bid = bid
	t.quote.Ask = ask
	t.quote.BidSize = bs
	t.quote.AskSize = as
	t.quoteUS = at
	return t.quote
}
func (w storeSink) UpdateQuoteAt(bid, ask, bs, as float64, at int64) {
	w.store.UpdateQuoteAt(w.symbol, bid, ask, bs, as, at)
}
func (r *RebuildStage) UpdateQuoteAt(bid, ask, bs, as float64, at int64) {
	r.tape.updateQuoteAt(bid, ask, bs, as, at)
}

func (r *RebuildStage) SeedAbsorption(prior *RebuildStage) {
	if prior != nil {
		r.tape.absorption = prior.tape.absorption
		r.tape.quote = prior.tape.quote
		r.tape.quoteUS = prior.tape.quoteUS
	}
}
