package handlers

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/acme/meridian/internal/apperr"
	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/pkg/httpx"
	"github.com/acme/meridian/pkg/pagination"
)

// responder holds what every handler needs to write responses. Handler
// structs embed it.
type responder struct {
	logger *slog.Logger
}

// statusFor maps service error kinds to HTTP status codes.
var statusFor = map[apperr.Kind]int{
	apperr.KindInvalid:      http.StatusUnprocessableEntity,
	apperr.KindUnauthorized: http.StatusUnauthorized,
	apperr.KindForbidden:    http.StatusForbidden,
	apperr.KindNotFound:     http.StatusNotFound,
	apperr.KindConflict:     http.StatusConflict,
}

// fail writes the response for an error returned by a service. Classified
// errors are passed through; anything else is logged and reported as a
// generic 500 so internal details never reach clients.
func (rs responder) fail(w http.ResponseWriter, r *http.Request, err error) {
	if e, ok := apperr.As(err); ok {
		if status, mapped := statusFor[e.Kind]; mapped {
			httpx.WriteError(w, status, httpx.ErrorDetail{Code: e.Code, Message: e.Message, Fields: e.Fields})
			return
		}
	}
	rs.logger.ErrorContext(r.Context(), "request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	httpx.WriteError(w, http.StatusInternalServerError, httpx.ErrorDetail{Code: "internal_error", Message: "internal server error"})
}

// decode reads a JSON body into dst, writing a 4xx response and returning
// false if it cannot.
func (rs responder) decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := httpx.DecodeJSON(w, r, dst); err != nil {
		var de *httpx.DecodeError
		if errors.As(err, &de) {
			httpx.WriteError(w, de.Status, httpx.ErrorDetail{Code: "invalid_body", Message: de.Msg})
			return false
		}
		rs.fail(w, r, err)
		return false
	}
	return true
}

// page parses pagination parameters, writing a 400 response on failure.
func (rs responder) page(w http.ResponseWriter, r *http.Request) (pagination.Params, bool) {
	p, err := pagination.FromQuery(r.URL.Query())
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, httpx.ErrorDetail{Code: "invalid_pagination", Message: err.Error()})
		return pagination.Params{}, false
	}
	return p, true
}

// principal returns the caller set by middleware.Authenticate. It must only
// be used on routes wrapped with that middleware.
func principal(r *http.Request) auth.Principal {
	p, _ := auth.PrincipalFrom(r.Context())
	return p
}
