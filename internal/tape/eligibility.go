package tape

import "math"

const (
	FeedLast          = "Last"
	ExcludeUnreported = "unreported"
	ExcludeInvalid    = "invalid_price_or_size"
	ExcludeHalt       = "halt_or_status"
)

type TradeEligibilityInput struct {
	FeedType   string
	Price      float64
	Size       float64
	Unreported bool
}

// ChartEligibility is the single policy used before trades enter any chart,
// indicator, volume, delta, VWAP, or last-price calculation.
func ChartEligibility(in TradeEligibilityInput) (bool, string) {
	if in.Unreported {
		return false, ExcludeUnreported
	}
	if in.Price == 0 && in.Size == 0 {
		return false, ExcludeHalt
	}
	if math.IsNaN(in.Price) || math.IsInf(in.Price, 0) || in.Price <= 0 ||
		math.IsNaN(in.Size) || math.IsInf(in.Size, 0) || in.Size <= 0 {
		return false, ExcludeInvalid
	}
	return true, ""
}
