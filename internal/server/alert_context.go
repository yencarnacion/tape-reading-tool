package server

import (
	"fmt"
	"tape-reading-tool/internal/tape"
)

// AlertContext is a bounded, immutable snapshot from the originating scanner.
// It is never recomputed as a single-symbol Tape continuation score.
type AlertContext struct {
	Symbol             string `json:"symbol"`
	Direction          int    `json:"direction"`
	AsOfUS             int64  `json:"as_of_us"`
	Clock              string `json:"clock"`
	Industry           string `json:"industry,omitempty"`
	Continuation       *int   `json:"continuation,omitempty"`
	Reversion          *int   `json:"reversion,omitempty"`
	ReversionDirection int    `json:"reversion_direction,omitempty"`
	Incomplete         bool   `json:"incomplete,omitempty"`
}

func validateAlertContext(a *AlertContext, symbol string, throughUS int64) error {
	if a == nil {
		return nil
	}
	if tape.NormalizeSymbol(a.Symbol) != symbol || a.Symbol != symbol || (a.Direction != 1 && a.Direction != -1) ||
		a.AsOfUS <= 0 || a.AsOfUS > throughUS || len(a.Clock) > 16 || len(a.Industry) > 160 ||
		a.ReversionDirection < -1 || a.ReversionDirection > 1 {
		return fmt.Errorf("invalid alert snapshot identity or timestamp")
	}
	for _, score := range []*int{a.Continuation, a.Reversion} {
		if score != nil && (*score < 0 || *score > 100) {
			return fmt.Errorf("alert snapshot scores must be between 0 and 100")
		}
	}
	return nil
}

func (s *Server) setAlertContext(a *AlertContext) {
	s.alertMu.Lock()
	s.alertContext = a
	s.alertMu.Unlock()
}

func (s *Server) currentAlertContext(symbol string) *AlertContext {
	s.alertMu.RLock()
	defer s.alertMu.RUnlock()
	if s.alertContext == nil || s.alertContext.Symbol != symbol {
		return nil
	}
	return s.alertContext
}
