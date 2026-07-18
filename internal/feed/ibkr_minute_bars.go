package feed

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/scmhub/ibapi"

	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

type ibkrBarRequest struct {
	bars   []storage.MinuteBar
	result chan ibkrBarResult
}

type ibkrBarResult struct {
	bars []storage.MinuteBar
	err  error
}

// RVOLMinuteBars requests a small, one-off IBKR TRADES bar history through the
// existing live session. The server caches it by symbol/minute, so this does
// not create a polling stream or compete with receipt-time tape calculations.
func (f *IBKR) RVOLMinuteBars(ctx context.Context, symbol string, endExclusive time.Time, limit int) ([]storage.MinuteBar, error) {
	symbol = tape.NormalizeSymbol(symbol)
	if symbol == "" || endExclusive.IsZero() || limit < 1 {
		return nil, fmt.Errorf("valid symbol, end time, and limit are required")
	}
	endExclusive = endExclusive.UTC().Truncate(time.Minute)

	f.mu.Lock()
	client := f.client
	if client == nil || !client.IsConnected() {
		f.mu.Unlock()
		return nil, fmt.Errorf("IBKR is not connected")
	}
	f.nextReqID++
	reqID := f.nextReqID
	request := &ibkrBarRequest{bars: make([]storage.MinuteBar, 0, 1024), result: make(chan ibkrBarResult, 1)}
	f.barRequests[reqID] = request
	f.reqSymbols[reqID] = symbol
	f.mu.Unlock()

	contract := &ibapi.Contract{
		Symbol: symbol, SecType: f.cfg.SecurityType, Exchange: f.cfg.Exchange,
		PrimaryExchange: f.cfg.PrimaryExchange, Currency: f.cfg.Currency,
	}
	client.ReqHistoricalData(
		reqID, contract, endExclusive.Format("20060102-15:04:05"), "7 D", "1 min", "TRADES",
		false, 2, false, nil,
	)

	select {
	case result := <-request.result:
		if result.err != nil {
			return nil, result.err
		}
		return latestCompletedBars(result.bars, endExclusive, limit), nil
	case <-ctx.Done():
		f.mu.Lock()
		_, pending := f.barRequests[reqID]
		if pending {
			delete(f.barRequests, reqID)
			delete(f.reqSymbols, reqID)
		}
		currentClient := f.client
		f.mu.Unlock()
		if pending && currentClient != nil && currentClient.IsConnected() {
			currentClient.CancelHistoricalData(reqID)
		}
		return nil, ctx.Err()
	}
}

func (w *ibWrapper) HistoricalData(reqID int64, bar *ibapi.Bar) {
	if bar == nil {
		return
	}
	timeUS, err := ibkrBarTimeUS(bar.Date)
	if err != nil {
		return
	}
	volume := bar.Volume.Float()
	vwap := bar.Wap.Float()
	if math.IsNaN(volume) || volume < 0 {
		volume = 0
	}
	if math.IsNaN(vwap) || vwap <= 0 {
		vwap = bar.Close
	}
	item := storage.MinuteBar{
		TimeUS: timeUS, Open: bar.Open, High: bar.High, Low: bar.Low, Close: bar.Close,
		Volume: volume, DollarVolume: vwap * volume,
	}
	w.feed.mu.Lock()
	if request := w.feed.barRequests[reqID]; request != nil {
		request.bars = append(request.bars, item)
	}
	w.feed.mu.Unlock()
}

func (w *ibWrapper) HistoricalDataEnd(reqID int64, startDateStr string, endDateStr string) {
	w.feed.finishBarRequest(reqID)
}

func (f *IBKR) finishBarRequest(reqID int64) bool {
	f.mu.Lock()
	request := f.barRequests[reqID]
	if request != nil {
		delete(f.barRequests, reqID)
		delete(f.reqSymbols, reqID)
	}
	f.mu.Unlock()
	if request == nil {
		return false
	}
	request.result <- ibkrBarResult{bars: request.bars}
	return true
}

func (f *IBKR) failBarRequest(reqID int64, err error) bool {
	f.mu.Lock()
	request := f.barRequests[reqID]
	if request != nil {
		delete(f.barRequests, reqID)
		delete(f.reqSymbols, reqID)
	}
	f.mu.Unlock()
	if request == nil {
		return false
	}
	request.result <- ibkrBarResult{err: err}
	return true
}

func ibkrBarTimeUS(value string) (int64, error) {
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("IBKR bar timestamp %q is not epoch seconds", value)
	}
	return seconds * int64(time.Second/time.Microsecond), nil
}

func latestCompletedBars(bars []storage.MinuteBar, endExclusive time.Time, limit int) []storage.MinuteBar {
	endUS := endExclusive.UnixMicro()
	completed := make([]storage.MinuteBar, 0, min(len(bars), limit))
	for _, bar := range bars {
		if bar.TimeUS > 0 && bar.TimeUS < endUS && bar.Close > 0 && bar.Volume >= 0 {
			completed = append(completed, bar)
		}
	}
	sort.Slice(completed, func(i, j int) bool { return completed[i].TimeUS < completed[j].TimeUS })
	if len(completed) > limit {
		completed = completed[len(completed)-limit:]
	}
	return completed
}
