package feed

import (
	"encoding/json"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/marketgateway"
	"tape-reading-tool/internal/tape"
	"testing"
	"time"
)

func TestGatewayTradeConditionsReachTape(t *testing.T) {
	store := tape.NewStore("PCVX", 100, 1)
	f := NewGateway(config.MassiveConfig{}, store, nil)
	now := time.Now().UnixMilli()
	for _, test := range []struct {
		raw   string
		flags uint8
	}{{`{"p":75,"s":100}`, 31}, {`{"p":5,"s":1,"c":[37]}`, 28}, {`{"p":99,"s":200,"c":[10,2,41]}`, 12}, {`{"p":74,"s":100,"c":[32]}`, 14}, {`{"p":1,"s":100,"c":[999]}`, 8}} {
		f.event("PCVX", marketgateway.Event{Symbol: "PCVX", Channel: "T", EventMS: now, Data: json.RawMessage(test.raw)})
		tr := store.Snapshot("PCVX", 1).Trades[0]
		if tr.Flags != test.flags {
			t.Fatalf("%s: %+v", test.raw, tr)
		}
	}
}
