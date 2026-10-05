package feed

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
)

// Massive retains integer s/size for compatibility. ds/decimal_size is the
// authoritative quantity, including fractions; absent decimal fields use the
// legacy quantity. The store and SQLite already retain float64 share sizes.
func massiveShareSize(whole float64, decimal *string) (float64, error) {
	size := whole
	if decimal != nil {
		var err error
		size, err = strconv.ParseFloat(*decimal, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid decimal trade size")
		}
	}
	if math.IsNaN(size) || math.IsInf(size, 0) || size < 0 {
		return 0, fmt.Errorf("invalid trade size")
	}
	return size, nil
}

type massiveStreamTrade struct {
	Symbol     string  `json:"sym"`
	Price      float64 `json:"p"`
	Size       float64 `json:"s"`
	Exchange   int32   `json:"x"`
	Conditions []int32 `json:"c"`
	Timestamp  int64   `json:"t"`
}

func (t *massiveStreamTrade) UnmarshalJSON(data []byte) error {
	type wireTrade massiveStreamTrade
	var wire struct {
		wireTrade
		DecimalSize *string `json:"ds"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	size, err := massiveShareSize(wire.Size, wire.DecimalSize)
	if err != nil {
		return err
	}
	*t = massiveStreamTrade(wire.wireTrade)
	t.Size = size
	return nil
}

func (t *massiveTrade) UnmarshalJSON(data []byte) error {
	type wireTrade massiveTrade
	var wire struct {
		wireTrade
		DecimalSize *string `json:"decimal_size"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	size, err := massiveShareSize(wire.Size, wire.DecimalSize)
	if err != nil {
		return err
	}
	*t = massiveTrade(wire.wireTrade)
	t.Size = size
	return nil
}
