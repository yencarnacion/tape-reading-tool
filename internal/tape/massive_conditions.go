package tape

import (
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// A zero flag byte is the legacy/IBKR policy. Massive always sets RulesPresent.
const (
	PriceOpenClose uint8 = 1 << iota
	PriceHighLow
	TradeVolume
	RulesPresent
	PriceLast
)

func UpdatesOpenClose(flags uint8) bool { return flags == 0 || flags&PriceOpenClose != 0 }
func UpdatesHighLow(flags uint8) bool   { return flags == 0 || flags&PriceHighLow != 0 }
func UpdatesVolume(flags uint8) bool    { return flags == 0 || flags&TradeVolume != 0 }
func UpdatesLastPrice(flags uint8) bool { return UpdatesOpenClose(flags) || flags&PriceLast != 0 }

type ConditionRule struct {
	ID          int32  `json:"id"`
	Name        string `json:"name"`
	UpdateRules struct {
		Consolidated *struct {
			OpenClose bool `json:"updates_open_close"`
			HighLow   bool `json:"updates_high_low"`
			Volume    bool `json:"updates_volume"`
		} `json:"consolidated"`
	} `json:"update_rules"`
}
type ConditionTable struct {
	Results []ConditionRule `json:"results"`
}

// Official stock trade rules obtained through DaiDai on 2026-10-05. Keeping a
// known baseline makes reconnects independent of reference-data availability.
// https://massive.com/docs/rest/stocks/market-operations/condition-codes
//
//go:embed massive_conditions.json
var defaultConditionJSON []byte
var massiveConditions atomic.Value
var massiveMarketLocation *time.Location

func init() {
	var err error
	massiveMarketLocation, err = time.LoadLocation("America/New_York")
	if err != nil {
		panic(err)
	}
	var v ConditionTable
	if json.Unmarshal(defaultConditionJSON, &v) != nil {
		panic("invalid condition table")
	}
	SetMassiveConditions(v)
}
func SetMassiveConditions(table ConditionTable) bool {
	if len(table.Results) < 30 {
		return false
	}
	rules := make(map[int32]uint8, len(table.Results))
	// The glossary defines 0 as Regular Sale; the reference list omits it.
	// https://massive.com/glossary/trade-conditions
	rules[0] = RulesPresent | PriceOpenClose | PriceHighLow | TradeVolume | PriceLast
	for _, c := range table.Results {
		flags := uint8(RulesPresent)
		if r := c.UpdateRules.Consolidated; r != nil {
			if r.OpenClose {
				flags |= PriceOpenClose | PriceLast
			}
			if r.HighLow {
				flags |= PriceHighLow
			}
			if r.Volume {
				flags |= TradeVolume
			}
		} else {
			flags |= PriceOpenClose | PriceHighLow | TradeVolume | PriceLast
		} // indicators, not sale restrictions
		// Timely extended-hours and odd-lot executions can supply LAST without
		// becoming consolidated candle prices. Other modifiers still restrict it.
		if c.ID == 12 || c.ID == 37 {
			flags |= PriceLast
		}
		rules[c.ID] = flags
	}
	// A truncated/reference error must never erase the core exclusion policy.
	if rules[37]&^PriceLast != RulesPresent|TradeVolume || rules[2] != RulesPresent|TradeVolume {
		return false
	}
	massiveConditions.Store(rules)
	return true
}
func MassiveTradeFlags(conditions string) uint8 {
	return massiveTradeFlags(conditions, false)
}

// MassiveIntradayFlags distinguishes extended-session candles from the
// consolidated regular-session statistics in the reference condition table.
// Timely Form T executions establish intraday OHLC outside RTH; every other
// modifier still restricts the trade (in particular odd lots and late reports).
// Use market time, never receipt time, so delayed delivery and replay agree.
func MassiveIntradayFlags(conditions string, marketTime time.Time) uint8 {
	et := marketTime.In(massiveMarketLocation)
	minute := et.Hour()*60 + et.Minute()
	extended := marketTime.UnixMilli() > 0 && ((minute >= 240 && minute < 570) || (minute >= 960 && minute < 1200))
	return massiveTradeFlags(conditions, extended)
}

func massiveTradeFlags(conditions string, extended bool) uint8 {
	flags := uint8(RulesPresent | PriceOpenClose | PriceHighLow | TradeVolume | PriceLast)
	rules := massiveConditions.Load().(map[int32]uint8)
	for _, raw := range strings.Split(conditions, ",") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		code, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 32)
		r, known := rules[int32(code)]
		if err != nil || !known {
			return RulesPresent
		} // unknown must not create a spike
		if extended && code == 12 {
			r |= PriceOpenClose | PriceHighLow
		}
		flags &= r
	}
	return flags
}
