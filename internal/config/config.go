package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	App     AppConfig     `yaml:"app" json:"app"`
	IBKR    IBKRConfig    `yaml:"ibkr" json:"ibkr"`
	Tape    TapeConfig    `yaml:"tape" json:"tape"`
	Display DisplayConfig `yaml:"display" json:"display"`
	Audio   AudioConfig   `yaml:"audio" json:"audio"`
	Storage StorageConfig `yaml:"storage" json:"storage"`
	Replay  ReplayConfig  `yaml:"replay" json:"replay"`
	Massive MassiveConfig `yaml:"massive" json:"massive"`
}

type AppConfig struct {
	Name     string `yaml:"name" json:"name"`
	Addr     string `yaml:"addr" json:"addr"`
	Timezone string `yaml:"timezone" json:"timezone"`
}

type IBKRConfig struct {
	Host              string `yaml:"host" json:"host"`
	Port              int    `yaml:"port" json:"port"`
	ClientID          int64  `yaml:"client_id" json:"client_id"`
	Exchange          string `yaml:"exchange" json:"exchange"`
	PrimaryExchange   string `yaml:"primary_exchange" json:"primary_exchange"`
	Currency          string `yaml:"currency" json:"currency"`
	SecurityType      string `yaml:"security_type" json:"security_type"`
	MarketDataType    int64  `yaml:"market_data_type" json:"market_data_type"`
	ReconnectInterval string `yaml:"reconnect_interval" json:"reconnect_interval"`
	ConnectTimeout    string `yaml:"connect_timeout" json:"connect_timeout"`
	SubscriptionCache int    `yaml:"subscription_cache" json:"subscription_cache"`
}

type TapeConfig struct {
	DefaultSymbol     string `yaml:"default_symbol" json:"default_symbol"`
	RingSize          int    `yaml:"ring_size" json:"ring_size"`
	SnapshotTrades    int    `yaml:"snapshot_trades" json:"snapshot_trades"`
	WebSocketBatch    string `yaml:"websocket_batch" json:"websocket_batch"`
	WebSocketMaxBatch int    `yaml:"websocket_max_batch" json:"websocket_max_batch"`
	HistorySize       int    `yaml:"history_size" json:"history_size"`
}

type DisplayConfig struct {
	TickSize    int  `yaml:"tick_size" json:"tick_size"`
	VisibleBars int  `yaml:"visible_bars" json:"visible_bars"`
	TapeRows    int  `yaml:"tape_rows" json:"tape_rows"`
	ShowSize    bool `yaml:"show_size" json:"show_size"`
	ShowChart   bool `yaml:"show_chart" json:"show_chart"`
	ShowTape    bool `yaml:"show_tape" json:"show_tape"`
}

type AudioConfig struct {
	Enabled         bool    `yaml:"enabled" json:"enabled"`
	MasterVolume    float64 `yaml:"master_volume" json:"master_volume"`
	TapeRateEnabled bool    `yaml:"tape_rate_enabled" json:"tape_rate_enabled"`
	TapeRateVolume  float64 `yaml:"tape_rate_volume" json:"tape_rate_volume"`
	MinimumGain     float64 `yaml:"minimum_gain" json:"minimum_gain"`
	BuyPitchHz      float64 `yaml:"buy_pitch_hz" json:"buy_pitch_hz"`
	SellPitchHz     float64 `yaml:"sell_pitch_hz" json:"sell_pitch_hz"`
	DurationMS      float64 `yaml:"duration_ms" json:"duration_ms"`
	LargeSize       float64 `yaml:"large_size" json:"large_size"`
	LargeBoost      float64 `yaml:"large_boost" json:"large_boost"`
	MaxVoices       int     `yaml:"max_voices" json:"max_voices"`
}

type StorageConfig struct {
	Enabled                   bool   `yaml:"enabled" json:"enabled"`
	Path                      string `yaml:"path" json:"path"`
	QueueSize                 int    `yaml:"queue_size" json:"queue_size"`
	BatchSize                 int    `yaml:"batch_size" json:"batch_size"`
	FlushInterval             string `yaml:"flush_interval" json:"flush_interval"`
	HistoricalRequestInterval string `yaml:"historical_request_interval" json:"historical_request_interval"`
}

type ReplayConfig struct {
	Source            string  `yaml:"source" json:"source"`
	Provider          string  `yaml:"provider" json:"provider"`
	Speed             float64 `yaml:"speed" json:"speed"`
	ChartRightGapBars int     `yaml:"chart_right_gap_bars" json:"chart_right_gap_bars"`
}

type MassiveConfig struct {
	APIKey string `yaml:"api_key" json:"-"`
	Feed   string `yaml:"feed" json:"feed"`
}

func Defaults() Config {
	return Config{
		App: AppConfig{Name: "tape-reading-tool", Addr: ":8097", Timezone: "America/New_York"},
		IBKR: IBKRConfig{
			Host: "127.0.0.1", Port: 7497, ClientID: 97, Exchange: "SMART",
			Currency: "USD", SecurityType: "STK", MarketDataType: 1,
			ReconnectInterval: "2s", ConnectTimeout: "3s", SubscriptionCache: 3,
		},
		Tape: TapeConfig{
			DefaultSymbol: "AAPL", RingSize: 50000, SnapshotTrades: 12000,
			WebSocketBatch: "16ms", WebSocketMaxBatch: 4096, HistorySize: 8,
		},
		Display: DisplayConfig{
			TickSize: 1, VisibleBars: 360, TapeRows: 90,
			ShowSize: true, ShowChart: true, ShowTape: true,
		},
		Audio: AudioConfig{
			Enabled: true, MasterVolume: 0.45, TapeRateEnabled: true, TapeRateVolume: 0.35,
			MinimumGain: 0.65, BuyPitchHz: 660, SellPitchHz: 490,
			DurationMS: 110, LargeSize: 1000, LargeBoost: 1.8, MaxVoices: 192,
		},
		Storage: StorageConfig{
			Enabled: true, Path: "data/tape.db", QueueSize: 262144,
			BatchSize: 2048, FlushInterval: "50ms", HistoricalRequestInterval: "11s",
		},
		Replay:  ReplayConfig{Source: "live", Provider: "all", Speed: 1, ChartRightGapBars: 5},
		Massive: MassiveConfig{Feed: "realtime"},
	}
}

func Load(path string) (Config, error) {
	cfg := Defaults()
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return cfg, err
		}
		if err == nil {
			if err := yaml.Unmarshal(b, &cfg); err != nil {
				return cfg, fmt.Errorf("parse %s: %w", path, err)
			}
		}
	}
	if err := applyEnv(&cfg); err != nil {
		return cfg, err
	}
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.App.Name == "" || c.App.Addr == "" {
		return errors.New("app.name and app.addr are required")
	}
	if _, err := time.LoadLocation(c.App.Timezone); err != nil {
		return fmt.Errorf("app.timezone: %w", err)
	}
	if c.IBKR.Host == "" || c.IBKR.Port < 1 || c.IBKR.Port > 65535 {
		return errors.New("ibkr.host and a valid ibkr.port are required")
	}
	if c.IBKR.Exchange == "" || c.IBKR.Currency == "" || c.IBKR.SecurityType == "" {
		return errors.New("ibkr.exchange, currency, and security_type are required")
	}
	if c.IBKR.SubscriptionCache < 1 {
		return errors.New("ibkr.subscription_cache must be positive")
	}
	if _, err := time.ParseDuration(c.IBKR.ReconnectInterval); err != nil {
		return fmt.Errorf("ibkr.reconnect_interval: %w", err)
	}
	if _, err := time.ParseDuration(c.IBKR.ConnectTimeout); err != nil {
		return fmt.Errorf("ibkr.connect_timeout: %w", err)
	}
	if normalizeSymbol(c.Tape.DefaultSymbol) == "" {
		return errors.New("tape.default_symbol is invalid")
	}
	if c.Tape.RingSize < 100 || c.Tape.SnapshotTrades < 1 || c.Tape.SnapshotTrades > c.Tape.RingSize {
		return errors.New("tape ring_size must be at least 100 and snapshot_trades must fit inside it")
	}
	if c.Tape.WebSocketMaxBatch < 1 || c.Tape.HistorySize < 1 {
		return errors.New("tape websocket_max_batch and history_size must be positive")
	}
	if _, err := time.ParseDuration(c.Tape.WebSocketBatch); err != nil {
		return fmt.Errorf("tape.websocket_batch: %w", err)
	}
	if c.Display.TickSize < 1 || c.Display.VisibleBars < 20 || c.Display.TapeRows < 10 {
		return errors.New("display tick_size, visible_bars, and tape_rows are too small")
	}
	if c.Audio.MasterVolume < 0 || c.Audio.MasterVolume > 2 || c.Audio.TapeRateVolume < 0 || c.Audio.TapeRateVolume > 1 || c.Audio.MinimumGain < 0.1 || c.Audio.MinimumGain > 1.5 || c.Audio.BuyPitchHz <= 0 || c.Audio.SellPitchHz <= 0 {
		return errors.New("audio volume must be 0..2, tape_rate_volume must be 0..1, minimum_gain must be 0.1..1.5, and pitches must be positive")
	}
	if c.Audio.DurationMS <= 0 || c.Audio.LargeSize <= 0 || c.Audio.LargeBoost <= 0 || c.Audio.MaxVoices < 8 {
		return errors.New("audio duration, large size/boost, and max voices are invalid")
	}
	if c.Storage.Path == "" || c.Storage.QueueSize < 1024 || c.Storage.BatchSize < 1 || c.Storage.BatchSize > c.Storage.QueueSize {
		return errors.New("storage path, queue_size, and batch_size are invalid")
	}
	if _, err := time.ParseDuration(c.Storage.FlushInterval); err != nil {
		return fmt.Errorf("storage.flush_interval: %w", err)
	}
	if _, err := time.ParseDuration(c.Storage.HistoricalRequestInterval); err != nil {
		return fmt.Errorf("storage.historical_request_interval: %w", err)
	}
	if c.Replay.Source != "live" && c.Replay.Source != "historical" && c.Replay.Source != "all" {
		return errors.New("replay.source must be live, historical, or all")
	}
	if c.Replay.Provider != "ibkr" && c.Replay.Provider != "massive" && c.Replay.Provider != "all" {
		return errors.New("replay.provider must be ibkr, massive, or all")
	}
	if c.Replay.Speed < 0.1 || c.Replay.Speed > 20 {
		return errors.New("replay.speed must be between 0.1 and 20")
	}
	if c.Replay.ChartRightGapBars < 5 || c.Replay.ChartRightGapBars > 100 {
		return errors.New("replay.chart_right_gap_bars must be between 5 and 100")
	}
	if c.Massive.Feed != "realtime" && c.Massive.Feed != "delayed" {
		return errors.New("massive.feed must be realtime or delayed")
	}
	return nil
}

func LoadDotEnv(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, raw := range strings.Split(string(b), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key != "" && os.Getenv(key) == "" {
			if err := os.Setenv(key, value); err != nil {
				return err
			}
		}
	}
	return nil
}

func applyEnv(c *Config) error {
	if value := strings.TrimSpace(os.Getenv("IBKR_HOST")); value != "" {
		c.IBKR.Host = value
	}
	for key, target := range map[string]*int{"IBKR_PORT": &c.IBKR.Port} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			parsed, err := strconv.Atoi(value)
			if err != nil {
				return fmt.Errorf("%s: %w", key, err)
			}
			*target = parsed
		}
	}
	if value := strings.TrimSpace(os.Getenv("IBKR_CLIENT_ID")); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return fmt.Errorf("IBKR_CLIENT_ID: %w", err)
		}
		c.IBKR.ClientID = parsed
	}
	if value := normalizeSymbol(os.Getenv("DEFAULT_TICKER")); value != "" {
		c.Tape.DefaultSymbol = value
	}
	if value := strings.TrimSpace(os.Getenv("MASSIVE_API_KEY")); value != "" {
		c.Massive.APIKey = value
	}
	if value := strings.TrimSpace(os.Getenv("PORT")); value != "" {
		port, err := strconv.Atoi(value)
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("PORT must be between 1 and 65535")
		}
		c.App.Addr = ":" + value
	}
	return nil
}

func normalizeSymbol(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) < 1 || len(value) > 16 {
		return ""
	}
	for _, r := range value {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '.' && r != '-' {
			return ""
		}
	}
	return value
}
