package apperr

import (
	"errors"
	"fmt"
	"testing"
)

func TestKindOf(t *testing.T) {
	tests := []struct {
		err  error
		want Kind
	}{
		{NotFound("x", "y"), KindNotFound},
		{fmt.Errorf("wrapped: %w", Forbidden("x", "y")), KindForbidden},
		{Conflict("x", "y"), KindConflict},
		{Invalid("x", "y", nil), KindInvalid},
		{Unauthorized("x", "y"), KindUnauthorized},
		{errors.New("boom"), KindInternal},
	}
	for _, tt := range tests {
		if got := KindOf(tt.err); got != tt.want {
			t.Errorf("KindOf(%v) = %v, want %v", tt.err, got, tt.want)
		}
	}
}
