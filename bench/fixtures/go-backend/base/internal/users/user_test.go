package users

import "testing"

func TestNormalizeEmail(t *testing.T) {
	if got := NormalizeEmail("  Ada@Example.COM "); got != "ada@example.com" {
		t.Fatalf("got %q", got)
	}
}

func TestDisplayName(t *testing.T) {
	tests := []struct {
		u    User
		want string
	}{
		{User{Name: "Ada Lovelace", Email: "ada@example.com"}, "Ada Lovelace"},
		{User{Email: "grace@example.com"}, "grace"},
	}
	for _, tt := range tests {
		if got := tt.u.DisplayName(); got != tt.want {
			t.Errorf("DisplayName() = %q, want %q", got, tt.want)
		}
	}
}
