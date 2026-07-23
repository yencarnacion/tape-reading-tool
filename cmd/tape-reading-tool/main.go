package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
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
	dateFlag := fs.String("date", "", "render date in YYYY-MM-DD")
	outputFlag := fs.String("output", "", "render MP4 output path")
	warmupFlag := fs.String("warmup", "session", "render warmup: session or a duration such as 20m")
	fpsFlag := fs.Int("fps", 30, "render frames per second")
	resolutionFlag := fs.String("resolution", "1920x1080", "render resolution WIDTHxHEIGHT")
	codecFlag := fs.String("codec", "h264", "render codec: h264, h265, or av1")
	qualityFlag := fs.Int("quality", 24, "render encoder CRF quality")
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
	if mode == "render" {
		if *sourceFlag == "" {
			cfg.Replay.Source = "historical"
		}
		if *providerFlag == "" {
			cfg.Replay.Provider = "massive"
		}
		cfg.Tape.SnapshotTrades = cfg.Tape.RingSize
	}
	if symbol := tape.NormalizeSymbol(*symbolFlag); symbol != "" {
		cfg.Tape.DefaultSymbol = symbol
	}
	if *sourceFlag != "" {
		cfg.Replay.Source = strings.ToLower(*sourceFlag)
	}
	if *providerFlag != "" && (mode == "replay" || mode == "render") {
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
	if mode == "live" || mode == "massive" || mode == "replay" || mode == "render" || mode == "download" {
		if !cfg.Storage.Enabled && mode != "download" && mode != "replay" && mode != "render" {
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
	case "render":
		source = feed.NewReplay(database, store, cfg.Replay.Source, cfg.Replay.Provider, cfg.Replay.Speed)
	default:
		return fmt.Errorf("unknown mode %q; use live, massive, demo, replay, render, or download", mode)
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
	xtra := (chartMode || mode == "replay" || mode == "render") && *xtraFlag
	appServer := server.New(cfg, store, source, chartMode && (*chartFlag || xtra), xtra)
	if mode == "render" {
		options := renderOptions{
			date: *dateFlag, start: *startFlag, end: *endFlag, output: *outputFlag,
			warmup: *warmupFlag, fps: *fpsFlag, resolution: *resolutionFlag,
			codec: *codecFlag, quality: *qualityFlag, speed: cfg.Replay.Speed,
			symbol: cfg.Tape.DefaultSymbol, source: cfg.Replay.Source, provider: cfg.Replay.Provider,
		}
		return runRender(ctx, stop, cfg, source.(*feed.Replay), appServer, options)
	}
	return appServer.Serve(ctx)
}

type renderOptions struct {
	date, start, end, output, warmup, resolution, codec string
	fps, quality                                        int
	speed                                               float64
	symbol, source, provider                            string
}

func runRender(ctx context.Context, stop context.CancelFunc, cfg config.Config, replay *feed.Replay, appServer *server.Server, options renderOptions) error {
	if options.date == "" {
		return fmt.Errorf("render -date is required")
	}
	location, _ := time.LoadLocation(cfg.App.Timezone)
	start, err := parseRenderDateTime(options.date, options.start, location)
	if err != nil {
		return fmt.Errorf("render start: %w", err)
	}
	end, err := parseRenderDateTime(options.date, options.end, location)
	if err != nil {
		return fmt.Errorf("render end: %w", err)
	}
	if !end.After(start) {
		return fmt.Errorf("render end must be after start")
	}
	if options.fps < 1 || options.fps > 60 {
		return fmt.Errorf("render fps must be between 1 and 60")
	}
	if options.quality < 0 || options.quality > 63 {
		return fmt.Errorf("render quality must be between 0 and 63")
	}
	width, height, err := parseResolution(options.resolution)
	if err != nil {
		return err
	}
	dataRange, err := replay.DataRange(ctx, options.symbol, options.source, options.provider)
	if err != nil {
		return err
	}
	if start.UnixMicro() < dataRange.StartUS || end.UnixMicro() > dataRange.EndUS {
		return fmt.Errorf("render range %s–%s is outside available data %s–%s",
			start.In(location).Format("2006-01-02 15:04:05"), end.In(location).Format("15:04:05"),
			time.UnixMicro(dataRange.StartUS).In(location).Format("2006-01-02 15:04:05"),
			time.UnixMicro(dataRange.EndUS).In(location).Format("15:04:05"))
	}
	warmupUS := dataRange.StartUS
	if strings.ToLower(strings.TrimSpace(options.warmup)) != "session" {
		duration, durationErr := time.ParseDuration(options.warmup)
		if durationErr != nil || duration <= 0 {
			return fmt.Errorf("render warmup must be session or a positive duration")
		}
		warmupUS = start.Add(-duration).UnixMicro()
		if warmupUS < dataRange.StartUS {
			warmupUS = dataRange.StartUS
		}
	} else {
		dayStart := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, location).UnixMicro()
		if warmupUS < dayStart {
			warmupUS = dayStart
		}
	}
	warmupStarted := time.Now()
	fmt.Printf("render: warming replay state %s–%s ET\n",
		time.UnixMicro(warmupUS).In(location).Format("15:04:05"), start.In(location).Format("15:04:05"))
	if err := replay.PrepareRender(feed.ReplayRequest{
		Symbol: options.symbol, Source: options.source, Provider: options.provider,
		StartUS: start.UnixMicro(), EndUS: end.UnixMicro(), Speed: options.speed,
	}, warmupUS); err != nil {
		return err
	}
	fmt.Printf("render: warmup complete in %s\n", conciseDuration(time.Since(warmupStarted)))

	output := options.output
	if output == "" {
		output = filepath.Join("exports", fmt.Sprintf("%s-%s-%s-%s.mp4", options.symbol, options.date, start.Format("1504"), end.Format("1504")))
	}
	absoluteOutput, err := filepath.Abs(output)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(absoluteOutput), 0o755); err != nil {
		return fmt.Errorf("create render output directory: %w", err)
	}
	if _, err := os.Stat(absoluteOutput); err == nil {
		return fmt.Errorf("render output already exists: %s", absoluteOutput)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect render output: %w", err)
	}
	renderTemporary, err := os.MkdirTemp("", "tape-render-")
	if err != nil {
		return fmt.Errorf("create render temporary directory: %w", err)
	}
	defer os.RemoveAll(renderTemporary)

	serverErr := make(chan error, 1)
	go func() { serverErr <- appServer.Serve(ctx) }()
	baseURL := renderBaseURL(cfg.App.Addr)
	if err := waitForHTTP(ctx, baseURL+"/api/health"); err != nil {
		stop()
		select {
		case serveErr := <-serverErr:
			if serveErr != nil {
				return fmt.Errorf("render server: %w", serveErr)
			}
		default:
		}
		return err
	}
	args := []string{
		"scripts/render-replay.mjs",
		"--url", baseURL, "--symbol", options.symbol, "--source", options.source, "--provider", options.provider,
		"--start-us", strconv.FormatInt(start.UnixMicro(), 10), "--end-us", strconv.FormatInt(end.UnixMicro(), 10),
		"--fps", strconv.Itoa(options.fps), "--width", strconv.Itoa(width), "--height", strconv.Itoa(height),
		"--speed", strconv.FormatFloat(options.speed, 'f', -1, 64), "--codec", options.codec,
		"--quality", strconv.Itoa(options.quality), "--output", absoluteOutput,
		"--temp-dir", renderTemporary,
	}
	command := exec.CommandContext(ctx, "node", args...)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Cancel = func() error {
		return command.Process.Signal(os.Interrupt)
	}
	command.WaitDelay = 5 * time.Second
	runErr := command.Run()
	stop()
	select {
	case serveErr := <-serverErr:
		if runErr == nil && serveErr != nil {
			runErr = serveErr
		}
	case <-time.After(6 * time.Second):
	}
	if runErr != nil {
		_ = os.Remove(absoluteOutput)
		return fmt.Errorf("render: %w", runErr)
	}
	fmt.Printf("render complete: %s\n", absoluteOutput)
	return nil
}

func renderBaseURL(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "http://127.0.0.1" + addr
	}
	host, port, found := strings.Cut(addr, ":")
	if !found {
		return "http://127.0.0.1:" + addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "localhost" {
		host = "127.0.0.1"
	}
	return "http://" + host + ":" + port
}

func conciseDuration(duration time.Duration) string {
	if duration < time.Second {
		return fmt.Sprintf("%dms", duration.Milliseconds())
	}
	if duration < time.Minute {
		return fmt.Sprintf("%.1fs", duration.Seconds())
	}
	return fmt.Sprintf("%dm%02ds", int(duration/time.Minute), int(duration/time.Second)%60)
}

func parseRenderDateTime(date, clock string, location *time.Location) (time.Time, error) {
	date = strings.TrimSpace(date)
	clock = strings.TrimSpace(clock)
	if clock == "" {
		return time.Time{}, fmt.Errorf("time is required")
	}
	if strings.Contains(clock, "T") || strings.Contains(clock, " ") {
		return parseDateTime(clock, location)
	}
	return parseDateTime(date+" "+clock, location)
}

func parseResolution(value string) (int, int, error) {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(value)), "x")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("render resolution must be WIDTHxHEIGHT")
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil || width < 640 || height < 480 || width > 7680 || height > 4320 {
		return 0, 0, fmt.Errorf("render resolution must be between 640x480 and 7680x4320")
	}
	return width, height, nil
}

func waitForHTTP(ctx context.Context, url string) error {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		response, err := client.Do(request)
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return fmt.Errorf("render server did not become ready at %s", url)
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
