package middleware

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/clock"
)

func okHandler(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }

func TestAuthenticateAndRequireRole(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	iss, _ := auth.NewIssuer([]byte("0123456789abcdef0123456789abcdef"), clk, time.Hour)
	userTok, _, _ := iss.Issue("usr_1", auth.RoleUser)
	adminTok, _, _ := iss.Issue("usr_2", auth.RoleBillingAdmin)

	h := Chain(http.HandlerFunc(okHandler), Authenticate(iss), RequireRole(auth.RoleBillingAdmin))
	tests := []struct {
		name   string
		header string
		want   int
	}{
		{"no header", "", http.StatusUnauthorized},
		{"wrong scheme", "Basic abc", http.StatusUnauthorized},
		{"garbage token", "Bearer abc.def", http.StatusUnauthorized},
		{"insufficient role", "Bearer " + userTok, http.StatusForbidden},
		{"ok", "Bearer " + adminTok, http.StatusNoContent},
		{"lowercase scheme", "bearer " + adminTok, http.StatusNoContent},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.header != "" {
				r.Header.Set("Authorization", tt.header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tt.want, rec.Body)
			}
		})
	}

	clk.Advance(2 * time.Hour)
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+adminTok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "token_expired") {
		t.Fatalf("expired: %d %s", rec.Code, rec.Body)
	}
}

func TestRateLimiter(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	l := NewRateLimiter(clk, 60, 2)
	for i := range 2 {
		if ok, _ := l.Allow("ip"); !ok {
			t.Fatalf("request %d rejected", i)
		}
	}
	ok, wait := l.Allow("ip")
	if ok || wait != time.Second {
		t.Fatalf("third request: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.Allow("other-ip"); !ok {
		t.Fatal("keys must be independent")
	}
	clk.Advance(time.Second)
	if ok, _ := l.Allow("ip"); !ok {
		t.Fatal("token not refilled")
	}
	clk.Advance(time.Hour)
	l.Sweep()
	if len(l.buckets) != 0 {
		t.Fatalf("buckets after sweep = %d", len(l.buckets))
	}
}

func TestRateLimitMiddleware(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	h := RateLimit(NewRateLimiter(clk, 60, 1), false)(http.HandlerFunc(okHandler))
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	h.ServeHTTP(httptest.NewRecorder(), r)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("status = %d retry-after = %q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestRequestIDAndRecover(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RequestIDFrom(r.Context()) == "" {
			t.Error("missing request id in context")
		}
		panic("boom")
	}), RequestID, Logging(logger, clock.Real{}), Recover(logger))

	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("X-Request-ID", "abc-123")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("X-Request-ID") != "abc-123" {
		t.Fatalf("request id = %q", rec.Header().Get("X-Request-ID"))
	}
	if !strings.Contains(buf.String(), "panic") || !strings.Contains(buf.String(), "status=500") {
		t.Fatalf("log = %s", buf.String())
	}

	r = httptest.NewRequest(http.MethodGet, "/x", nil)
	r.Header.Set("X-Request-ID", "bad id with spaces")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if got := rec.Header().Get("X-Request-ID"); got == "" || strings.Contains(got, " ") {
		t.Fatalf("invalid incoming id should be replaced, got %q", got)
	}
}
