package gexbot

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func num(x float64) *float64 { return &x }
func integer(x int) *int     { return &x }
func testTime() int64 {
	d, _ := time.ParseInLocation("2006-01-02 15:04:05", "2026-11-13 10:15:00", NY)
	return d.UnixMilli()
}
func profile(at int64, k string) Record {
	return Record{Version: 1, Symbol: "SNDK", Kind: k, TimeMS: at, AvailableMS: at, Origin: "provider-history", Spot: 860, DTE: integer(0), NextDTE: integer(7), Net: num(4), Strikes: [][2]float64{{855, -3}, {860, 1}, {865, 6}}}
}
func flow(at int64, value float64) Record {
	return Record{Version: 1, Symbol: "SNDK", Kind: "orderflow", TimeMS: at, AvailableMS: at, Origin: "provider-history", Spot: 860, Cumulative: [2]*float64{num(value), num(value / 2)}}
}
func TestExpiryFlowAndCausality(t *testing.T) {
	at := testTime()
	records := map[string][]Record{}
	for _, k := range Kinds[:3] {
		records[k] = []Record{profile(at, k)}
	}
	for i := 0; i <= 600; i++ {
		records["orderflow"] = append(records["orderflow"], flow(at-600000+int64(i)*1000, float64(i)))
	}
	v := Build("SNDK", at, true, records)
	if v.Profiles[0].Expiry != "2026-11-13" || v.Profiles[1].Expiry != "2026-11-20" {
		t.Fatal("wrong actual expiry", v.Profiles)
	}
	for _, w := range v.Flows[0].Windows {
		if w.Delta == nil || *w.Delta != float64(w.Seconds) || w.Agreement != 1 {
			t.Fatal("incorrect cumulative delta", w)
		}
	}
	records["orderflow"] = append(records["orderflow"], flow(at+1000, -9999))
	records["gex_zero"] = append(records["gex_zero"], profile(at+1000, "gex_zero"))
	earlier := Build("SNDK", at, true, records)
	if *earlier.Flows[0].Windows[1].Delta != 60 || earlier.Profiles[0].TimeMS != at {
		t.Fatal("future leaked")
	}
	delayed := profile(at, "gex_zero")
	delayed.AvailableMS = at + 5000
	records["gex_zero"] = []Record{delayed}
	if Build("SNDK", at, true, records).Profiles[0].Status == "ready" {
		t.Fatal("receipt timeline leaked")
	}
	if Build("SNDK", at+20000, true, records).Profiles[1].Status == "ready" {
		t.Fatal("stale profile survived")
	}
	if Build("SNDK", at-1000, true, records).Profiles[1].Status == "ready" {
		t.Fatal("backward seek retained future profile")
	}
}
func TestFlowGapAndMissingAreNotZero(t *testing.T) {
	at := testTime()
	rows := []Record{}
	for i := 0; i <= 300; i++ {
		if i > 265 && i < 285 {
			continue
		}
		rows = append(rows, flow(at-300000+int64(i)*1000, float64(i)))
	}
	v := Build("SNDK", at, true, map[string][]Record{"orderflow": rows})
	if v.Flows[0].Windows[1].Delta != nil || v.Flows[0].Windows[1].Status != "gap" {
		t.Fatal("gap fabricated flow")
	}
	v = Build("SNDK", at, true, nil)
	if v.Flows[0].Cumulative != nil {
		t.Fatal("missing became zero")
	}
}
func TestNormalizeDoesNotInventMissingInputs(t *testing.T) {
	raw := []byte(`{"timestamp":1794582900,"ticker":"SNDK","spot":860,"agg_dex":0,"one_agg_dex":0}`)
	if _, e := Normalize(raw, "SNDK", "orderflow", 0, "provider-history"); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []string{`{"timestamp":1794582900,"ticker":"SNDK","spot":860,"agg_dex":0}`, `{"timestamp":1794582900,"ticker":"QQQ","spot":860,"agg_dex":0,"one_agg_dex":0}`} {
		if _, e := Normalize([]byte(bad), "SNDK", "orderflow", 0, "provider-history"); e == nil {
			t.Fatal("accepted malformed response")
		}
	}
}
func TestArchiveReceiptClockAndOfflineFallback(t *testing.T) {
	at := testTime()
	s := New()
	s.Dir = t.TempDir()
	r := profile(at, "gex_zero")
	r.AvailableMS += 2000
	if e := s.Record(r); e != nil {
		t.Fatal(e)
	}
	if s.At("SNDK", at).Status == "ready" {
		t.Fatal("lookahead")
	}
	if s.At("SNDK", at+2000).Status != "ready" {
		t.Fatal("missing record")
	}
	fallback := New()
	fallback.Dir = t.TempDir()
	fallback.HistoryDir = s.Dir
	if fallback.At("SNDK", at+2000).Status != "ready" {
		t.Fatal("offline history fallback")
	}
	if _, e := os.Stat(filepath.Join(fallback.Dir, "2026-11-13")); !os.IsNotExist(e) {
		t.Fatal("offline read wrote files")
	}
}
func TestImportAtomicAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	raw := `[{"timestamp":1794582900,"ticker":"SNDK","spot":860,"agg_dex":0,"one_agg_dex":0}]`
	n, e := Import(bytes.NewBufferString(raw), dir, "SNDK", "orderflow", "2026-11-13")
	if e != nil || n != 1 {
		t.Fatal(n, e)
	}
	if _, e = Import(bytes.NewBufferString(raw), dir, "SNDK", "orderflow", "2026-11-13"); e == nil {
		t.Fatal("overwrote recording")
	}
	if _, e = Import(bytes.NewBufferString(raw[:len(raw)-1]), dir, "SNDK", "orderflow", "2026-11-12"); e == nil {
		t.Fatal("accepted damaged history")
	}
}
func TestFridayActualArchives(t *testing.T) {
	dir := os.Getenv("GEXBOT_VALIDATE_ARCHIVE")
	if dir == "" {
		t.Skip("set GEXBOT_VALIDATE_ARCHIVE for licensed Friday integration check")
	}
	s := New()
	s.Dir = dir
	s.Client = nil // any attempt to query live data would fail
	results := map[string]any{}
	for _, symbol := range []string{"SNDK", "QQQ"} {
		for _, delta := range []int64{0, 60000, -60000, 3600000, -120000, 0} {
			at := testTime() + delta
			v := s.At(symbol, at)
			if v.Status != "ready" {
				t.Fatalf("%s %d unavailable", symbol, at)
			}
			for _, p := range v.Profiles {
				if p.Status != "ready" || p.TimeMS > at || p.Expiry == "" && p.Kind != "gex_full" {
					t.Fatalf("bad profile: %+v", p)
				}
			}
			if delta == 0 {
				results[symbol] = v
			}
		}
	}
	if out := os.Getenv("GEXBOT_VALIDATION_OUTPUT"); out != "" {
		body, _ := json.MarshalIndent(results, "", "  ")
		if e := os.WriteFile(out, body, 0600); e != nil {
			t.Fatal(e)
		}
	}
}
