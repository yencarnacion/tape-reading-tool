package tape

import (
	"testing"
	"time"
)

func TestMassiveIntradaySessionRules(t *testing.T) {
	for _, date := range []string{"2026-10-08", "2026-01-08"} {
		for _, tt := range []struct {
			clock string
			price bool
		}{
			{"03:59:59", false}, {"04:00:00", true}, {"09:29:59", true},
			{"09:30:00", false}, {"15:59:59", false}, {"16:00:00", true},
			{"19:59:59", true}, {"20:00:00", false},
		} {
			at, err := time.ParseInLocation("2006-01-02 15:04:05", date+" "+tt.clock, massiveMarketLocation)
			if err != nil {
				t.Fatal(err)
			}
			for _, conditions := range []string{"12", "14,12,41", "0,12"} {
				flags := MassiveIntradayFlags(conditions, at.UTC())
				if UpdatesOpenClose(flags) != tt.price || UpdatesHighLow(flags) != tt.price || !UpdatesVolume(flags) {
					t.Errorf("%s conditions=%s flags=%d", at, conditions, flags)
				}
			}
			for _, conditions := range []string{"", "37", "12,37", "2,12", "12,2", "13", "13,12", "7,12,37", "10,12", "32,12", "999,12"} {
				baseline := MassiveTradeFlags(conditions)
				flags := MassiveIntradayFlags(conditions, at)
				// Form T may remove only its own restriction. Another modifier
				// can still prohibit OHLC or allow high/low independently.
				if UpdatesOpenClose(flags) != UpdatesOpenClose(baseline) || UpdatesVolume(flags) != UpdatesVolume(baseline) {
					t.Errorf("%s other modifier overridden: %s flags=%d", at, conditions, flags)
				}
			}
		}
	}
	for _, at := range []time.Time{{}, time.UnixMilli(0)} {
		if UpdatesOpenClose(MassiveIntradayFlags("12", at)) {
			t.Fatal("missing timestamp granted Form T price eligibility")
		}
	}
}

func TestMassiveFieldEligibility(t *testing.T) {
	for _, tt := range []struct {
		c         string
		oc, hl, v bool
	}{{"", true, true, true}, {"14,41", true, true, true}, {"37", false, false, true}, {"10,2,41", false, false, true}, {"32", false, true, true}, {"32,37,41", false, false, true}, {"15", false, false, false}, {"38", true, true, false}, {"999", false, false, false}} {
		f := MassiveTradeFlags(tt.c)
		if UpdatesOpenClose(f) != tt.oc || UpdatesHighLow(f) != tt.hl || UpdatesVolume(f) != tt.v {
			t.Errorf("conditions %q flags=%d", tt.c, f)
		}
	}
	if SetMassiveConditions(ConditionTable{}) {
		t.Fatal("empty reference response replaced known rules")
	}
}

func TestExplicitRegularSaleConditions(t *testing.T) {
	if got := MassiveTradeFlags("0,14,41"); got != RulesPresent|PriceOpenClose|PriceHighLow|TradeVolume|PriceLast {
		t.Fatalf("regular sale excluded: %d", got)
	}
	if got := MassiveTradeFlags("0,37"); got != RulesPresent|TradeVolume|PriceLast {
		t.Fatalf("regular marker overrode odd-lot restriction: %d", got)
	}
}

func TestLastPriceAllowsTimelyPremarketAndOddLots(t *testing.T) {
	for _, conditions := range []string{"", "0,14,41", "12", "12,37", "14,12,37,41", "37"} {
		if !UpdatesLastPrice(MassiveTradeFlags(conditions)) {
			t.Errorf("timely execution did not supply LAST: %s", conditions)
		}
	}
	for _, conditions := range []string{"2", "2,12,37", "13", "13,37", "32,37", "10,12", "15", "999,12"} {
		if UpdatesLastPrice(MassiveTradeFlags(conditions)) {
			t.Errorf("special report supplied LAST: %s", conditions)
		}
	}
	if UpdatesOpenClose(MassiveTradeFlags("12,37")) || UpdatesHighLow(MassiveTradeFlags("12,37")) {
		t.Fatal("display policy changed candle eligibility")
	}
}
