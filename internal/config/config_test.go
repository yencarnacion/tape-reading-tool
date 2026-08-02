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

func TestRewindDefaultsAndBounds(t *testing.T) {
	cfg := Defaults()
	if !cfg.Rewind.Enabled || cfg.Rewind.BufferSeconds != 180 || cfg.Rewind.AutoReturnSeconds != 20 || cfg.Rewind.MaxPrintsPerSecond != 2000 {
		t.Fatalf("rewind defaults = %+v", cfg.Rewind)
	}
	// 180s x 2000 prints/s x 82 bytes is the documented worst-case footprint.
	if bytes := cfg.RewindBufferBytes(); bytes != 180*2000*82 {
		t.Fatalf("rewind buffer bytes = %d", bytes)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("rewind defaults should be valid: %v", err)
	}

	for _, invalid := range []RewindConfig{
		{Enabled: true, BufferSeconds: 4, AutoReturnSeconds: 20, MaxPrintsPerSecond: 2000},
		{Enabled: true, BufferSeconds: 601, AutoReturnSeconds: 20, MaxPrintsPerSecond: 2000},
		{Enabled: true, BufferSeconds: 180, AutoReturnSeconds: 2, MaxPrintsPerSecond: 2000},
		{Enabled: true, BufferSeconds: 180, AutoReturnSeconds: 301, MaxPrintsPerSecond: 2000},
		{Enabled: true, BufferSeconds: 180, AutoReturnSeconds: 20, MaxPrintsPerSecond: 99},
		{Enabled: true, BufferSeconds: 180, AutoReturnSeconds: 20, MaxPrintsPerSecond: 20001},
		// Individually in range, but together they would reserve about 492 MB.
		{Enabled: true, BufferSeconds: 600, AutoReturnSeconds: 20, MaxPrintsPerSecond: 10000},
	} {
		cfg = Defaults()
		cfg.Rewind = invalid
		if err := cfg.Validate(); err == nil {
			t.Fatalf("rewind %+v should be invalid", invalid)
		}
	}

	// Disabling rewind must not require a valid buffer to be configured.
	cfg = Defaults()
	cfg.Rewind.Enabled = false
	if err := cfg.Validate(); err != nil {
		t.Fatalf("disabled rewind should validate: %v", err)
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

func TestExternalReplayDefaultsAreOffAndLoopbackOnly(t *testing.T) {
	defaults := Defaults()
	if defaults.ExternalReplay.Enabled {
		t.Fatal("external replay control must be off unless it is explicitly enabled")
	}
	if !defaults.ExternalReplay.LoopbackOnly {
		t.Fatal("external replay control must default to loopback-only")
	}
	if defaults.ExternalReplay.Token != "" {
		t.Fatal("a control token must never come from a default or from YAML")
	}
	if err := defaults.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestExternalReplayTokenComesOnlyFromTheEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	// A token written into YAML must not be loaded, even when it is present.
	if err := os.WriteFile(path, []byte("external_replay:\n  enabled: true\n  token: leaked-from-yaml\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TAPE_EXTERNAL_REPLAY_TOKEN", "from-environment")
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ExternalReplay.Token != "from-environment" {
		t.Fatalf("token = %q", loaded.ExternalReplay.Token)
	}
	if !loaded.ExternalReplay.Enabled {
		t.Fatal("enabled did not load")
	}
}

func TestExternalReplayValidationBounds(t *testing.T) {
	for name, mutate := range map[string]func(*Config){
		"warmup":             func(c *Config) { c.ExternalReplay.DefaultWarmup = "soon" },
		"warmup zero":        func(c *Config) { c.ExternalReplay.DefaultWarmup = "0s" },
		"tolerance":          func(c *Config) { c.ExternalReplay.SyncTolerance = "" },
		"tolerance negative": func(c *Config) { c.ExternalReplay.SyncTolerance = "-1ms" },
		"speed low":          func(c *Config) { c.ExternalReplay.MaxDetailedSpeed = 0 },
		"speed high": func(c *Config) {
			c.ExternalReplay.MaxDetailedSpeed = 21
		},
	} {
		cfg := Defaults()
		mutate(&cfg)
		if err := cfg.Validate(); err == nil {
			t.Fatalf("%s: expected a validation error", name)
		}
	}
}
