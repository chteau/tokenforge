package httpx

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeJSON(t *testing.T) {
	type payload struct {
		Name string `json:"name"`
		Age  int    `json:"age"`
	}
	tests := []struct {
		name       string
		body       string
		ctype      string
		wantStatus int
	}{
		{name: "ok", body: `{"name":"a","age":3}`, ctype: "application/json"},
		{name: "no content type is accepted", body: `{"name":"a"}`},
		{name: "empty", body: ``, wantStatus: http.StatusBadRequest},
		{name: "malformed", body: `{"name":`, wantStatus: http.StatusBadRequest},
		{name: "wrong type", body: `{"age":"x"}`, wantStatus: http.StatusBadRequest},
		{name: "unknown field", body: `{"nope":1}`, wantStatus: http.StatusBadRequest},
		{name: "two objects", body: `{"name":"a"}{"name":"b"}`, wantStatus: http.StatusBadRequest},
		{name: "wrong content type", body: `{}`, ctype: "text/plain", wantStatus: http.StatusUnsupportedMediaType},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tt.body))
			if tt.ctype != "" {
				r.Header.Set("Content-Type", tt.ctype)
			}
			var p payload
			err := DecodeJSON(httptest.NewRecorder(), r, &p)
			if tt.wantStatus == 0 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			de, ok := err.(*DecodeError)
			if !ok {
				t.Fatalf("want *DecodeError, got %T (%v)", err, err)
			}
			if de.Status != tt.wantStatus {
				t.Fatalf("status = %d, want %d", de.Status, tt.wantStatus)
			}
		})
	}
}

func TestWriteErrorIncludesRequestID(t *testing.T) {
	rec := httptest.NewRecorder()
	rec.Header().Set("X-Request-ID", "req-1")
	WriteError(rec, http.StatusNotFound, ErrorDetail{Code: "not_found", Message: "missing"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"request_id":"req-1"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	if got := ClientIP(r, false); got != "10.0.0.1" {
		t.Fatalf("untrusted = %q", got)
	}
	if got := ClientIP(r, true); got != "203.0.113.9" {
		t.Fatalf("trusted = %q", got)
	}
}
