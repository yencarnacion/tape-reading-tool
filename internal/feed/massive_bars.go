package feed

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"

	"github.com/massive-com/client-go/v3/rest"
	"github.com/massive-com/client-go/v3/rest/gen"

	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/storage"
	"tape-reading-tool/internal/tape"
)

// DownloadMassiveMinuteBars is deliberately an explicit CLI operation. It
// requests unadjusted aggregates so cached chart context matches raw prints.
func DownloadMassiveMinuteBars(ctx context.Context, cfg config.MassiveConfig, database *storage.Database, options HistoricalOptions) error {
	if cfg.APIKey == "" {
		return fmt.Errorf("MASSIVE_API_KEY is required in .env")
	}
	symbol := tape.NormalizeSymbol(options.Symbol)
	if symbol == "" || !options.End.After(options.Start) {
		return fmt.Errorf("valid symbol, start, and end are required")
	}
	// Bars are the extended-hours chart context that detailed prints do not
	// cover, so a regular-hours restriction would defeat the purpose rather than
	// narrow it.
	if options.UseRTH {
		return fmt.Errorf("download-bars always covers extended hours; remove -rth")
	}
	client := rest.NewWithOptions(cfg.APIKey, rest.WithTrace(false), rest.WithPagination(true))
	var response *gen.GetStocksAggregatesResponse
	var err error
	for attempt := 1; attempt <= massiveHistoricalMaxRetries+1; attempt++ {
		adjusted := false
		limit := 50000
		response, err = client.GetStocksAggregatesWithResponse(ctx, symbol, 1, gen.Minute,
			strconv.FormatInt(options.Start.UnixMilli(), 10), strconv.FormatInt(options.End.UnixMilli(), 10),
			&gen.GetStocksAggregatesParams{Adjusted: &adjusted, Sort: "asc", Limit: &limit})
		if err == nil {
			err = rest.CheckResponse(response)
		}
		if err == nil {
			break
		}
		if attempt > massiveHistoricalMaxRetries {
			return fmt.Errorf("Massive minute bars failed after %d retries: %w", massiveHistoricalMaxRetries, err)
		}
		if !sleepContext(ctx, massiveHistoricalRetryDelay(attempt)) {
			return ctx.Err()
		}
	}
	if response.JSON200 == nil {
		return fmt.Errorf("Massive minute bars returned no result")
	}
	if response.JSON200.NextUrl != nil && strings.TrimSpace(*response.JSON200.NextUrl) != "" {
		return fmt.Errorf("Massive minute-bar range exceeds one complete response; split it into smaller explicit ranges")
	}
	bars := make([]storage.MinuteBar, 0, response.JSON200.ResultsCount)
	if response.JSON200.Results != nil {
		for _, item := range *response.JSON200.Results {
			minuteUS := int64(item.Timestamp) * 1000
			if minuteUS < options.Start.UnixMicro() || minuteUS > options.End.UnixMicro() {
				continue
			}
			dollar := 0.0
			if item.Vw != nil {
				dollar = *item.Vw * item.V
			}
			bars = append(bars, storage.MinuteBar{TimeUS: minuteUS, Open: item.O, High: item.H, Low: item.L, Close: item.C, Volume: item.V, DollarVolume: dollar})
		}
	}
	if err := database.UpsertMinuteBars(ctx, symbol, "massive", bars); err != nil {
		return err
	}
	if err := database.MarkCoverage(ctx, storage.Coverage{Symbol: symbol, Provider: "massive", Kind: "minute_bars", StartUS: options.Start.UnixMicro(), EndUS: options.End.UnixMicro(), RowCount: int64(len(bars))}); err != nil {
		return err
	}
	log.Printf("Massive minute bars complete symbol=%s bars=%d database=%s", symbol, len(bars), database.Path())
	return nil
}
