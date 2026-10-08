package handlers

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/acme/meridian/internal/apperr"
)

func TestFailMapsErrorKinds(t *testing.T) {
	rs := responder{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	tests := []struct {
		err      error
		status   int
		code     string
		mustHide string
	}{
		{apperr.Invalid("validation_failed", "bad", map[string]string{"x": "y"}), 422, "validation_failed", ""},
		{apperr.Unauthorized("invalid_credentials", "no"), 401, "invalid_credentials", ""},
		{apperr.Forbidden("insufficient_role", "no"), 403, "insufficient_role", ""},
		{apperr.NotFound("invoice_not_found", "no"), 404, "invoice_not_found", ""},
		{apperr.Conflict("invoice_not_open", "no"), 409, "invoice_not_open", ""},
		{errors.New("pq: connection refused to 10.0.0.5"), 500, "internal_error", "10.0.0.5"},
	}
	for _, tt := range tests {
		t.Run(tt.code, func(t *testing.T) {
			rec := httptest.NewRecorder()
			rs.fail(rec, httptest.NewRequest(http.MethodGet, "/", nil), tt.err)
			if rec.Code != tt.status {
				t.Fatalf("status = %d, want %d", rec.Code, tt.status)
			}
			if !strings.Contains(rec.Body.String(), `"code":"`+tt.code+`"`) {
				t.Fatalf("body = %s", rec.Body)
			}
			if tt.mustHide != "" && strings.Contains(rec.Body.String(), tt.mustHide) {
				t.Fatalf("internal detail leaked: %s", rec.Body)
			}
		})
	}
}
