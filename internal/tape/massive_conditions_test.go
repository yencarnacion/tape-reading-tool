package tape

import "testing"

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
	if got := MassiveTradeFlags("0,14,41"); got != RulesPresent|PriceOpenClose|PriceHighLow|TradeVolume {
		t.Fatalf("regular sale excluded: %d", got)
	}
	if got := MassiveTradeFlags("0,37"); got != RulesPresent|TradeVolume {
		t.Fatalf("regular marker overrode odd-lot restriction: %d", got)
	}
}
