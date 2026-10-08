package validation

import (
	"testing"

	"github.com/acme/meridian/internal/apperr"
)

func TestValidator(t *testing.T) {
	tests := []struct {
		name      string
		run       func(v *Validator)
		wantField string
	}{
		{"required blank", func(v *Validator) { v.Required("name", "  ") }, "name"},
		{"required ok", func(v *Validator) { v.Required("name", "x") }, ""},
		{"email ok", func(v *Validator) { v.Email("email", "a@example.com") }, ""},
		{"email with name", func(v *Validator) { v.Email("email", "A <a@example.com>") }, "email"},
		{"email garbage", func(v *Validator) { v.Email("email", "nope") }, "email"},
		{"maxlen", func(v *Validator) { v.MaxLen("s", "héllo", 4) }, "s"},
		{"maxlen counts runes", func(v *Validator) { v.MaxLen("s", "héllo", 5) }, ""},
		{"positive", func(v *Validator) { v.Positive("n", 0) }, "n"},
		{"between", func(v *Validator) { v.Between("n", 11, 0, 10) }, "n"},
		{"oneof", func(v *Validator) { v.OneOf("c", "x", "a", "b") }, "c"},
		{"phone ok", func(v *Validator) { v.Phone("p", "+14155550123") }, ""},
		{"phone empty allowed", func(v *Validator) { v.Phone("p", "") }, ""},
		{"phone letters", func(v *Validator) { v.Phone("p", "+1415abc0123") }, "p"},
		{"currency", func(v *Validator) { v.Currency("currency", "JPY") }, "currency"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := New()
			tt.run(v)
			err := v.Err()
			if tt.wantField == "" {
				if err != nil {
					t.Fatalf("unexpected error %v", err)
				}
				return
			}
			e, ok := apperr.As(err)
			if !ok || e.Kind != apperr.KindInvalid {
				t.Fatalf("want invalid apperr, got %v", err)
			}
			if _, ok := e.Fields[tt.wantField]; !ok {
				t.Fatalf("fields = %v, want %q", e.Fields, tt.wantField)
			}
		})
	}
}

func TestFirstErrorPerFieldWins(t *testing.T) {
	v := New()
	v.Required("name", "")
	v.MaxLen("name", "", 0)
	v.Add("name", "other")
	e, _ := apperr.As(v.Err())
	if e.Fields["name"] != "is required" {
		t.Fatalf("got %q", e.Fields["name"])
	}
}
