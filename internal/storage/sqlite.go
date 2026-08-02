package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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
  market_time_us INTEGER NOT NULL,
  sequence_id INTEGER NOT NULL,
  received_us INTEGER NOT NULL DEFAULT 0,
  exchange_time_ms INTEGER NOT NULL DEFAULT 0,
  ring_seq INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL,
  size REAL NOT NULL,
  class TEXT NOT NULL DEFAULT 'mid',
  side INTEGER NOT NULL DEFAULT 0,
  bid REAL NOT NULL DEFAULT 0,
  ask REAL NOT NULL DEFAULT 0,
  exchange TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '',
  feed_type TEXT NOT NULL,
  unreported INTEGER NOT NULL,
  past_limit INTEGER NOT NULL,
  chart_eligible INTEGER NOT NULL,
  chart_exclusion_reason TEXT NOT NULL,
  source TEXT NOT NULL,
  provider TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_replay_idx ON trades(symbol, source, provider, event_us, id);
CREATE INDEX IF NOT EXISTS trades_rewind_idx ON trades(symbol, source, provider, ring_seq);
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
CREATE TABLE IF NOT EXISTS ui_events (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  event_us INTEGER NOT NULL,
  received_us INTEGER NOT NULL,
  kind TEXT NOT NULL,
  value_num REAL NOT NULL DEFAULT 0,
  value_text TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  provider TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ui_events_idx ON ui_events(symbol, received_us);
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS minute_bars (
  symbol TEXT NOT NULL,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  minute_us INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  dollar_volume REAL NOT NULL DEFAULT 0,
  updated_us INTEGER NOT NULL,
  PRIMARY KEY(symbol, provider, source, minute_us)
);
CREATE INDEX IF NOT EXISTS minute_bars_range_idx ON minute_bars(symbol, provider, source, minute_us);
CREATE TABLE IF NOT EXISTS download_coverage (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  completed_us INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  CHECK(kind IN ('minute_bars','trades','quotes')),
  UNIQUE(symbol, provider, kind, start_us, end_us)
);
CREATE INDEX IF NOT EXISTS download_coverage_range_idx ON download_coverage(symbol, provider, kind, start_us, end_us);
INSERT OR IGNORE INTO metadata(key, value) VALUES ('schema_version', '4');
`

// SchemaVersion is the current layout. Version 3 is migrated additively; other
// historical and future versions are rejected without deleting the database.
const SchemaVersion = "4"

type TradeRecord struct {
	Symbol       string
	EventUS      int64
	MarketTimeUS int64
	SequenceID   uint64
	// RingSeq is the browser-visible sequence the in-memory tape ring assigned
	// to this print, or zero when the print never entered the ring. Live Rewind
	// backfill addresses events by this sequence, so it has to survive the ring.
	RingSeq              uint64
	ReceivedUS           int64
	ExchangeTimeMS       int64
	Price                float64
	Size                 float64
	Class                tape.Classification
	Side                 int8
	Bid                  float64
	Ask                  float64
	Exchange             string
	Conditions           string
	FeedType             string
	Unreported           bool
	PastLimit            bool
	ChartEligible        bool
	ChartExclusionReason string
	Source               string
	Provider             string
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

// UIEventRecord puts a display change on the same receipt timeline as the tape
// so a later rewind or replay can restore the view the trader was looking at.
type UIEventRecord struct {
	Symbol     string
	EventUS    int64
	ReceivedUS int64
	Kind       string
	ValueNum   float64
	ValueText  string
	Source     string
	Provider   string
}

const (
	UIEventSymbol   = "symbol"
	UIEventTickSize = "tick_size"
)

type Event struct {
	ID             int64
	Kind           string
	Source         string
	Provider       string
	EventUS        int64
	MarketTimeUS   int64
	SequenceID     uint64
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
	ChartEligible  bool
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

type Coverage struct {
	Symbol      string `json:"symbol"`
	Provider    string `json:"provider"`
	Kind        string `json:"kind"`
	StartUS     int64  `json:"start_us"`
	EndUS       int64  `json:"end_us"`
	CompletedUS int64  `json:"completed_us"`
	RowCount    int64  `json:"row_count"`
}

type Interval struct {
	StartUS int64 `json:"start_us"`
	EndUS   int64 `json:"end_us"`
}

type queuedRecord struct {
	trade   *TradeRecord
	quote   *QuoteRecord
	uiEvent *UIEventRecord
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

	readerOnce sync.Once
	reader     *sql.DB
	readerErr  error
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
	var oldVersion string
	versionErr := db.QueryRow("SELECT value FROM metadata WHERE key='schema_version'").Scan(&oldVersion)
	if versionErr == nil && oldVersion != "3" && oldVersion != SchemaVersion {
		db.Close()
		return nil, fmt.Errorf("database schema %s is unsupported by this build", oldVersion)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize sqlite schema: %w", err)
	}
	if versionErr == nil && oldVersion == "3" {
		if _, err := db.Exec("UPDATE metadata SET value=? WHERE key='schema_version'", SchemaVersion); err != nil {
			db.Close()
			return nil, fmt.Errorf("migrate sqlite schema 3 to %s: %w", SchemaVersion, err)
		}
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

// RecordUIEvent shares the non-blocking queue and batched writer the tape uses,
// so capturing a display change cannot add disk I/O to any feed callback.
func (d *Database) RecordUIEvent(record UIEventRecord) bool {
	record.Source = normalizeSource(record.Source)
	record.Provider = normalizeProvider(record.Provider)
	select {
	case d.queue <- queuedRecord{uiEvent: &record}:
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
	errs := []error{d.LastError(), d.db.Close()}
	if d.reader != nil {
		errs = append(errs, d.reader.Close())
	}
	return errors.Join(errs...)
}

// readOnly returns a connection pool that is separate from the recording pool.
// Live Rewind backfill reads must never compete with the batched writer for the
// recording connections, and WAL makes the concurrent read safe.
func (d *Database) readOnly() (*sql.DB, error) {
	d.readerOnce.Do(func() {
		reader, err := sql.Open("sqlite", "file:"+d.path+"?mode=ro")
		if err != nil {
			d.readerErr = err
			return
		}
		reader.SetMaxOpenConns(2)
		if _, err := reader.Exec("PRAGMA busy_timeout=2000"); err != nil {
			reader.Close()
			d.readerErr = err
			return
		}
		d.reader = reader
	})
	if d.readerErr != nil {
		return nil, d.readerErr
	}
	return d.reader, nil
}

// TradesByRingSeq serves the Live Rewind backfill range that the in-memory ring
// has already overwritten. Rows are matched on the persisted ring sequence and
// restricted to receipts from the running process, because the ring restarts its
// numbering when the program restarts.
func (d *Database) TradesByRingSeq(ctx context.Context, symbol string, fromSeq, toSeq uint64, minReceivedUS int64, limit int) ([]tape.Trade, error) {
	if symbol == "" || fromSeq == 0 || toSeq < fromSeq || limit < 1 {
		return nil, fmt.Errorf("invalid ring sequence range")
	}
	reader, err := d.readOnly()
	if err != nil {
		return nil, err
	}
	rows, err := reader.QueryContext(ctx, `SELECT ring_seq,exchange_time_ms,received_us,price,size,class,side,bid,ask
	  FROM trades WHERE symbol=? AND source='live' AND provider='ibkr'
	    AND ring_seq>=? AND ring_seq<=? AND received_us>=? AND chart_eligible=1
	  ORDER BY ring_seq LIMIT ?`, symbol, fromSeq, toSeq, minReceivedUS, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	trades := make([]tape.Trade, 0, min(limit, 4096))
	for rows.Next() {
		var trade tape.Trade
		if err := rows.Scan(&trade.Seq, &trade.ExchangeTimeMS, &trade.ReceivedUS, &trade.Price,
			&trade.Size, &trade.Class, &trade.Side, &trade.Bid, &trade.Ask); err != nil {
			return nil, err
		}
		trades = append(trades, trade)
	}
	return trades, rows.Err()
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
    (symbol,event_us,market_time_us,sequence_id,ring_seq,received_us,exchange_time_ms,price,size,class,side,bid,ask,exchange,conditions,feed_type,unreported,past_limit,chart_eligible,chart_exclusion_reason,source,provider)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
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
	// Display changes are rare next to prints, so their statement is prepared
	// only for the batches that actually contain one.
	var uiStmt *sql.Stmt
	defer func() {
		if uiStmt != nil {
			uiStmt.Close()
		}
	}()
	for _, item := range items {
		if item.trade != nil {
			r := item.trade
			normalizeTradeRecord(r)
			if _, err := tradeStmt.ExecContext(ctx, r.Symbol, r.EventUS, r.MarketTimeUS, r.SequenceID, r.RingSeq, r.ReceivedUS, r.ExchangeTimeMS, r.Price, r.Size, r.Class, r.Side, r.Bid, r.Ask, r.Exchange, r.Conditions, r.FeedType, r.Unreported, r.PastLimit, r.ChartEligible, r.ChartExclusionReason, r.Source, r.Provider); err != nil {
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
		if item.uiEvent != nil {
			r := item.uiEvent
			if uiStmt == nil {
				uiStmt, err = tx.PrepareContext(ctx, `INSERT INTO ui_events
	    (symbol,event_us,received_us,kind,value_num,value_text,source,provider) VALUES (?,?,?,?,?,?,?,?)`)
				if err != nil {
					tx.Rollback()
					return err
				}
			}
			if _, err := uiStmt.ExecContext(ctx, r.Symbol, r.EventUS, r.ReceivedUS, r.Kind, r.ValueNum, r.ValueText, r.Source, r.Provider); err != nil {
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

// UpsertMinuteBars replaces provider aggregates deterministically. Callers add
// coverage only after the complete provider request has succeeded.
func (d *Database) UpsertMinuteBars(ctx context.Context, symbol, provider string, bars []MinuteBar) error {
	symbol = strings.ToUpper(strings.TrimSpace(symbol))
	provider = normalizeProvider(provider)
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO minute_bars
      (symbol,provider,source,minute_us,open,high,low,close,volume,dollar_volume,updated_us)
      VALUES (?,?, 'historical',?,?,?,?,?,?,?,?)
      ON CONFLICT(symbol,provider,source,minute_us) DO UPDATE SET
      open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
      volume=excluded.volume,dollar_volume=excluded.dollar_volume,updated_us=excluded.updated_us`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()
	now := time.Now().UnixMicro()
	for _, b := range bars {
		if b.TimeUS <= 0 || b.High < b.Low {
			tx.Rollback()
			return fmt.Errorf("invalid minute bar")
		}
		if _, err := stmt.ExecContext(ctx, symbol, provider, b.TimeUS, b.Open, b.High, b.Low, b.Close, b.Volume, b.DollarVolume, now); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (d *Database) MarkCoverage(ctx context.Context, c Coverage) error {
	c.Symbol = strings.ToUpper(strings.TrimSpace(c.Symbol))
	c.Provider = normalizeProvider(c.Provider)
	if c.Symbol == "" || (c.Kind != "minute_bars" && c.Kind != "trades" && c.Kind != "quotes") || c.StartUS <= 0 || c.EndUS < c.StartUS || c.RowCount < 0 {
		return fmt.Errorf("invalid completed coverage")
	}
	if c.CompletedUS <= 0 {
		c.CompletedUS = time.Now().UnixMicro()
	}
	_, err := d.db.ExecContext(ctx, `INSERT INTO download_coverage(symbol,provider,kind,start_us,end_us,completed_us,row_count)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(symbol,provider,kind,start_us,end_us) DO UPDATE SET
      completed_us=excluded.completed_us,row_count=excluded.row_count`, c.Symbol, c.Provider, c.Kind, c.StartUS, c.EndUS, c.CompletedUS, c.RowCount)
	return err
}

func (d *Database) CoverageIntervals(ctx context.Context, symbol, provider, kind string, startUS, endUS int64) (covered, missing []Interval, err error) {
	if startUS <= 0 || endUS < startUS || (kind != "minute_bars" && kind != "trades" && kind != "quotes") {
		return nil, nil, fmt.Errorf("invalid coverage requirement")
	}
	rows, err := d.db.QueryContext(ctx, `SELECT start_us,end_us FROM download_coverage
      WHERE symbol=? AND provider=? AND kind=? AND end_us>=? AND start_us<=? ORDER BY start_us,end_us`,
		strings.ToUpper(strings.TrimSpace(symbol)), normalizeProvider(provider), kind, startUS, endUS)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a, b int64
		if err := rows.Scan(&a, &b); err != nil {
			return nil, nil, err
		}
		if a < startUS {
			a = startUS
		}
		if b > endUS {
			b = endUS
		}
		if len(covered) == 0 || a > covered[len(covered)-1].EndUS+1 {
			covered = append(covered, Interval{a, b})
		} else if b > covered[len(covered)-1].EndUS {
			covered[len(covered)-1].EndUS = b
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	next := startUS
	for _, iv := range covered {
		if iv.StartUS > next {
			missing = append(missing, Interval{next, iv.StartUS - 1})
		}
		if iv.EndUS >= next {
			next = iv.EndUS + 1
		}
	}
	if next <= endUS {
		missing = append(missing, Interval{next, endUS})
	}
	return covered, missing, nil
}

func (d *Database) HasCoverage(ctx context.Context, symbol, provider, kind string, startUS, endUS int64) (bool, error) {
	_, missing, err := d.CoverageIntervals(ctx, symbol, provider, kind, startUS, endUS)
	return err == nil && len(missing) == 0, err
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
	query := `SELECT id,kind,source,provider,event_us,market_time_us,sequence_id,received_us,exchange_time_ms,price,size,class,side,bid,ask,bid_size,ask_size,chart_eligible FROM (
	    SELECT 'trade' AS kind,source,provider,event_us,market_time_us,sequence_id,received_us,exchange_time_ms,price,size,class,side,bid,ask,0 AS bid_size,0 AS ask_size,chart_eligible,id
	      FROM trades WHERE symbol=? AND ` + filter + ` AND event_us>=? AND event_us<=?
	    UNION ALL
	    SELECT 'quote' AS kind,source,provider,event_us,event_us AS market_time_us,0 AS sequence_id,received_us,0 AS exchange_time_ms,0 AS price,0 AS size,'' AS class,0 AS side,bid,ask,bid_size,ask_size,1 AS chart_eligible,id
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
	query := `SELECT market_time_us,price,size FROM trades WHERE symbol=? AND ` + filter + ` AND market_time_us>=? AND market_time_us<=? AND chart_eligible=1 ORDER BY market_time_us,sequence_id,id`
	args := []any{symbol}
	args = append(args, filterArgs...)
	args = append(args, startUS, endUS)
	rows, err := d.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tradeBars := make(map[int64]MinuteBar)
	for rows.Next() {
		var eventUS int64
		var price, size float64
		if err := rows.Scan(&eventUS, &price, &size); err != nil {
			return nil, err
		}
		minuteUS := eventUS - eventUS%int64(time.Minute/time.Microsecond)
		bar, exists := tradeBars[minuteUS]
		if !exists {
			bar = MinuteBar{TimeUS: minuteUS, Open: price, High: price, Low: price, Close: price}
		}
		bar.High = max(bar.High, price)
		bar.Low = min(bar.Low, price)
		bar.Close = price
		bar.Volume += size
		bar.DollarVolume += price * size
		tradeBars[minuteUS] = bar
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// A provider aggregate is safe only for a minute that has fully elapsed.
	// The forming minute always comes exclusively from eligible prints through
	// endUS, which prevents future high/low/close/volume leakage.
	minuteSize := int64(time.Minute / time.Microsecond)
	currentMinute := endUS - endUS%minuteSize
	cached := make(map[int64]MinuteBar)
	if source == "historical" && provider != "all" {
		barRows, err := d.db.QueryContext(ctx, `SELECT minute_us,open,high,low,close,volume,dollar_volume FROM minute_bars
          WHERE symbol=? AND source='historical' AND provider=? AND minute_us>=? AND minute_us<? ORDER BY minute_us`,
			symbol, normalizeProvider(provider), startUS-startUS%minuteSize, currentMinute)
		if err != nil {
			return nil, err
		}
		for barRows.Next() {
			var b MinuteBar
			if err := barRows.Scan(&b.TimeUS, &b.Open, &b.High, &b.Low, &b.Close, &b.Volume, &b.DollarVolume); err != nil {
				barRows.Close()
				return nil, err
			}
			cached[b.TimeUS] = b
		}
		if err := barRows.Close(); err != nil {
			return nil, err
		}
	}
	for minute, b := range tradeBars {
		if minute == currentMinute {
			cached[minute] = b
			continue
		}
		complete := source != "historical" || provider == "all"
		if !complete {
			var err error
			complete, err = d.HasCoverage(ctx, symbol, provider, "trades", minute, minute+minuteSize-1)
			if err != nil {
				return nil, err
			}
		}
		if complete || cached[minute].TimeUS == 0 {
			cached[minute] = b
		}
	}
	keys := make([]int64, 0, len(cached))
	for minute := range cached {
		if minute <= currentMinute {
			keys = append(keys, minute)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	bars := make([]MinuteBar, 0, len(keys))
	for _, minute := range keys {
		bars = append(bars, cached[minute])
	}
	return bars, nil
}

func ScanEvent(rows *sql.Rows) (Event, error) {
	var event Event
	err := rows.Scan(&event.ID, &event.Kind, &event.Source, &event.Provider, &event.EventUS, &event.MarketTimeUS, &event.SequenceID, &event.ReceivedUS, &event.ExchangeTimeMS, &event.Price, &event.Size, &event.Class, &event.Side, &event.Bid, &event.Ask, &event.BidSize, &event.AskSize, &event.ChartEligible)
	return event, err
}

func normalizeTradeRecord(r *TradeRecord) {
	if r.MarketTimeUS <= 0 {
		r.MarketTimeUS = r.EventUS
	}
	if r.ReceivedUS <= 0 {
		r.ReceivedUS = r.EventUS
	}
	if r.EventUS <= 0 {
		r.EventUS = r.ReceivedUS
	}
	if r.ExchangeTimeMS <= 0 {
		r.ExchangeTimeMS = r.MarketTimeUS / 1000
	}
	if r.FeedType == "" {
		r.FeedType = tape.FeedLast
	}
	if !r.ChartEligible && r.ChartExclusionReason == "" {
		r.ChartEligible, r.ChartExclusionReason = tape.ChartEligibility(tape.TradeEligibilityInput{FeedType: r.FeedType, Price: r.Price, Size: r.Size, Unreported: r.Unreported})
	}
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
