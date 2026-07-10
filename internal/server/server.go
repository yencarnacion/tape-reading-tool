package server

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"tape-reading-tool/internal/config"
	"tape-reading-tool/internal/feed"
	"tape-reading-tool/internal/tape"
)

//go:embed web/*
var webFS embed.FS

type Server struct {
	cfg      config.Config
	store    *tape.Store
	feed     feed.Feed
	upgrader websocket.Upgrader
}

type streamMessage struct {
	Type         string                `json:"type"`
	Symbol       string                `json:"symbol,omitempty"`
	Snapshot     *tape.Snapshot        `json:"snapshot,omitempty"`
	Trades       []tape.Trade          `json:"trades,omitempty"`
	Quote        *tape.Quote           `json:"quote,omitempty"`
	History      []string              `json:"history,omitempty"`
	Status       *tape.FeedStatus      `json:"status,omitempty"`
	Display      *config.DisplayConfig `json:"display,omitempty"`
	Audio        *config.AudioConfig   `json:"audio,omitempty"`
	Dropped      uint64                `json:"dropped,omitempty"`
	ServerTimeMS int64                 `json:"server_time_ms,omitempty"`
}

func New(cfg config.Config, store *tape.Store, source feed.Feed) *Server {
	return &Server{
		cfg: cfg, store: store, feed: source,
		upgrader: websocket.Upgrader{
			ReadBufferSize: 4096, WriteBufferSize: 64 * 1024,
			CheckOrigin: sameOrigin,
		},
	}
}

func (s *Server) Serve(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/ticker", s.handleTicker)
	mux.HandleFunc("/ws", s.handleWebSocket)

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		return err
	}
	assets := http.FileServer(http.FS(sub))
	mux.Handle("/", securityHeaders(assets))

	httpServer := &http.Server{
		Addr: s.cfg.App.Addr, Handler: mux,
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		err := <-errCh
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	symbol := s.store.Active()
	snapshot := s.store.Snapshot(symbol, 1)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "symbol": symbol, "status": snapshot.Status,
		"quote": snapshot.Quote, "last_trade": snapshot.Trades,
	})
}

func (s *Server) handleTicker(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	var request struct {
		Symbol string `json:"symbol"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	symbol := tape.NormalizeSymbol(request.Symbol)
	if symbol == "" {
		http.Error(w, "ticker must be 1-16 letters, digits, dot, or hyphen", http.StatusBadRequest)
		return
	}
	s.store.Activate(symbol)
	s.feed.SetSymbol(symbol)
	writeJSON(w, http.StatusOK, map[string]any{"symbol": symbol, "history": s.store.Symbols()})
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(4096)
	_ = conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	batchEvery, _ := time.ParseDuration(s.cfg.Tape.WebSocketBatch)
	batchTicker := time.NewTicker(batchEvery)
	statusTicker := time.NewTicker(time.Second)
	pingTicker := time.NewTicker(20 * time.Second)
	defer batchTicker.Stop()
	defer statusTicker.Stop()
	defer pingTicker.Stop()

	symbol := s.store.Active()
	seq, err := s.writeSnapshot(conn, symbol)
	if err != nil {
		return
	}
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case <-batchTicker.C:
			active := s.store.Active()
			if active != symbol {
				symbol = active
				seq, err = s.writeSnapshot(conn, symbol)
				if err != nil {
					return
				}
				continue
			}
			for drain := 0; drain < 8; drain++ {
				trades, quote, dropped, more := s.store.Since(symbol, seq, s.cfg.Tape.WebSocketMaxBatch)
				if len(trades) == 0 && dropped == 0 {
					break
				}
				if len(trades) > 0 {
					seq = trades[len(trades)-1].Seq
				}
				if err := writeWebSocketJSON(conn, streamMessage{
					Type: "trades", Symbol: symbol, Trades: trades, Quote: &quote, Dropped: dropped,
				}); err != nil {
					return
				}
				if !more {
					break
				}
			}
		case <-statusTicker.C:
			status := s.store.Status()
			if err := writeWebSocketJSON(conn, streamMessage{
				Type: "status", Symbol: symbol, Status: &status, History: s.store.Symbols(), ServerTimeMS: time.Now().UnixMilli(),
			}); err != nil {
				return
			}
		case <-pingTicker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (s *Server) writeSnapshot(conn *websocket.Conn, symbol string) (uint64, error) {
	snapshot := s.store.Snapshot(symbol, s.cfg.Tape.SnapshotTrades)
	message := streamMessage{
		Type: "snapshot", Symbol: symbol, Snapshot: &snapshot,
		Display: &s.cfg.Display, Audio: &s.cfg.Audio, ServerTimeMS: time.Now().UnixMilli(),
	}
	if err := writeWebSocketJSON(conn, message); err != nil {
		return 0, err
	}
	if len(snapshot.Trades) == 0 {
		return 0, nil
	}
	return snapshot.Trades[len(snapshot.Trades)-1].Seq, nil
}

func writeWebSocketJSON(conn *websocket.Conn, value any) error {
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return conn.WriteJSON(value)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	wanted := "//" + r.Host
	return strings.Contains(origin, wanted)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", fmt.Sprintf("default-src 'self'; connect-src 'self' ws://%s wss://%s; script-src 'self'; style-src 'self'; worker-src 'self' blob:", r.Host, r.Host))
		next.ServeHTTP(w, r)
	})
}
