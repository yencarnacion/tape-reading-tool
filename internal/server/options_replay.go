package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// Prepared options files are immutable data during playback. The only network
// component is the explicit preparation script, which talks to a local gateway. Replay
// never calls a current option snapshot, even when its historical file is absent.
type optionsArchive struct {
	SchemaVersion int            `json:"schemaVersion"`
	Symbol        string         `json:"symbol"`
	Date          string         `json:"date"`
	StartMS       int64          `json:"startMS"`
	EndMS         int64          `json:"endMS"`
	Method        string         `json:"method"`
	Samples       []optionsReply `json:"samples"`
	modified      time.Time
	size          int64
}

var archiveSymbol = regexp.MustCompile(`^[A-Z0-9][A-Z0-9._-]{0,31}$`)

func (s *optionsService) replayAt(seed optionsReply, clock time.Time, afterMS int64) optionsReply {
	seed.Replay, seed.Estimated, seed.Status = true, true, "replay-unavailable"
	seed.Source = "Historical options quotes"
	if !archiveSymbol.MatchString(seed.Symbol) {
		return seed
	}
	loc, _ := time.LoadLocation("America/New_York")
	date := clock.In(loc).Format("2006-01-02")
	key := seed.Symbol + "-" + date
	path := filepath.Join(s.archiveDir, key+".json")
	s.archiveMu.Lock()
	defer s.archiveMu.Unlock()
	info, err := os.Stat(path)
	if err != nil {
		return seed
	}
	if info.Size() > 32<<20 || !info.Mode().IsRegular() {
		seed.Status = "invalid-data"
		return seed
	}
	a := s.archives[key]
	if a == nil || a.modified != info.ModTime() || a.size != info.Size() {
		body, err := os.ReadFile(path)
		if err != nil {
			return seed
		}
		a = &optionsArchive{}
		if json.Unmarshal(body, a) != nil || !validOptionsArchive(a, seed.Symbol, date) {
			seed.Status = "invalid-data"
			return seed
		}
		a.modified, a.size = info.ModTime(), info.Size()
		if s.archives == nil || len(s.archives) >= 4 {
			s.archives = make(map[string]*optionsArchive)
		}
		s.archives[key] = a
	}
	stamp := clock.UnixMilli()
	if stamp < a.StartMS || stamp > a.EndMS {
		seed.Status = "replay-outside-range"
		return seed
	}
	end := sort.Search(len(a.Samples), func(i int) bool { return a.Samples[i].AsOfMS > stamp })
	if end == 0 {
		return seed
	}
	latest := a.Samples[end-1]
	seed.Status, seed.AsOfMS, seed.Spot, seed.Contracts = latest.Status, latest.AsOfMS, latest.Spot, latest.Contracts
	seed.Quality = latest.Quality
	seed.Method = a.Method
	start := sort.Search(end, func(i int) bool { return a.Samples[i].AsOfMS > afterMS })
	// Never let a client-provided cursor select future samples. A reset/seek
	// sends zero and rebuilds the same historical IV/peak/baseline deterministically.
	seed.Samples = append([]optionsReply(nil), a.Samples[start:end]...)
	for i := range seed.Samples {
		seed.Samples[i].Source = seed.Source
	}
	return seed
}

func validOptionsArchive(a *optionsArchive, symbol, date string) bool {
	if a.SchemaVersion != 1 || a.Symbol != symbol || a.Date != date || a.StartMS <= 0 || a.EndMS < a.StartMS || a.EndMS-a.StartMS > 23400000 || len(a.Samples) == 0 || len(a.Samples) > 4681 {
		return false
	}
	previous := int64(0)
	for _, sample := range a.Samples {
		if sample.SchemaVersion != 1 || sample.Symbol != symbol || !sample.Estimated || sample.AsOfMS <= previous || sample.AsOfMS < a.StartMS || sample.AsOfMS > a.EndMS || len(sample.Contracts) > 8 || len(sample.Samples) != 0 {
			return false
		}
		for _, c := range sample.Contracts {
			if c.Timeframe != "HISTORICAL" || c.QuoteMS <= 0 || c.QuoteMS > sample.AsOfMS {
				return false
			}
		}
		previous = sample.AsOfMS
	}
	return true
}
