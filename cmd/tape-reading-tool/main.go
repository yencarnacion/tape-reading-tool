package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/server"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	if err := config.LoadDotEnv(".env"); err != nil {
		return fmt.Errorf("load .env: %w", err)
	}
	mode := "live"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		mode = strings.ToLower(args[0])
		args = args[1:]
	}
	fs := flag.NewFlagSet(mode, flag.ContinueOnError)
	configPath := fs.String("config", "config.yaml", "config file")
	addr := fs.String("addr", "", "HTTP listen address override")
	databasePath := fs.String("db", "", "SQLite recording database override")
	symbolFlag := fs.String("symbol", "", "stock symbol override")
	startFlag := fs.String("start", "", "historical start time (RFC3339 or local YYYY-MM-DD HH:MM:SS)")
	endFlag := fs.String("end", "", "historical end time (RFC3339 or local YYYY-MM-DD HH:MM:SS)")
	useRTH := fs.Bool("rth", false, "limit historical download to regular trading hours")
	sourceFlag := fs.String("source", "", "replay source: live, historical, or all")
	providerFlag := fs.String("provider", "", "data provider: ibkr, massive, or all (replay only)")
	speedFlag := fs.Float64("speed", 0, "default replay speed")
	chartFlag := fs.Bool("chart", false, "show the one-minute market chart in live mode")
	xtraFlag := fs.Bool("xtra", false, "show prior-session, pre-market, RTH, and opening levels on the one-minute chart")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	if *addr != "" {
		cfg.App.Addr = *addr
	}
	if *databasePath != "" {
		cfg.Storage.Path = *databasePath
	}
	if symbol := tape.NormalizeSymbol(*symbolFlag); symbol != "" {
		cfg.Tape.DefaultSymbol = symbol
	}
	if *sourceFlag != "" {
		cfg.Replay.Source = strings.ToLower(*sourceFlag)
	}
	if *providerFlag != "" && mode == "replay" {
		cfg.Replay.Provider = strings.ToLower(*providerFlag)
	}
	if *speedFlag != 0 {
		cfg.Replay.Speed = *speedFlag
	}
	if err := cfg.Validate(); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var database *storage.Database
	if mode == "live" || mode == "massive" || mode == "replay" || mode == "download" {
		if !cfg.Storage.Enabled && mode != "download" && mode != "replay" {
			log.Printf("SQLite live recording disabled")
		} else {
			var err error
			database, err = storage.Open(cfg.Storage)
			if err != nil {
				return fmt.Errorf("open recording database: %w", err)
			}
			defer func() {
				if err := database.Close(); err != nil {
					log.Printf("close recording database: %v", err)
				}
			}()
			log.Printf("SQLite recording database=%s", database.Path())
		}
	}

	if mode == "download" {
		location, _ := time.LoadLocation(cfg.App.Timezone)
		start, err := parseDateTime(*startFlag, location)
		if err != nil {
			return fmt.Errorf("start: %w", err)
		}
		end, err := parseDateTime(*endFlag, location)
		if err != nil {
			return fmt.Errorf("end: %w", err)
		}
		symbol := tape.NormalizeSymbol(*symbolFlag)
		if symbol == "" {
			symbol = cfg.Tape.DefaultSymbol
		}
		interval, _ := time.ParseDuration(cfg.Storage.HistoricalRequestInterval)
		options := feed.HistoricalOptions{Symbol: symbol, Start: start, End: end, UseRTH: *useRTH, RequestInterval: interval}
		provider := strings.ToLower(strings.TrimSpace(*providerFlag))
		if provider == "" {
			provider = "ibkr"
		}
		switch provider {
		case "ibkr":
			return feed.DownloadHistorical(ctx, cfg.IBKR, database, options)
		case "massive":
			return feed.DownloadMassiveHistorical(ctx, cfg.Massive, database, options)
		default:
			return fmt.Errorf("download provider must be ibkr or massive")
		}
	}

	store := tape.NewStore(cfg.Tape.DefaultSymbol, cfg.Tape.RingSize, cfg.Tape.HistorySize)
	var source feed.Feed
	switch mode {
	case "live":
		source = feed.NewIBKR(cfg.IBKR, store, database)
	case "demo":
		source = feed.NewDemo(store)
	case "massive":
		source = feed.NewMassive(cfg.Massive, store, database)
	case "replay":
		source = feed.NewReplay(database, store, cfg.Replay.Source, cfg.Replay.Provider, cfg.Replay.Speed)
	default:
		return fmt.Errorf("unknown mode %q; use live, massive, demo, replay, or download", mode)
	}
	log.Printf("starting mode=%s http_addr=%s default_symbol=%s", mode, cfg.App.Addr, cfg.Tape.DefaultSymbol)
	if mode == "live" {
		log.Printf(
			"IBKR config host=%s port=%d client_id=%d contract=%s/%s/%s primary_exchange=%q market_data_type=%d",
			cfg.IBKR.Host, cfg.IBKR.Port, cfg.IBKR.ClientID, cfg.IBKR.SecurityType,
			cfg.IBKR.Exchange, cfg.IBKR.Currency, cfg.IBKR.PrimaryExchange, cfg.IBKR.MarketDataType,
		)
	}
	go source.Run(ctx)

	fmt.Printf("%s %s: http://localhost%s\n", cfg.App.Name, mode, displayAddr(cfg.App.Addr))
	chartMode := mode == "live" || mode == "demo"
	xtra := (chartMode || mode == "replay") && *xtraFlag
	return server.New(cfg, store, source, chartMode && (*chartFlag || xtra), xtra).Serve(ctx)
}

func parseDateTime(value string, location *time.Location) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, fmt.Errorf("value is required")
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed, nil
	}
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02 15:04", "2006-01-02T15:04"} {
		if parsed, err := time.ParseInLocation(layout, value, location); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("use RFC3339 or YYYY-MM-DD HH:MM[:SS]")
}

func displayAddr(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return addr
	}
	if strings.HasPrefix(addr, "127.0.0.1:") {
		return ":" + strings.TrimPrefix(addr, "127.0.0.1:")
	}
	if strings.HasPrefix(addr, "localhost:") {
		return ":" + strings.TrimPrefix(addr, "localhost:")
	}
	return "/" + addr
}
