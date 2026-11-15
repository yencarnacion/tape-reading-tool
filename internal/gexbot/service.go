package gexbot

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var SymbolPattern = regexp.MustCompile(`^[A-Z][A-Z0-9._-]{0,15}$`)

type pending struct {
	done  chan struct{}
	view  View
	until time.Time
}
type Service struct {
	Key, Dir, Base, HistoryDir string
	Enabled                    bool
	Client                     *http.Client
	clock                      func() time.Time // injectable receipt clock for live/replay parity tests
	mu                         sync.Mutex
	requests                   map[string]*pending
	archiveMu                  sync.Mutex
	archives                   map[string]archive
	last                       map[string]int64
	history                    map[string]*historyJob
	historySlots               chan struct{}
}

func (s *Service) now() time.Time {
	if s.clock != nil {
		return s.clock()
	}
	return time.Now()
}

func New() *Service {
	dir := os.Getenv("GEXBOT_ARCHIVE_DIR")
	if dir == "" {
		dir = "data/gexbot"
	}
	return &Service{Key: os.Getenv("GEXBOT_API_KEY"), HistoryDir: os.Getenv("GEXBOT_HISTORY_DIR"), Enabled: strings.EqualFold(os.Getenv("GEXBOT_ENABLED"), "true"), Dir: dir, Base: "https://api.gex.bot/v2", Client: &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, requests: map[string]*pending{}, archives: map[string]archive{}, last: map[string]int64{}}
}
func pendingOpen(p *pending) bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (s *Service) At(symbol string, at int64) View {
	if !SymbolPattern.MatchString(symbol) {
		return View{Status: "invalid-symbol"}
	}
	records := map[string][]Record{}
	for _, k := range Kinds {
		rows, err := s.load(symbol, k, at)
		if err == nil {
			records[k] = rows
		}
	}
	return Build(symbol, at, true, records)
}
func (s *Service) Live(ctx context.Context, symbol string, now time.Time) View {
	seed := View{Version: 1, Symbol: symbol, ClockMS: now.UnixMilli(), Profiles: []Profile{}, Flows: []Flow{}}
	if !SymbolPattern.MatchString(symbol) {
		seed.Status = "invalid-symbol"
		return seed
	}
	if !s.Enabled || s.Key == "" {
		seed.Status = "off"
		return seed
	}
	if !RTH(now.UnixMilli()) {
		seed.Status = "market-closed"
		return seed
	}
	s.mu.Lock()
	if p := s.requests[symbol]; p != nil && (now.Before(p.until) || pendingOpen(p)) {
		s.mu.Unlock()
		select {
		case <-p.done:
			return p.view
		case <-ctx.Done():
			seed.Status = "cancelled"
			return seed
		}
	}
	// The visible app polls at 2 s. One coherent bundle is cached per symbol,
	// independent of the number of browser consumers. No background all-stock scan.
	p := &pending{done: make(chan struct{}), until: now.Add(2 * time.Second)}
	s.requests[symbol] = p
	for key, old := range s.requests {
		if key != symbol && now.Sub(old.until) > time.Minute {
			delete(s.requests, key)
		}
	}
	s.mu.Unlock()
	records := map[string][]Record{}
	var recordsMu sync.Mutex
	var wg sync.WaitGroup
	failures := []string{}
	recording := "recorded"
	for _, kind := range Kinds {
		wg.Add(1)
		go func(k string) {
			defer wg.Done()
			packageName := "state"
			if k == "orderflow" {
				packageName = "orderflow"
			}
			request, err := http.NewRequestWithContext(ctx, "GET", s.Base+"/"+symbol+"/"+packageName+"/"+k, nil)
			if err != nil {
				return
			}
			request.Header.Set("Authorization", "Bearer "+s.Key)
			request.Header.Set("User-Agent", "yamir-gexbot-context/1.0")
			request.Header.Set("Accept", "application/json")
			status := "unavailable"
			var record Record
			res, err := s.Client.Do(request)
			if err == nil {
				body, e := io.ReadAll(io.LimitReader(res.Body, 4<<20))
				res.Body.Close()
				if res.StatusCode == 200 && e == nil {
					record, err = Normalize(body, symbol, k, s.now().UnixMilli(), "recorded-live")
					if err == nil {
						status = "ready"
					}
				}
				if res.StatusCode == 401 || res.StatusCode == 403 {
					status = "access-denied"
				}
				if res.StatusCode == 429 {
					status = "rate-limited"
				}
			}
			recordsMu.Lock()
			defer recordsMu.Unlock()
			if status != "ready" {
				failures = append(failures, status)
				return
			}
			// Never put a previous session's closing snapshot into today's archive.
			if Date(record.TimeMS) != Date(now.UnixMilli()) || now.UnixMilli()-record.TimeMS > MaxAgeMS {
				failures = append(failures, "stale")
				return
			}
			if err := s.Record(record); err != nil {
				recording = "failed"
			}
			if k == "orderflow" {
				rows, _ := s.load(symbol, k, s.now().UnixMilli())
				records[k] = rows
				if len(rows) == 0 || rows[len(rows)-1].TimeMS != record.TimeMS {
					records[k] = append(rows, record)
				}
			} else {
				records[k] = []Record{record}
			}
		}(kind)
	}
	wg.Wait()
	clock := s.now().UnixMilli()
	v := Build(symbol, clock, false, records)
	v.Recording = recording
	if len(failures) == 4 {
		v.Status = failures[0]
	}
	s.mu.Lock()
	p.view = v
	if len(failures) > 0 {
		p.until = s.now().Add(15 * time.Second)
	}
	close(p.done)
	s.mu.Unlock()
	return v
}
func (s *Service) Record(r Record) error {
	if !validRecord(r) {
		return errors.New("invalid archive record")
	}
	s.archiveMu.Lock()
	defer s.archiveMu.Unlock()
	path := filepath.Join(s.Dir, Date(r.AvailableMS), r.Symbol, r.Kind+".jsonl")
	if r.TimeMS <= s.last[path] {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	body, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	before, statErr := f.Stat()
	_, err = f.Write(append(body, '\n'))
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	s.last[path] = r.TimeMS
	if a, ok := s.archives[path]; ok && statErr == nil && a.size == before.Size() {
		if after, e := os.Stat(path); e == nil {
			a.points = append(a.points, point{r.AvailableMS, before.Size(), len(body)})
			a.size = after.Size()
			a.modified = after.ModTime()
			a.used = time.Now()
			s.archives[path] = a
		} else {
			delete(s.archives, path)
		}
	} else {
		delete(s.archives, path)
	}
	return nil
}
func validRecord(r Record) bool {
	if r.Version != 1 || !SymbolPattern.MatchString(r.Symbol) || !ValidKind(r.Kind) || r.TimeMS <= 0 || r.AvailableMS < r.TimeMS-2000 || Date(r.AvailableMS) != Date(r.TimeMS) || !finite(r.Spot) || r.Spot <= 0 {
		return false
	}
	if r.Kind == "orderflow" {
		return r.Cumulative[0] != nil && r.Cumulative[1] != nil && finite(*r.Cumulative[0]) && finite(*r.Cumulative[1])
	}
	if len(r.Strikes) == 0 || r.Net == nil || !finite(*r.Net) || r.DTE == nil || r.NextDTE == nil || *r.DTE < 0 || *r.DTE > 366 || *r.NextDTE < 0 || *r.NextDTE > 366 {
		return false
	}
	previous := 0.0
	for _, x := range r.Strikes {
		if !finite(x[0]) || !finite(x[1]) || x[0] <= previous {
			return false
		}
		previous = x[0]
	}
	return true
}

// Import consumes the provider's JSON array one row at a time. It atomically
// installs an archive and never overwrites actual locally recorded observations.
func Import(reader io.Reader, dir, symbol, kind, date string) (int, error) {
	_, dateErr := time.Parse("2006-01-02", date)
	if !SymbolPattern.MatchString(symbol) || !ValidKind(kind) || dateErr != nil {
		return 0, errors.New("invalid import")
	}
	path := filepath.Join(dir, date, symbol, kind+".jsonl")
	if _, err := os.Stat(path); err == nil {
		return 0, fmt.Errorf("archive already exists: %s", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return 0, err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "import-*.tmp")
	if err != nil {
		return 0, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	writer := bufio.NewWriter(f)
	decoder := json.NewDecoder(reader)
	tok, err := decoder.Token()
	if err != nil || tok != json.Delim('[') {
		return 0, errors.New("expected history array")
	}
	count := 0
	var previous int64
	for decoder.More() {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return 0, err
		}
		r, err := Normalize(raw, symbol, kind, 0, "provider-history")
		if err != nil {
			return 0, err
		}
		if Date(r.TimeMS) != date {
			return 0, errors.New("wrong historical session")
		}
		if r.TimeMS <= previous {
			continue
		}
		previous = r.TimeMS
		body, _ := json.Marshal(r)
		if _, err = writer.Write(append(body, '\n')); err != nil {
			return 0, err
		}
		count++
	}
	if _, err := decoder.Token(); err != nil {
		return 0, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return 0, errors.New("trailing history data")
	}
	if count == 0 {
		return 0, errors.New("empty history")
	}
	if err := writer.Flush(); err != nil {
		return 0, err
	}
	if err := f.Close(); err != nil {
		return 0, err
	}
	// Link installs the complete file atomically and fails if another importer or
	// live recorder created the destination after our initial existence check.
	return count, os.Link(f.Name(), path)
}
