// Package middleware contains the HTTP middleware used by the router.
package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/pkg/httpx"
)

// Middleware wraps a handler.
type Middleware func(http.Handler) http.Handler

// Chain applies mws so that the first one is the outermost.
func Chain(h http.Handler, mws ...Middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

type requestIDKey struct{}

// RequestIDFrom returns the request ID stored by RequestID.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// RequestID propagates a valid incoming X-Request-ID or generates a new one,
// and echoes it in the response.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !validRequestID(id) {
			var b [8]byte
			_, _ = rand.Read(b[:])
			id = hex.EncodeToString(b[:])
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

func validRequestID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !(c == '-' || c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return false
		}
	}
	return true
}

// Logging logs one line per request.
func Logging(logger *slog.Logger, clk clock.Clock) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := clk.Now()
			rec := httpx.NewStatusRecorder(w)
			next.ServeHTTP(rec, r)
			logger.InfoContext(r.Context(), "http request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.Status,
				"bytes", rec.Bytes,
				"duration", clk.Now().Sub(start).Round(time.Microsecond),
				"request_id", RequestIDFrom(r.Context()),
			)
		})
	}
}

// Recover turns panics into 500 responses.
func Recover(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if v := recover(); v != nil {
					if v == http.ErrAbortHandler {
						panic(v)
					}
					logger.ErrorContext(r.Context(), "panic", "value", v, "stack", string(debug.Stack()))
					httpx.WriteError(w, http.StatusInternalServerError, httpx.ErrorDetail{Code: "internal_error", Message: "internal server error"})
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
