// Package validation collects field-level validation errors for service inputs.
package validation

import (
	"net/mail"
	"strings"
	"unicode/utf8"

	"github.com/acme/meridian/internal/apperr"
)

// Validator accumulates the first error per field.
type Validator struct {
	fields map[string]string
}

// New returns an empty validator.
func New() *Validator { return &Validator{fields: map[string]string{}} }

// Add records msg for field unless the field already has an error.
func (v *Validator) Add(field, msg string) {
	if _, exists := v.fields[field]; !exists {
		v.fields[field] = msg
	}
}

// Check records msg for field when ok is false.
func (v *Validator) Check(ok bool, field, msg string) {
	if !ok {
		v.Add(field, msg)
	}
}

// Required checks that s is not blank.
func (v *Validator) Required(field, s string) {
	v.Check(strings.TrimSpace(s) != "", field, "is required")
}

// MaxLen checks that s has at most n characters.
func (v *Validator) MaxLen(field, s string, n int) {
	v.Check(utf8.RuneCountInString(s) <= n, field, "is too long")
}

// MinLen checks that s has at least n characters.
func (v *Validator) MinLen(field, s string, n int) {
	v.Check(utf8.RuneCountInString(s) >= n, field, "is too short")
}

// Email checks that s is a bare e-mail address.
func (v *Validator) Email(field, s string) {
	addr, err := mail.ParseAddress(s)
	v.Check(err == nil && addr.Address == s && addr.Name == "", field, "must be a valid email address")
}

// Positive checks that n > 0.
func (v *Validator) Positive(field string, n int64) {
	v.Check(n > 0, field, "must be greater than zero")
}

// Between checks lo <= n <= hi.
func (v *Validator) Between(field string, n, lo, hi int64) {
	v.Check(n >= lo && n <= hi, field, "is out of range")
}

// OneOf checks that s is one of allowed.
func (v *Validator) OneOf(field, s string, allowed ...string) {
	for _, a := range allowed {
		if s == a {
			return
		}
	}
	v.Add(field, "must be one of "+strings.Join(allowed, ", "))
}

// Phone checks an E.164 phone number such as +14155550123. Empty is allowed.
func (v *Validator) Phone(field, s string) {
	if s == "" {
		return
	}
	ok := len(s) >= 8 && len(s) <= 16 && s[0] == '+'
	for _, r := range s[1:] {
		if r < '0' || r > '9' {
			ok = false
		}
	}
	v.Check(ok, field, "must be an E.164 phone number")
}

// Currency checks an upper-case ISO 4217 code that the platform supports.
func (v *Validator) Currency(field, s string) {
	v.OneOf(field, s, SupportedCurrencies...)
}

// SupportedCurrencies lists the currencies invoices can be raised in.
var SupportedCurrencies = []string{"EUR", "USD", "GBP"}

// Valid reports whether no errors were recorded.
func (v *Validator) Valid() bool { return len(v.fields) == 0 }

// Err returns an apperr validation error, or nil when valid.
func (v *Validator) Err() error {
	if v.Valid() {
		return nil
	}
	return apperr.Invalid("validation_failed", "one or more fields are invalid", v.fields)
}
