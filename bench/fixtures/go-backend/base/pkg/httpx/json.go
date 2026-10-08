// Package httpx contains small HTTP helpers shared by handlers and middleware.
package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// DefaultMaxBodyBytes bounds request bodies decoded with DecodeJSON.
const DefaultMaxBodyBytes = 1 << 20

// ErrorBody is the envelope used for every error response.
type ErrorBody struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail describes a single API error.
type ErrorDetail struct {
	Code      string            `json:"code"`
	Message   string            `json:"message"`
	Fields    map[string]string `json:"fields,omitempty"`
	RequestID string            `json:"request_id,omitempty"`
}

// WriteJSON writes v as a JSON response with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// WriteError writes an error envelope.
func WriteError(w http.ResponseWriter, status int, detail ErrorDetail) {
	if detail.RequestID == "" {
		detail.RequestID = w.Header().Get("X-Request-ID")
	}
	WriteJSON(w, status, ErrorBody{Error: detail})
}

// DecodeError is returned by DecodeJSON when the body cannot be decoded.
type DecodeError struct {
	Status int
	Msg    string
}

func (e *DecodeError) Error() string { return e.Msg }

// DecodeJSON decodes a single JSON object from the request body into dst.
// Unknown fields are rejected so that typos in client payloads surface early.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	if ct := r.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "application/json") {
		return &DecodeError{Status: http.StatusUnsupportedMediaType, Msg: "content type must be application/json"}
	}
	r.Body = http.MaxBytesReader(w, r.Body, DefaultMaxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var syntaxErr *json.SyntaxError
		var typeErr *json.UnmarshalTypeError
		var maxErr *http.MaxBytesError
		switch {
		case errors.Is(err, io.EOF):
			return &DecodeError{Status: http.StatusBadRequest, Msg: "request body must not be empty"}
		case errors.As(err, &syntaxErr), errors.Is(err, io.ErrUnexpectedEOF):
			return &DecodeError{Status: http.StatusBadRequest, Msg: "request body contains malformed JSON"}
		case errors.As(err, &typeErr):
			return &DecodeError{Status: http.StatusBadRequest, Msg: fmt.Sprintf("field %q has the wrong type", typeErr.Field)}
		case strings.HasPrefix(err.Error(), "json: unknown field "):
			return &DecodeError{Status: http.StatusBadRequest, Msg: "request body contains unknown field " + strings.TrimPrefix(err.Error(), "json: unknown field ")}
		case errors.As(err, &maxErr):
			return &DecodeError{Status: http.StatusRequestEntityTooLarge, Msg: "request body is too large"}
		default:
			return &DecodeError{Status: http.StatusBadRequest, Msg: "request body could not be decoded"}
		}
	}
	if dec.More() {
		return &DecodeError{Status: http.StatusBadRequest, Msg: "request body must contain a single JSON object"}
	}
	return nil
}
