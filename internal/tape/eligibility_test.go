package tape

import (
	"math"
	"testing"
)

func TestChartEligibility(t *testing.T) {
	tests := []struct {
		name   string
		in     TradeEligibilityInput
		want   bool
		reason string
	}{
		{"normal Last", TradeEligibilityInput{FeedType: FeedLast, Price: 100, Size: 10}, true, ""},
		{"unreported", TradeEligibilityInput{FeedType: FeedLast, Price: 100, Size: 10, Unreported: true}, false, ExcludeUnreported},
		{"nan", TradeEligibilityInput{Price: math.NaN(), Size: 1}, false, ExcludeInvalid},
		{"halt", TradeEligibilityInput{Price: 0, Size: 0}, false, ExcludeHalt},
		{"large legitimate move", TradeEligibilityInput{FeedType: FeedLast, Price: 95, Size: 10}, true, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, reason := ChartEligibility(tt.in)
			if got != tt.want || reason != tt.reason {
				t.Fatalf("got (%v,%q), want (%v,%q)", got, reason, tt.want, tt.reason)
			}
		})
	}
}
