package gexbot

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type point struct {
	At     int64
	Offset int64
	Size   int
}
type archive struct {
	size     int64
	modified time.Time
	points   []point
	used     time.Time
	origin   string
}

// loadFile indexes origin even when the replay clock precedes the first row.
func (s *Service) hasImportedArchive(symbol, kind, date string) bool {
	s.archiveMu.Lock()
	defer s.archiveMu.Unlock()
	for _, root := range []string{s.Dir, s.HistoryDir, filepath.Join(s.Dir, "history"), filepath.Join(s.HistoryDir, "history")} {
		if root != "" && s.archives[filepath.Join(root, date, symbol, kind+".jsonl")].origin == "provider-history" {
			return true
		}
	}
	return false
}

// Index offsets, not every strike of every second. Two full sessions can exceed
// 400 MB on disk; a replay request needs one profile and ten minutes of flow.
func (s *Service) load(symbol, kind string, at int64) ([]Record, error) {
	date := Date(at)
	roots := []string{s.Dir}
	if s.HistoryDir != "" {
		roots = append(roots, s.HistoryDir)
	}
	roots = append(roots, filepath.Join(s.Dir, "history"))
	if s.HistoryDir != "" {
		roots = append(roots, filepath.Join(s.HistoryDir, "history"))
	}
	var first []Record
	var firstErr error
	for _, root := range roots {
		rows, err := s.loadFile(symbol, kind, at, filepath.Join(root, date, symbol, kind+".jsonl"))
		if first == nil && len(rows) > 0 {
			first = rows
		}
		if firstErr == nil {
			firstErr = err
		}
		if completeAt(rows, kind, at) {
			return rows, nil
		}
		// A provider reconstruction with gaps cannot be repaired by re-downloading
		// the same archive. Keep the gap explicit.
		if len(rows) > 0 && rows[len(rows)-1].Origin == "provider-history" {
			return rows, nil
		}
	}
	if len(first) > 0 {
		return first, nil
	}
	return nil, firstErr
}

func completeAt(rows []Record, kind string, at int64) bool {
	if len(rows) == 0 || stale(rows[len(rows)-1], at) {
		return false
	}
	if kind != "orderflow" {
		return true
	}
	t := time.UnixMilli(at).In(NY)
	open := time.Date(t.Year(), t.Month(), t.Day(), 9, 30, 0, 0, NY).UnixMilli()
	for _, sec := range []int{15, 60, 300} {
		if at-open < int64(sec)*1000 {
			continue
		}
		for side := 0; side < 2; side++ {
			if flowWindow(rows, len(rows)-1, side, sec).Status != "ready" {
				return false
			}
		}
	}
	return true
}

func (s *Service) loadFile(symbol, kind string, at int64, path string) ([]Record, error) {
	s.archiveMu.Lock()
	defer s.archiveMu.Unlock()
	date := Date(at)
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > 768<<20 {
		return nil, errors.New("archive too large")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	a, ok := s.archives[path]
	if !ok || a.size != info.Size() || !a.modified.Equal(info.ModTime()) {
		a = archive{size: info.Size(), modified: info.ModTime()}
		scanner := bufio.NewScanner(io.NewSectionReader(f, 0, info.Size()))
		scanner.Buffer(make([]byte, 64<<10), 4<<20)
		offset := int64(0)
		for scanner.Scan() {
			line := scanner.Bytes()
			var h struct {
				Available int64  `json:"availableMS"`
				Origin    string `json:"origin"`
			}
			if json.Unmarshal(line, &h) == nil && h.Available > 0 && Date(h.Available) == date {
				if a.origin == "" {
					a.origin = h.Origin
				}
				a.points = append(a.points, point{h.Available, offset, len(line)})
			}
			offset += int64(len(line) + 1)
		}
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		sort.SliceStable(a.points, func(i, j int) bool { return a.points[i].At < a.points[j].At })
	}
	a.used = time.Now()
	if len(s.archives) >= 16 {
		oldKey := ""
		var oldest time.Time
		for k, v := range s.archives {
			if k != path && (oldKey == "" || v.used.Before(oldest)) {
				oldKey = k
				oldest = v.used
			}
		}
		delete(s.archives, oldKey)
	}
	s.archives[path] = a
	end := sort.Search(len(a.points), func(i int) bool { return a.points[i].At > at })
	if end == 0 {
		return nil, nil
	}
	start := end - 1
	if kind == "orderflow" {
		start = sort.Search(end, func(i int) bool { return a.points[i].At >= at-620000 })
	}
	rows := []Record{}
	for _, p := range a.points[start:end] {
		body := make([]byte, p.Size)
		if _, err = f.ReadAt(body, p.Offset); err != nil {
			return nil, err
		}
		var r Record
		if json.Unmarshal(body, &r) != nil || !validRecord(r) || r.Symbol != symbol || r.Kind != kind || !eligible(r, at) {
			continue
		}
		if len(rows) > 0 && rows[len(rows)-1].TimeMS == r.TimeMS {
			continue
		}
		rows = append(rows, r)
	}
	return rows, nil
}
