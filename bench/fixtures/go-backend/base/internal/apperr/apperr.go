// Package apperr defines the error type returned by the service layer.
// Handlers translate an *Error into an HTTP status using its Kind; any other
// error is treated as an internal failure and never shown to clients.
package apperr

import (
	"errors"
	"fmt"
)

// Kind classifies an error for transport mapping.
type Kind int

const (
	KindInternal Kind = iota
	KindInvalid
	KindUnauthorized
	KindForbidden
	KindNotFound
	KindConflict
)

func (k Kind) String() string {
	switch k {
	case KindInvalid:
		return "invalid"
	case KindUnauthorized:
		return "unauthorized"
	case KindForbidden:
		return "forbidden"
	case KindNotFound:
		return "not_found"
	case KindConflict:
		return "conflict"
	default:
		return "internal"
	}
}

// Error is a classified, client-safe error.
type Error struct {
	Kind    Kind
	Code    string
	Message string
	Fields  map[string]string
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Invalid reports a request that failed validation (HTTP 422).
func Invalid(code, msg string, fields map[string]string) *Error {
	return &Error{Kind: KindInvalid, Code: code, Message: msg, Fields: fields}
}

// Unauthorized reports missing or bad credentials (HTTP 401).
func Unauthorized(code, msg string) *Error {
	return &Error{Kind: KindUnauthorized, Code: code, Message: msg}
}

// Forbidden reports an authenticated caller lacking permission (HTTP 403).
func Forbidden(code, msg string) *Error {
	return &Error{Kind: KindForbidden, Code: code, Message: msg}
}

// NotFound reports a resource that does not exist or is not visible to the caller (HTTP 404).
func NotFound(code, msg string) *Error {
	return &Error{Kind: KindNotFound, Code: code, Message: msg}
}

// Conflict reports a request that conflicts with the resource state (HTTP 409).
func Conflict(code, msg string) *Error {
	return &Error{Kind: KindConflict, Code: code, Message: msg}
}

// KindOf returns the Kind of err, or KindInternal if err is not an *Error.
func KindOf(err error) Kind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return KindInternal
}

// As extracts an *Error from err.
func As(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}
