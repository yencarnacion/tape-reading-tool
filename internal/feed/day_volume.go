package feed

import (
	"encoding/json"
	"tape-reading-tool/internal/tape"
)

// The decimal daily counter includes fractional shares. An absent counter must
// not be confused with an explicit zero or reconstructed from candle volumes.
type massiveDayAggregate struct {
	Symbol        string   `json:"sym"`
	End           int64    `json:"e"`
	Volume        *float64 `json:"av"`
	DecimalVolume *string  `json:"dav"`
}

func (a massiveDayAggregate) volume() (float64, bool) {
	if a.Volume == nil && a.DecimalVolume == nil {
		return 0, false
	}
	whole := 0.0
	if a.Volume != nil {
		whole = *a.Volume
	}
	value, err := massiveShareSize(whole, a.DecimalVolume)
	return value, err == nil
}
func applyMassiveDayAggregate(store *tape.Store, symbol string, raw json.RawMessage, fallbackMS int64) {
	var a massiveDayAggregate
	if json.Unmarshal(raw, &a) != nil || (a.Symbol != "" && a.Symbol != symbol) {
		return
	}
	if volume, ok := a.volume(); ok {
		stamp := a.End
		if stamp <= 0 {
			stamp = fallbackMS
		}
		store.UpdateDayVolume(symbol, volume, stamp)
	}
}
