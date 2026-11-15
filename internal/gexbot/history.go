package gexbot

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type historyJob struct {
	done   bool
	retry  time.Time
	status string
}

// PrepareHistory downloads and imports one day's provider archives using the
// same bounded, credential-separated path as replay. Existing archives are kept.
// This is an explicit CLI operation; it does not depend on live polling being on.
func (s *Service) PrepareHistory(ctx context.Context, symbol, date string) error {
	if !SymbolPattern.MatchString(symbol) {
		return errors.New("invalid symbol")
	}
	if _, err := time.Parse("2006-01-02", date); err != nil {
		return errors.New("invalid date; use YYYY-MM-DD")
	}
	if s.Key == "" {
		return errors.New("GEXBOT_API_KEY required in environment or .env")
	}
	dir := s.Dir
	if s.HistoryDir != "" {
		dir = s.HistoryDir
	}
	var failures []error
	for _, kind := range Kinds {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		if err := s.downloadHistory(ctx, filepath.Join(dir, "history"), symbol, date, kind); err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", kind, err))
		}
	}
	return errors.Join(failures...)
}

// Replay reads observations as of its clock. If a previous session was never
// captured locally, asynchronously fetch that DATE'S history, never a live chain.
// Offline exports call At directly and do not use this convenience path.
func (s *Service) Replay(symbol string, at int64) View {
	v := s.At(symbol, at)
	if !SymbolPattern.MatchString(symbol) || !s.Enabled || s.Key == "" || !RTH(at) || Date(at) >= Date(s.now().UnixMilli()) {
		return v
	}
	date := Date(at)
	missing := []string{}
	for _, kind := range Kinds {
		rows, _ := s.load(symbol, kind, at)
		if completeAt(rows, kind, at) {
			continue
		}
		if len(rows) > 0 && rows[len(rows)-1].Origin == "provider-history" {
			continue
		}
		if s.hasImportedArchive(symbol, kind, date) {
			continue
		}
		// Existing provider history may start later than the requested clock.
		// Its existence is sufficient; asking for it again cannot create data.
		dir := s.Dir
		if s.HistoryDir != "" {
			dir = s.HistoryDir
		}
		if _, err := os.Stat(filepath.Join(dir, "history", date, symbol, kind+".jsonl")); err == nil {
			continue
		}
		missing = append(missing, kind)
	}
	if len(missing) == 0 {
		return v
	}
	key := date + "/" + symbol
	s.mu.Lock()
	if s.history == nil {
		s.history = map[string]*historyJob{}
		s.historySlots = make(chan struct{}, 2)
	}
	j := s.history[key]
	if j == nil || j.done && s.now().After(j.retry) {
		j = &historyJob{status: "preparing-history"}
		s.history[key] = j
		go s.prepareHistory(key, symbol, date, missing, j)
	}
	if v.Status != "ready" {
		v.Status = j.status
	}
	v.HistoryStatus = j.status
	s.mu.Unlock()
	return v
}

func (s *Service) prepareHistory(key, symbol, date string, kinds []string, j *historyJob) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	status := "history-unavailable"
	select {
	case s.historySlots <- struct{}{}:
		defer func() { <-s.historySlots }()
	case <-ctx.Done():
		s.finishHistory(key, j, status)
		return
	}
	dir := s.Dir
	if s.HistoryDir != "" {
		dir = s.HistoryDir
	}
	dir = filepath.Join(dir, "history")
	for _, kind := range kinds {
		if err := s.downloadHistory(ctx, dir, symbol, date, kind); err != nil {
			status = "history-unavailable"
			continue
		}
	}
	s.finishHistory(key, j, status)
}
func (s *Service) finishHistory(key string, j *historyJob, status string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j.done = true
	j.status = status
	j.retry = s.now().Add(30 * time.Minute)
	// Keep completed failures bounded across many historical sessions.
	if len(s.history) > 32 {
		for k, v := range s.history {
			if k != key && v.done {
				delete(s.history, k)
				if len(s.history) <= 32 {
					break
				}
			}
		}
	}
}
func safeBlob(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "https" && u.User == nil && (u.Port() == "" || u.Port() == "443") && strings.HasSuffix(strings.ToLower(u.Hostname()), ".blob.core.windows.net")
}
func (s *Service) downloadHistory(ctx context.Context, dir, symbol, date, kind string) error {
	path := filepath.Join(dir, date, symbol, kind+".jsonl")
	if _, e := os.Stat(path); e == nil {
		return nil
	}
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	lock, e := os.OpenFile(path+".lock", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(e) {
		// Each preparation has a three-minute deadline. Recover a lock left by a
		// crashed process without interrupting a current download in the other app.
		if info, err := os.Stat(path + ".lock"); err == nil && time.Since(info.ModTime()) > 4*time.Minute {
			if os.Remove(path+".lock") == nil {
				lock, e = os.OpenFile(path+".lock", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			}
		}
	}
	if e != nil {
		return errors.New("history is being prepared")
	}
	lock.Close()
	defer os.Remove(path + ".lock")
	packageName := "state"
	if kind == "orderflow" {
		packageName = "orderflow"
	}
	req, e := http.NewRequestWithContext(ctx, "GET", s.Base+"/hist/"+symbol+"/"+packageName+"/"+kind+"/"+date+"?noredirect", nil)
	if e != nil {
		return errors.New("history request unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+s.Key)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "yamir-gexbot-history/1.0")
	res, e := s.Client.Do(req)
	if e != nil {
		return errors.New("history request unavailable")
	}
	var link struct {
		URL string `json:"url"`
	}
	e = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&link)
	res.Body.Close()
	if res.StatusCode != 200 || e != nil || !safeBlob(link.URL) {
		return errors.New("history not available")
	}
	// Signed Azure download gets a fresh request with NO bearer authorization.
	req, e = http.NewRequestWithContext(ctx, "GET", link.URL, nil)
	if e != nil {
		return errors.New("history download unavailable")
	}
	req.Header.Set("Accept-Encoding", "identity")
	client := *s.Client
	client.Timeout = 120 * time.Second
	res, e = client.Do(req)
	if e != nil {
		return errors.New("history download unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return errors.New("history download unavailable")
	}
	gz, e := gzip.NewReader(io.LimitReader(res.Body, 128<<20))
	if e != nil {
		return errors.New("invalid history archive")
	}
	defer gz.Close()
	_, e = Import(io.LimitReader(gz, 768<<20), dir, symbol, kind, date)
	return e
}
