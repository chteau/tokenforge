package auth

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/acme/meridian/internal/clock"
)

var testSecret = []byte("0123456789abcdef0123456789abcdef")

func TestRoleSatisfies(t *testing.T) {
	tests := []struct {
		have, need Role
		want       bool
	}{
		{RoleUser, RoleUser, true},
		{RoleUser, RoleBillingAdmin, false},
		{RoleBillingAdmin, RoleUser, true},
		{RoleBillingAdmin, RoleAdmin, false},
		{RoleAdmin, RoleBillingAdmin, true},
		{Role("root"), RoleUser, false},
	}
	for _, tt := range tests {
		if got := tt.have.Satisfies(tt.need); got != tt.want {
			t.Errorf("%s.Satisfies(%s) = %v", tt.have, tt.need, got)
		}
	}
}

func TestPrincipalContext(t *testing.T) {
	if _, ok := PrincipalFrom(context.Background()); ok {
		t.Fatal("empty context should have no principal")
	}
	ctx := WithPrincipal(context.Background(), Principal{UserID: "usr_1", Role: RoleAdmin})
	p, ok := PrincipalFrom(ctx)
	if !ok || p.UserID != "usr_1" || !p.Is(RoleBillingAdmin) {
		t.Fatalf("got %+v %v", p, ok)
	}
}

func TestIssueVerify(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	iss, err := NewIssuer(testSecret, clk, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	tok, exp, err := iss.Issue("usr_1", RoleBillingAdmin)
	if err != nil {
		t.Fatal(err)
	}
	if !exp.Equal(clk.Now().Add(time.Hour)) {
		t.Fatalf("exp = %v", exp)
	}
	c, err := iss.Verify(tok)
	if err != nil || c.Subject != "usr_1" || c.Role != RoleBillingAdmin {
		t.Fatalf("verify = %+v, %v", c, err)
	}

	body, sig, _ := strings.Cut(tok, ".")
	tampered := body[:len(body)-2] + "xx." + sig
	if _, err := iss.Verify(tampered); err != ErrInvalidToken {
		t.Fatalf("tampered: %v", err)
	}
	if _, err := iss.Verify("garbage"); err != ErrInvalidToken {
		t.Fatalf("garbage: %v", err)
	}

	other, _ := NewIssuer([]byte("ffffffffffffffffffffffffffffffff"), clk, time.Hour)
	if _, err := other.Verify(tok); err != ErrInvalidToken {
		t.Fatalf("other key: %v", err)
	}

	clk.Advance(time.Hour)
	if _, err := iss.Verify(tok); err != ErrExpiredToken {
		t.Fatalf("expired: %v", err)
	}
}

func TestNewIssuerRejectsWeakConfig(t *testing.T) {
	if _, err := NewIssuer([]byte("short"), clock.Real{}, time.Hour); err == nil {
		t.Fatal("short secret accepted")
	}
	if _, err := NewIssuer(testSecret, clock.Real{}, 0); err == nil {
		t.Fatal("zero ttl accepted")
	}
}

func TestPassword(t *testing.T) {
	h, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword(h, "correct horse") {
		t.Fatal("correct password rejected")
	}
	if CheckPassword(h, "wrong horse") {
		t.Fatal("wrong password accepted")
	}
	if CheckPassword("plain", "plain") {
		t.Fatal("malformed hash accepted")
	}
	h2, _ := HashPassword("correct horse")
	if h == h2 {
		t.Fatal("hashes must be salted")
	}
}
