package server

import (
	"bufio"
	"encoding/json"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

var gexStockSymbol = regexp.MustCompile(`^[A-Z][A-Z0-9._-]{0,31}$`)

type gexArchiveEntry struct {
	size     int64
	modified time.Time
	items    []gexReply
}
type gexArchiveStore struct {
	dir   string
	mu    sync.Mutex
	day   string
	last  map[string]int64
	cache map[string]gexArchiveEntry
}

func newGEXArchiveStore() *gexArchiveStore {
	dir := os.Getenv("TAPE_GEX_REPLAY_DIR")
	if dir == "" {
		dir = "data/options-gex"
	}
	return &gexArchiveStore{dir: dir, last: map[string]int64{}, cache: map[string]gexArchiveEntry{}}
}

func validGEXRecord(reply gexReply) bool {
	if reply.SchemaVersion != 1 || reply.Model != gexModel || !gexStockSymbol.MatchString(reply.Symbol) ||
		!validGEXDTE(reply.MaxDTE) || !reply.Complete || !finiteGEX(reply.Spot) || reply.Spot <= 0 ||
		reply.AsOfMS <= 0 || reply.Net == nil || reply.Gross == nil || reply.Call == nil || reply.Put == nil ||
		reply.Coverage.Seen < 1 || reply.Coverage.Included < 1 || reply.Coverage.Included > reply.Coverage.Seen {
		return false
	}
	for _, value := range []float64{*reply.Net, *reply.Gross, *reply.Call, *reply.Put, reply.Coverage.KnownOI, reply.Coverage.IncludedOI, reply.Coverage.OIFraction} {
		if !finiteGEX(value) {
			return false
		}
	}
	if *reply.Gross < 0 || *reply.Call < 0 || *reply.Put > 0 || reply.Coverage.OIFraction < 0 || reply.Coverage.OIFraction > 1 ||
		reply.Coverage.IncludedOI < 0 || reply.Coverage.IncludedOI > reply.Coverage.KnownOI {
		return false
	}
	close := func(a, b float64) bool { return math.Abs(a-b) <= math.Max(.0001, math.Abs(b)*1e-9) }
	for _, count := range []int{reply.Coverage.MissingGamma, reply.Coverage.MissingOI, reply.Coverage.Nonstandard, reply.Coverage.Invalid} {
		if count < 0 || count > reply.Coverage.Seen {
			return false
		}
	}
	if reply.Coverage.KnownOI > 0 && !close(reply.Coverage.OIFraction, reply.Coverage.IncludedOI/reply.Coverage.KnownOI) {
		return false
	}
	if !close(*reply.Net, *reply.Call+*reply.Put) || !close(*reply.Gross, *reply.Call-*reply.Put) {
		return false
	}
	date := time.UnixMilli(reply.AsOfMS).In(gexLocation()).Format("2006-01-02")
	through := time.UnixMilli(reply.AsOfMS).In(gexLocation()).AddDate(0, 0, reply.MaxDTE).Format("2006-01-02")
	if reply.ThroughExpiry != through {
		return false
	}
	for index, group := range [][]gexBucket{reply.Strikes, reply.Expiries} {
		if len(group) == 0 {
			return false
		}
		sumCall, sumPut := 0.0, 0.0
		strikes, expiries := map[float64]bool{}, map[string]bool{}
		for _, bucket := range group {
			if index == 0 {
				if !finiteGEX(bucket.Strike) || bucket.Strike <= 0 || strikes[bucket.Strike] {
					return false
				}
				strikes[bucket.Strike] = true
			} else {
				parsed, err := time.Parse("2006-01-02", bucket.Expiry)
				if err != nil || parsed.Format("2006-01-02") != bucket.Expiry || bucket.Expiry < date || bucket.Expiry > through || expiries[bucket.Expiry] {
					return false
				}
				expiries[bucket.Expiry] = true
			}
			if !finiteGEX(bucket.Call) || !finiteGEX(bucket.Put) || !finiteGEX(bucket.Net) || bucket.Call < 0 || bucket.Put > 0 || !close(bucket.Net, bucket.Call+bucket.Put) {
				return false
			}
			sumCall += bucket.Call
			sumPut += bucket.Put
		}
		if !close(sumCall, *reply.Call) || !close(sumPut, *reply.Put) {
			return false
		}
	}
	return true
}

func (a *gexArchiveStore) record(reply gexReply) string {
	if !validGEXRecord(reply) || !gexRTH(time.UnixMilli(reply.AsOfMS)) {
		return "not-recorded"
	}
	date := time.UnixMilli(reply.AsOfMS).In(gexLocation()).Format("2006-01-02")
	path := filepath.Join(a.dir, date, reply.Symbol+".jsonl")
	key := path + "/" + strconv.Itoa(reply.MaxDTE)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.day != date {
		a.last = map[string]int64{}
		a.day = date
	}
	if a.last[key] == reply.AsOfMS {
		return "recorded"
	}
	reply.Recording = "recorded"
	body, err := json.Marshal(reply)
	if err != nil || len(body) > 8<<20 {
		return "failed"
	}
	if os.MkdirAll(filepath.Dir(path), 0700) != nil {
		return "failed"
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return "failed"
	}
	_, writeErr := file.Write(append(body, '\n'))
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		return "failed"
	}
	a.last[key] = reply.AsOfMS
	delete(a.cache, path)
	return "recorded"
}

func (a *gexArchiveStore) replayAt(seed gexReply, clock time.Time) gexReply {
	seed.Replay = true
	seed.Source = "Recorded GEX snapshot"
	seed.Status = "replay-unavailable"
	if !gexStockSymbol.MatchString(seed.Symbol) {
		return seed
	}
	date := clock.In(gexLocation()).Format("2006-01-02")
	path := filepath.Join(a.dir, date, seed.Symbol+".jsonl")
	a.mu.Lock()
	defer a.mu.Unlock()
	info, err := os.Stat(path)
	if err != nil {
		return seed
	}
	if info.Size() > 128<<20 {
		seed.Status = "archive-too-large"
		return seed
	}
	entry, ok := a.cache[path]
	if !ok || entry.size != info.Size() || !entry.modified.Equal(info.ModTime()) {
		file, err := os.Open(path)
		if err != nil {
			return seed
		}
		scanner := bufio.NewScanner(io.NewSectionReader(file, 0, info.Size()))
		scanner.Buffer(make([]byte, 64<<10), 8<<20)
		entry = gexArchiveEntry{size: info.Size(), modified: info.ModTime()}
		for scanner.Scan() {
			var reply gexReply
			if json.Unmarshal(scanner.Bytes(), &reply) != nil {
				continue
			} // torn final line is recoverable
			if !validGEXRecord(reply) || reply.Symbol != seed.Symbol || time.UnixMilli(reply.AsOfMS).In(gexLocation()).Format("2006-01-02") != date {
				continue
			}
			entry.items = append(entry.items, reply)
		}
		file.Close()
		if scanner.Err() != nil {
			seed.Status = "archive-invalid"
			return seed
		}
		if len(a.cache) >= 2 {
			a.cache = map[string]gexArchiveEntry{}
		}
		a.cache[path] = entry
	}
	var selected *gexReply
	for i := range entry.items {
		item := &entry.items[i]
		if item.MaxDTE == seed.MaxDTE && item.AsOfMS <= clock.UnixMilli() && (selected == nil || item.AsOfMS > selected.AsOfMS) {
			selected = item
		}
	}
	if selected == nil {
		return seed
	}
	reply := *selected
	reply.Generation = seed.Generation
	reply.Replay = true
	reply.Source = seed.Source
	if clock.UnixMilli()-reply.AsOfMS > gexMaxAgeMS {
		reply.Status = "replay-gap"
	}
	return reply
}
