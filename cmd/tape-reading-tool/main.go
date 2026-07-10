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

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/server"
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

	store := tape.NewStore(cfg.Tape.DefaultSymbol, cfg.Tape.RingSize, cfg.Tape.HistorySize)
	var source feed.Feed
	switch mode {
	case "live":
		source = feed.NewIBKR(cfg.IBKR, store)
	case "demo":
		source = feed.NewDemo(store)
	default:
		return fmt.Errorf("unknown mode %q; use live or demo", mode)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
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
	return server.New(cfg, store, source).Serve(ctx)
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
