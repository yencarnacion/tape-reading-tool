package tape

import (
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"
	"sync/atomic"
)

// A zero flag byte is the legacy/IBKR policy. Massive always sets RulesPresent.
const (
	PriceOpenClose uint8 = 1 << iota
	PriceHighLow
	TradeVolume
	RulesPresent
)

func UpdatesOpenClose(flags uint8) bool { return flags == 0 || flags&PriceOpenClose != 0 }
func UpdatesHighLow(flags uint8) bool   { return flags == 0 || flags&PriceHighLow != 0 }
func UpdatesVolume(flags uint8) bool    { return flags == 0 || flags&TradeVolume != 0 }

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

func init() {
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
	rules[0] = RulesPresent | PriceOpenClose | PriceHighLow | TradeVolume
	for _, c := range table.Results {
		flags := uint8(RulesPresent)
		if r := c.UpdateRules.Consolidated; r != nil {
			if r.OpenClose {
				flags |= PriceOpenClose
			}
			if r.HighLow {
				flags |= PriceHighLow
			}
			if r.Volume {
				flags |= TradeVolume
			}
		} else {
			flags |= PriceOpenClose | PriceHighLow | TradeVolume
		} // indicators, not sale restrictions
		rules[c.ID] = flags
	}
	// A truncated/reference error must never erase the core exclusion policy.
	if rules[37] != RulesPresent|TradeVolume || rules[2] != RulesPresent|TradeVolume {
		return false
	}
	massiveConditions.Store(rules)
	return true
}
func MassiveTradeFlags(conditions string) uint8 {
	flags := uint8(RulesPresent | PriceOpenClose | PriceHighLow | TradeVolume)
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
		flags &= r
	}
	return flags
}
