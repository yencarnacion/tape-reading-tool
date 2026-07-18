package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/tape"
)

const schema = `
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  event_us INTEGER NOT NULL,
  received_us INTEGER NOT NULL DEFAULT 0,
  exchange_time_ms INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL,
  size REAL NOT NULL,
  class TEXT NOT NULL DEFAULT 'mid',
  side INTEGER NOT NULL DEFAULT 0,
  bid REAL NOT NULL DEFAULT 0,
  ask REAL NOT NULL DEFAULT 0,
  exchange TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  provider TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_replay_idx ON trades(symbol, source, provider, event_us, id);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  event_us INTEGER NOT NULL,
  received_us INTEGER NOT NULL DEFAULT 0,
  bid REAL NOT NULL DEFAULT 0,
  ask REAL NOT NULL DEFAULT 0,
  bid_size REAL NOT NULL DEFAULT 0,
  ask_size REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  provider TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_replay_idx ON quotes(symbol, source, provider, event_us, id);
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO metadata(key, value) VALUES ('schema_version', '1');
`

type TradeRecord struct {
	Symbol         string
	EventUS        int64
	ReceivedUS     int64
	ExchangeTimeMS int64
	Price          float64
	Size           float64
	Class          tape.Classification
	Side           int8
	Bid            float64
	Ask            float64
	Exchange       string
	Conditions     string
	Source         string
	Provider       string
}

type QuoteRecord struct {
	Symbol     string
	EventUS    int64
	ReceivedUS int64
	Bid        float64
	Ask        float64
	BidSize    float64
	AskSize    float64
	Source     string
	Provider   string
}

type Event struct {
	ID             int64
	Kind           string
	Source         string
	Provider       string
	EventUS        int64
	ReceivedUS     int64
	ExchangeTimeMS int64
	Price          float64
	Size           float64
	Class          tape.Classification
	Side           int8
	Bid            float64
	Ask            float64
	BidSize        float64
	AskSize        float64
}

type Range struct {
	Symbol   string `json:"symbol"`
	Source   string `json:"source"`
	Provider string `json:"provider"`
	StartUS  int64  `json:"start_us"`
	EndUS    int64  `json:"end_us"`
	Trades   int64  `json:"trades"`
	Quotes   int64  `json:"quotes"`
}

type MinuteBar struct {
	TimeUS       int64   `json:"time_us"`
	Open         float64 `json:"open"`
	High         float64 `json:"high"`
	Low          float64 `json:"low"`
	Close        float64 `json:"close"`
	Volume       float64 `json:"volume"`
	DollarVolume float64 `json:"dollar_volume"`
}

type queuedRecord struct {
	trade *TradeRecord
	quote *QuoteRecord
}

type Database struct {
	db      *sql.DB
	path    string
	queue   chan queuedRecord
	done    chan struct{}
	batch   int
	flush   time.Duration
	close   sync.Once
	dropped atomic.Uint64
	errMu   sync.RWMutex
	lastErr error
}

func Open(cfg config.StorageConfig) (*Database, error) {
	if err := os.MkdirAll(filepath.Dir(cfg.Path), 0o755); err != nil {
		return nil, fmt.Errorf("create storage directory: %w", err)
	}
	db, err := sql.Open("sqlite", cfg.Path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL", "PRAGMA synchronous=NORMAL", "PRAGMA temp_store=MEMORY",
		"PRAGMA busy_timeout=5000", "PRAGMA foreign_keys=ON",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("sqlite %s: %w", pragma, err)
		}
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize sqlite schema: %w", err)
	}
	flush, _ := time.ParseDuration(cfg.FlushInterval)
	result := &Database{
		db: db, path: cfg.Path, queue: make(chan queuedRecord, cfg.QueueSize),
		done: make(chan struct{}), batch: cfg.BatchSize, flush: flush,
	}
	go result.writeLoop()
	return result, nil
}

func (d *Database) Path() string { return d.path }

func (d *Database) RecordTrade(record TradeRecord) bool {
	record.Source = normalizeSource(record.Source)
	record.Provider = normalizeProvider(record.Provider)
	item := queuedRecord{trade: &record}
	select {
	case d.queue <- item:
		return true
	default:
		d.dropped.Add(1)
		return false
	}
}

func (d *Database) RecordQuote(record QuoteRecord) bool {
	record.Source = normalizeSource(record.Source)
	record.Provider = normalizeProvider(record.Provider)
	item := queuedRecord{quote: &record}
	select {
	case d.queue <- item:
		return true
	default:
		d.dropped.Add(1)
		return false
	}
}

func (d *Database) Dropped() uint64 { return d.dropped.Load() }

func (d *Database) LastError() error {
	d.errMu.RLock()
	defer d.errMu.RUnlock()
	return d.lastErr
}

func (d *Database) Close() error {
	d.close.Do(func() { close(d.queue); <-d.done })
	return errors.Join(d.LastError(), d.db.Close())
}

func (d *Database) writeLoop() {
	defer close(d.done)
	ticker := time.NewTicker(d.flush)
	defer ticker.Stop()
	items := make([]queuedRecord, 0, d.batch)
	flush := func() {
		if len(items) == 0 {
			return
		}
		if err := d.writeBatch(context.Background(), items); err != nil {
			d.setError(err)
			d.dropped.Add(uint64(len(items)))
		}
		items = items[:0]
	}
	for {
		select {
		case item, ok := <-d.queue:
			if !ok {
				flush()
				return
			}
			items = append(items, item)
			if len(items) >= d.batch {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func (d *Database) writeBatch(ctx context.Context, items []queuedRecord) error {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	tradeStmt, err := tx.PrepareContext(ctx, `INSERT INTO trades
    (symbol,event_us,received_us,exchange_time_ms,price,size,class,side,bid,ask,exchange,conditions,source,provider)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer tradeStmt.Close()
	quoteStmt, err := tx.PrepareContext(ctx, `INSERT INTO quotes
    (symbol,event_us,received_us,bid,ask,bid_size,ask_size,source,provider) VALUES (?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer quoteStmt.Close()
	for _, item := range items {
		if item.trade != nil {
			r := item.trade
			if _, err := tradeStmt.ExecContext(ctx, r.Symbol, r.EventUS, r.ReceivedUS, r.ExchangeTimeMS, r.Price, r.Size, r.Class, r.Side, r.Bid, r.Ask, r.Exchange, r.Conditions, r.Source, r.Provider); err != nil {
				tx.Rollback()
				return err
			}
		}
		if item.quote != nil {
			r := item.quote
			if _, err := quoteStmt.ExecContext(ctx, r.Symbol, r.EventUS, r.ReceivedUS, r.Bid, r.Ask, r.BidSize, r.AskSize, r.Source, r.Provider); err != nil {
				tx.Rollback()
				return err
			}
		}
	}
	return tx.Commit()
}

func (d *Database) InsertTrades(ctx context.Context, records []TradeRecord) error {
	items := make([]queuedRecord, len(records))
	for i := range records {
		records[i].Source = normalizeSource(records[i].Source)
		records[i].Provider = normalizeProvider(records[i].Provider)
		items[i].trade = &records[i]
	}
	return d.writeBatch(ctx, items)
}

func (d *Database) InsertQuotes(ctx context.Context, records []QuoteRecord) error {
	items := make([]queuedRecord, len(records))
	for i := range records {
		records[i].Source = normalizeSource(records[i].Source)
		records[i].Provider = normalizeProvider(records[i].Provider)
		items[i].quote = &records[i]
	}
	return d.writeBatch(ctx, items)
}

func (d *Database) DeleteRange(ctx context.Context, symbol, source, provider string, startUS, endUS int64) error {
	source = normalizeSource(source)
	provider = normalizeProvider(provider)
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	for _, table := range []string{"trades", "quotes"} {
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE symbol=? AND source=? AND provider=? AND event_us>=? AND event_us<=?", symbol, source, provider, startUS, endUS); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (d *Database) DataRange(ctx context.Context, symbol, source, provider string) (Range, error) {
	filter, args, err := dataFilter(source, provider)
	if err != nil {
		return Range{}, err
	}
	args = append([]any{symbol}, args...)
	query := `SELECT MIN(event_us), MAX(event_us), SUM(trades), SUM(quotes) FROM (
    SELECT event_us, 1 AS trades, 0 AS quotes FROM trades WHERE symbol=? AND ` + filter + `
    UNION ALL
    SELECT event_us, 0 AS trades, 1 AS quotes FROM quotes WHERE symbol=? AND ` + filter + `)`
	queryArgs := append(append([]any{}, args...), args...)
	var start, end sql.NullInt64
	var trades, quotes sql.NullInt64
	if err := d.db.QueryRowContext(ctx, query, queryArgs...).Scan(&start, &end, &trades, &quotes); err != nil {
		return Range{}, err
	}
	return Range{Symbol: symbol, Source: source, Provider: provider, StartUS: start.Int64, EndUS: end.Int64, Trades: trades.Int64, Quotes: quotes.Int64}, nil
}

func (d *Database) Events(ctx context.Context, symbol, source, provider string, startUS, endUS int64) (*sql.Rows, error) {
	filter, sourceArgs, err := dataFilter(source, provider)
	if err != nil {
		return nil, err
	}
	query := `SELECT id,kind,source,provider,event_us,received_us,exchange_time_ms,price,size,class,side,bid,ask,bid_size,ask_size FROM (
	    SELECT 'trade' AS kind,source,provider,event_us,received_us,exchange_time_ms,price,size,class,side,bid,ask,0 AS bid_size,0 AS ask_size,id
	      FROM trades WHERE symbol=? AND ` + filter + ` AND event_us>=? AND event_us<=?
	    UNION ALL
	    SELECT 'quote' AS kind,source,provider,event_us,received_us,0 AS exchange_time_ms,0 AS price,0 AS size,'' AS class,0 AS side,bid,ask,bid_size,ask_size,id
      FROM quotes WHERE symbol=? AND ` + filter + ` AND event_us>=? AND event_us<=?
  ) ORDER BY event_us, CASE kind WHEN 'quote' THEN 0 ELSE 1 END, id`
	args := []any{symbol}
	args = append(args, sourceArgs...)
	args = append(args, startUS, endUS, symbol)
	args = append(args, sourceArgs...)
	args = append(args, startUS, endUS)
	return d.db.QueryContext(ctx, query, args...)
}

// MinuteBars aggregates exact trade prints up to endUS. Keeping this on the
// replay API prevents a browser reload or seek from exposing the unfinished
// portion of the current minute.
func (d *Database) MinuteBars(ctx context.Context, symbol, source, provider string, startUS, endUS int64) ([]MinuteBar, error) {
	filter, filterArgs, err := dataFilter(source, provider)
	if err != nil {
		return nil, err
	}
	query := `SELECT event_us,price,size FROM trades WHERE symbol=? AND ` + filter + ` AND event_us>=? AND event_us<=? ORDER BY event_us,id`
	args := []any{symbol}
	args = append(args, filterArgs...)
	args = append(args, startUS, endUS)
	rows, err := d.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bars := make([]MinuteBar, 0, 1024)
	for rows.Next() {
		var eventUS int64
		var price, size float64
		if err := rows.Scan(&eventUS, &price, &size); err != nil {
			return nil, err
		}
		minuteUS := eventUS - eventUS%int64(time.Minute/time.Microsecond)
		if len(bars) == 0 || bars[len(bars)-1].TimeUS != minuteUS {
			bars = append(bars, MinuteBar{TimeUS: minuteUS, Open: price, High: price, Low: price, Close: price})
		}
		bar := &bars[len(bars)-1]
		bar.High = max(bar.High, price)
		bar.Low = min(bar.Low, price)
		bar.Close = price
		bar.Volume += size
		bar.DollarVolume += price * size
	}
	return bars, rows.Err()
}

func ScanEvent(rows *sql.Rows) (Event, error) {
	var event Event
	err := rows.Scan(&event.ID, &event.Kind, &event.Source, &event.Provider, &event.EventUS, &event.ReceivedUS, &event.ExchangeTimeMS, &event.Price, &event.Size, &event.Class, &event.Side, &event.Bid, &event.Ask, &event.BidSize, &event.AskSize)
	return event, err
}

func (d *Database) setError(err error) {
	d.errMu.Lock()
	d.lastErr = err
	d.errMu.Unlock()
}

func normalizeSource(source string) string {
	if source == "historical" {
		return source
	}
	return "live"
}

func normalizeProvider(provider string) string {
	if provider == "massive" {
		return provider
	}
	return "ibkr"
}

func dataFilter(source, provider string) (string, []any, error) {
	var clause string
	var args []any
	switch strings.ToLower(source) {
	case "live", "historical":
		clause = "source=?"
		args = append(args, strings.ToLower(source))
	case "all":
		clause = "source IN ('live','historical')"
	default:
		return "", nil, fmt.Errorf("invalid source %q", source)
	}
	switch strings.ToLower(provider) {
	case "ibkr", "massive":
		clause += " AND provider=?"
		args = append(args, strings.ToLower(provider))
	case "all":
		clause += " AND provider IN ('ibkr','massive')"
	default:
		return "", nil, fmt.Errorf("invalid provider %q", provider)
	}
	return clause, args, nil
}
