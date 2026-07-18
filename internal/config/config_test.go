package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAppliesEnvironmentOverrides(t *testing.T) {
	t.Setenv("IBKR_HOST", "192.0.2.4")
	t.Setenv("IBKR_PORT", "4002")
	t.Setenv("IBKR_CLIENT_ID", "123")
	t.Setenv("DEFAULT_TICKER", "nvda")
	t.Setenv("PORT", "9191")
	t.Setenv("MASSIVE_API_KEY", "test-key-not-a-secret")

	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.IBKR.Host != "192.0.2.4" || cfg.IBKR.Port != 4002 || cfg.IBKR.ClientID != 123 {
		t.Fatalf("IBKR overrides not applied: %+v", cfg.IBKR)
	}
	if cfg.Tape.DefaultSymbol != "NVDA" || cfg.App.Addr != ":9191" {
		t.Fatalf("app overrides not applied: app=%+v tape=%+v", cfg.App, cfg.Tape)
	}
	if cfg.Massive.APIKey != "test-key-not-a-secret" {
		t.Fatal("Massive API key override not applied")
	}
}

func TestLoadDotEnvDoesNotReplaceExportedValues(t *testing.T) {
	t.Setenv("IBKR_HOST", "exported-host")
	t.Setenv("PORT", "")
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("IBKR_HOST=file-host\nPORT=8123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := LoadDotEnv(path); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("IBKR_HOST"); got != "exported-host" {
		t.Fatalf("IBKR_HOST = %q", got)
	}
	if got := os.Getenv("PORT"); got != "8123" {
		t.Fatalf("PORT = %q", got)
	}
}

func TestValidateRejectsInvalidTapeSettings(t *testing.T) {
	cfg := Defaults()
	cfg.Tape.SnapshotTrades = cfg.Tape.RingSize + 1
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected validation error")
	}
}

func TestReplayChartRightGapBars(t *testing.T) {
	cfg := Defaults()
	if cfg.Replay.ChartRightGapBars != 5 {
		t.Fatalf("default replay chart right gap = %d, want 5", cfg.Replay.ChartRightGapBars)
	}

	for _, gap := range []int{5, 100} {
		cfg.Replay.ChartRightGapBars = gap
		if err := cfg.Validate(); err != nil {
			t.Fatalf("gap %d should be valid: %v", gap, err)
		}
	}
	for _, gap := range []int{4, 101} {
		cfg.Replay.ChartRightGapBars = gap
		if err := cfg.Validate(); err == nil {
			t.Fatalf("gap %d should be invalid", gap)
		}
	}
}

func TestValidateAudioGainRanges(t *testing.T) {
	cfg := Defaults()
	cfg.Audio.MasterVolume = 2
	cfg.Audio.TapeRateVolume = 1
	cfg.Audio.MinimumGain = 1.5
	if err := cfg.Validate(); err != nil {
		t.Fatalf("maximum audio gain values should be valid: %v", err)
	}

	cfg.Audio.MasterVolume = 2.01
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected master volume validation error")
	}

	cfg = Defaults()
	cfg.Audio.TapeRateVolume = 1.01
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected tape rate volume validation error")
	}

	cfg = Defaults()
	cfg.Audio.MinimumGain = 0.09
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected minimum gain validation error")
	}
}
