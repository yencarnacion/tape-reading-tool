package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/tape"
)

func TestGatewayLastPriceReachesBrowserWithoutAnotherPrint(t *testing.T) {
	now := time.Now().Add(-time.Second)
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/stream") {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: hello\ndata: {\"api_version\":1,\"source\":\"massive\",\"feed\":\"realtime\"}\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ticker":{"prevDay":{"c":441.64},"lastTrade":{"p":429.5,"s":0,"ds":"0.25","c":[12,37],"t":%d}}}`, now.UnixNano())
	}))
	defer adapter.Close()
	cfg := config.Defaults()
	cfg.Massive.GatewayURL = adapter.URL + "/adapter"
	store := tape.NewStore("TEST", 100, 2)
	gateway := feed.NewGateway(cfg.Massive, store, nil)
	server := New(cfg, store, gateway)
	host := httptest.NewServer(http.HandlerFunc(server.handleWebSocket))
	defer host.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(host.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); gateway.Run(ctx) }()
	defer func() { cancel(); <-done }()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("LAST needed a subsequent print: %v", err)
		}
		var message streamMessage
		if err = json.Unmarshal(raw, &message); err != nil {
			t.Fatal(err)
		}
		quote := message.Quote
		if message.Snapshot != nil {
			quote = &message.Snapshot.Quote
		}
		if quote == nil || quote.LastPrice == 0 {
			continue
		}
		if message.Symbol != "TEST" || quote.LastPrice != 429.5 || quote.PreviousClose != 441.64 || quote.LastTimeMS != now.UnixMilli() {
			t.Fatalf("wrong reference delivered to browser: %s", raw)
		}
		if len(message.Trades) != 0 || len(store.Snapshot("TEST", 0).Trades) != 0 {
			t.Fatalf("snapshot was replayed as tape/audio: %s", raw)
		}
		break
	}
}
