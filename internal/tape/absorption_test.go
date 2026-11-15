package tape

import (
	"math"
	"reflect"
	"testing"
	"time"
)

const absBase int64 = 1794580200000000

func absPrint(at int64, p, size float64, buy bool, scale float64) Trade {
	b, a := p, p+.01*scale
	class := AtBid
	if buy {
		b = p - .01*scale
		a = p
		class = AtAsk
	}
	return Trade{ReceivedUS: at, ExchangeTimeMS: at / 1000, Price: p, Size: size, Bid: b, Ask: a, Class: class, Flags: RulesPresent | PriceOpenClose | PriceHighLow | TradeVolume}
}
func warmDetector(scale, volume float64) *AbsorptionDetector {
	d := &AbsorptionDetector{}
	for w := 0; w < 12; w++ {
		for i := 0; i < 20; i++ {
			at := absBase + int64(w)*5e6 + int64(i)*230000
			tr := absPrint(at, (100+float64(i%5)*.05)*scale, 50*volume, i%2 == 0, scale)
			d.Add(tr, at)
		}
	}
	return d
}
func addBurst(d *AbsorptionDetector, buy bool, scale, volume float64) {
	for i := 0; i < 18; i++ {
		at := absBase + 60e6 + int64(i)*180000
		d.Add(absPrint(at, 100*scale, 250*volume, buy, scale), at)
	}
}
func TestAbsorptionNormalizationAndPassiveSide(t *testing.T) {
	for _, buy := range []bool{false, true} {
		a, b := warmDetector(1, 1), warmDetector(10, 20)
		addBurst(a, buy, 1, 1)
		addBurst(b, buy, 10, 20)
		if len(a.zones) != 1 || len(b.zones) != 1 {
			t.Fatalf("want one cluster despite overlapping bands: %d %d", len(a.zones), len(b.zones))
		}
		x, y := a.zones[0], b.zones[0]
		want := "buy"
		if buy {
			want = "sell"
		}
		if x.Side != want || math.Abs(x.RelativeVolume-y.RelativeVolume) > 1e-6 {
			t.Fatalf("normalization: %+v %+v", x, y)
		}
		if x.DetectedUS < absBase+61e6 || x.Prints < 8 {
			t.Fatalf("detected before evidence: %+v", x)
		}
		if math.Abs(y.ExpectedRange/x.ExpectedRange-10) > 1e-6 {
			t.Fatal("volatility does not scale")
		}
	}
}
func TestAbsorptionRejectsUnreliableAndSweepingPrints(t *testing.T) {
	for _, kind := range []string{"volume-only", "stale", "locked", "midpoint", "single", "sweep", "late"} {
		d := warmDetector(1, 1)
		for i := 0; i < 18; i++ {
			at := absBase + 60e6 + int64(i)*180000
			q := at
			tr := absPrint(at, 100, 500, false, 1)
			switch kind {
			case "volume-only":
				tr.Flags = RulesPresent | TradeVolume
			case "stale":
				q = at - 3e6
			case "locked":
				tr.Ask = tr.Bid
			case "midpoint":
				tr.Price += .005
			case "single":
				if i > 0 {
					continue
				}
			case "sweep":
				tr = absPrint(at, 100-float64(i)*.1, 500, false, 1)
			case "late":
				tr.ExchangeTimeMS -= 3000
			}
			d.Add(tr, q)
		}
		if len(d.zones) != 0 {
			t.Fatalf("%s created a false zone: %+v", kind, d.zones)
		}
	}
}
func TestAbsorptionHoldBreakAndSnapshotImmutability(t *testing.T) {
	d := warmDetector(1, 1)
	addBurst(d, false, 1, 1)
	before := d.Snapshot()
	if len(before.Zones) != 1 {
		t.Fatal("missing zone")
	}
	for i := 0; i < 10; i++ {
		at := absBase + 65e6 + int64(i)*200000
		d.Add(absPrint(at, 100.5, 10, false, 1), at)
	}
	if d.zones[0].HeldUS == 0 || d.zones[0].BrokenUS != 0 {
		t.Fatal("did not hold")
	}
	for i := 0; i < 10; i++ {
		at := absBase + 68e6 + int64(i)*200000
		d.Add(absPrint(at, 99.5, 10, false, 1), at)
	}
	if d.zones[0].BrokenUS == 0 {
		t.Fatal("did not break")
	}
	if before.Zones[0].HeldUS != 0 || before.Zones[0].BrokenUS != 0 {
		t.Fatal("prior snapshot changed")
	}
	next := d.Snapshot()
	next.Zones[0].Low = 1
	if d.zones[0].Low == 1 {
		t.Fatal("snapshot aliases detector")
	}
	d.Add(absPrint(absBase+100e6, 100, 10, false, 1), absBase+100e6)
	if len(d.zones) != 0 || d.ready() {
		t.Fatal("feed gap did not reset inference")
	}
}
func TestAbsorptionRebuildAndClear(t *testing.T) {
	store := NewStore("TEST", 10, 2)
	stage := store.PrepareRebuild("TEST")
	for w := 0; w < 14; w++ {
		for i := 0; i < 20; i++ {
			at := absBase + int64(w)*5e6 + int64(i)*230000
			tr := absPrint(at, 100+float64(i%5)*.05, 50, i%2 == 0, 1)
			if w >= 12 {
				tr = absPrint(at, 100, 250, false, 1)
			}
			store.UpdateQuoteAt("TEST", tr.Bid, tr.Ask, 100, 100, at)
			stage.UpdateQuoteAt(tr.Bid, tr.Ask, 100, 100, at)
			store.AddTradeWithRules("TEST", time.UnixMilli(tr.ExchangeTimeMS), time.UnixMicro(at), tr.Price, tr.Size, tr.Flags, "")
			stage.AddTradeRules(time.UnixMilli(tr.ExchangeTimeMS), time.UnixMicro(at), tr.Price, tr.Size, "", 0, 0, 0, tr.Flags, "")
		}
	}
	if !reflect.DeepEqual(store.Absorption("TEST"), stage.tape.absorption.Snapshot()) {
		t.Fatal("detached rebuild differs from live")
	}
	store.Clear("TEST")
	if store.Absorption("TEST").Ready || len(store.Absorption("TEST").Zones) > 0 {
		t.Fatal("clear leaked old zones")
	}
}
