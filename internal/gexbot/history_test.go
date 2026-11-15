package gexbot

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestReplayPreparesOnlyDatedHistoryAndNeverForwardsKey(t *testing.T) {
	s := New()
	s.Dir = t.TempDir()
	s.HistoryDir = ""
	s.Enabled = true
	s.Key = "test-key"
	s.clock = func() time.Time { return time.UnixMilli(testTime()).Add(48 * time.Hour) }
	// Partial live recording begins a minute AFTER the requested replay clock.
	// It must not block backfill, and the historical import must not replace it.
	for _, kind := range Kinds {
		r := profile(testTime()+60000, kind)
		if kind == "orderflow" {
			r = flow(testTime()+60000, 20)
		}
		r.Origin = "recorded-live"
		if err := s.Record(r); err != nil {
			t.Fatal(err)
		}
	}
	originalPath := filepath.Join(s.Dir, "2026-11-13", "SNDK", "gex_zero.jsonl")
	original, _ := os.ReadFile(originalPath)
	var api, blob atomic.Int32
	s.Client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		body := ""
		if r.URL.Host == "api.gex.bot" {
			api.Add(1)
			if !strings.HasPrefix(r.URL.Path, "/v2/hist/SNDK/") || !strings.HasSuffix(r.URL.Path, "/2026-11-13") || !r.URL.Query().Has("noredirect") || r.Header.Get("Authorization") != "Bearer test-key" {
				t.Errorf("invalid history request %s", r.URL.Path)
			}
			parts := strings.Split(r.URL.Path, "/")
			kind := parts[len(parts)-2]
			body = fmt.Sprintf(`{"url":"https://test.blob.core.windows.net/%s?signature=secret"}`, kind)
		} else {
			blob.Add(1)
			if r.Header.Get("Authorization") != "" {
				t.Error("key leaked to storage")
			}
			data := `[{"timestamp":1794582900,"ticker":"SNDK","spot":860,"min_dte":0,"sec_min_dte":7,"sum_gex_vol":4,"strikes":[[855,-3],[865,6]]}]`
			if r.URL.Path == "/orderflow" {
				data = `[{"timestamp":1794582900,"ticker":"SNDK","spot":860,"agg_dex":2,"one_agg_dex":1}]`
			}
			var b bytes.Buffer
			z := gzip.NewWriter(&b)
			z.Write([]byte(data))
			z.Close()
			body = b.String()
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	v := s.Replay("SNDK", testTime())
	if v.Status != "preparing-history" {
		t.Fatal(v.Status)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		done := s.history["2026-11-13/SNDK"].done
		s.mu.Unlock()
		if done {
			break
		}
		time.Sleep(time.Millisecond)
	}
	v = s.Replay("SNDK", testTime())
	if v.Status != "ready" || api.Load() != 4 || blob.Load() != 4 {
		t.Fatal(v.Status, api.Load(), blob.Load())
	}
	if v.Profiles[0].Origin != "provider-history" || v.Profiles[1].Expiry != "2026-11-20" {
		t.Fatal("history mislabeled")
	}
	if got, _ := os.ReadFile(originalPath); !bytes.Equal(got, original) {
		t.Fatal("historical import replaced live recording")
	}
	if s.At("SNDK", testTime()+60000).Profiles[0].Origin != "recorded-live" {
		t.Fatal("did not prefer the original live observation")
	}
	s.Replay("SNDK", testTime()-1)
	if api.Load() != 4 {
		t.Fatal("retried history before its first snapshot")
	}
	if s.At("SNDK", testTime()-1).Status == "ready" {
		t.Fatal("future historical snapshot leaked")
	}
}
func TestSignedHistoryURLAllowlist(t *testing.T) {
	for _, url := range []string{"http://test.blob.core.windows.net/x", "https://test.blob.core.windows.net.evil.example/x", "https://user:pass@test.blob.core.windows.net/x", "https://test.blob.core.windows.net:444/x", "http://127.0.0.1/x"} {
		if safeBlob(url) {
			t.Fatal("unsafe blob URL accepted", url)
		}
	}
	if !safeBlob("https://test.blob.core.windows.net/container/file?sig=ok") {
		t.Fatal("valid blob rejected")
	}
}

func TestManualHistoryPreparationRetriesOnlyMissingCategories(t *testing.T) {
	s := New()
	s.Dir = t.TempDir()
	s.HistoryDir = t.TempDir()
	s.Enabled = false // Explicit preparation is independent of live polling.
	s.Key = "private-test-key"
	var paths []string
	denyNext := true
	s.Client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		status, body := 200, ""
		if r.URL.Host == "api.gex.bot" {
			paths = append(paths, r.URL.Path)
			if r.Header.Get("Authorization") != "Bearer private-test-key" || !strings.HasSuffix(r.URL.Path, "/2026-11-13") {
				t.Fatal("wrong date or missing API authorization")
			}
			parts := strings.Split(r.URL.Path, "/")
			kind := parts[len(parts)-2]
			if denyNext && kind == "gex_one" {
				status, body = 403, `{"detail":"private-test-key must not enter logs"}`
			} else {
				body = fmt.Sprintf(`{"url":"https://test.blob.core.windows.net/%s?sig=private-signature"}`, kind)
			}
		} else {
			if r.Header.Get("Authorization") != "" {
				t.Fatal("API key forwarded to storage")
			}
			data := `[{"timestamp":1794582900,"ticker":"SNDK","spot":860,"min_dte":0,"sec_min_dte":7,"sum_gex_vol":3,"strikes":[[855,-3],[865,6]]}]`
			if r.URL.Path == "/orderflow" {
				data = `[{"timestamp":1794582900,"ticker":"SNDK","spot":860,"agg_dex":2,"one_agg_dex":1}]`
			}
			var b bytes.Buffer
			z := gzip.NewWriter(&b)
			z.Write([]byte(data))
			z.Close()
			body = b.String()
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	err := s.PrepareHistory(context.Background(), "SNDK", "2026-11-13")
	if err == nil || !strings.Contains(err.Error(), "gex_one") || strings.Contains(err.Error(), "private-") {
		t.Fatalf("expected a sanitized partial failure: %v", err)
	}
	if len(paths) != 4 {
		t.Fatal("did not try all four history categories", paths)
	}
	path := filepath.Join(s.HistoryDir, "history", "2026-11-13", "SNDK", "gex_zero.jsonl")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	denyNext = false
	paths = nil
	if err := s.PrepareHistory(context.Background(), "SNDK", "2026-11-13"); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || !strings.Contains(paths[0], "/gex_one/") {
		t.Fatal("retried completed archives", paths)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("replaced an existing archive")
	}
	paths = nil
	for _, input := range [][2]string{{"../SNDK", "2026-11-13"}, {"SNDK", "2026-02-30"}} {
		if s.PrepareHistory(context.Background(), input[0], input[1]) == nil {
			t.Fatal("accepted invalid input", input)
		}
	}
	if len(paths) != 0 {
		t.Fatal("invalid input made network requests")
	}
}
