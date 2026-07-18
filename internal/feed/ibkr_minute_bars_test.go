package feed

import (
	"testing"
	"time"

	"tape-reading-tool/internal/storage"
)

func TestLatestCompletedBarsExcludesFormingMinute(t *testing.T) {
	end := time.Unix(1_800, 0)
	bars := []storage.MinuteBar{
		{TimeUS: 1_620_000_000, Close: 10, Volume: 100},
		{TimeUS: 1_680_000_000, Close: 11, Volume: 200},
		{TimeUS: 1_740_000_000, Close: 12, Volume: 300},
		{TimeUS: 1_800_000_000, Close: 13, Volume: 400},
	}
	completed := latestCompletedBars(bars, end, 2)
	if len(completed) != 2 || completed[0].TimeUS != 1_680_000_000 || completed[1].TimeUS != 1_740_000_000 {
		t.Fatalf("completed bars = %+v", completed)
	}
}

func TestIBKRBarTimeUS(t *testing.T) {
	got, err := ibkrBarTimeUS("1784295000")
	if err != nil {
		t.Fatal(err)
	}
	if got != 1_784_295_000_000_000 {
		t.Fatalf("time = %d", got)
	}
}
