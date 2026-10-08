package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/acme/meridian/internal/clock"
)

var (
	// ErrInvalidToken is returned for malformed or tampered tokens.
	ErrInvalidToken = errors.New("auth: invalid token")
	// ErrExpiredToken is returned for tokens past their expiry.
	ErrExpiredToken = errors.New("auth: token expired")
)

// Claims is the signed token payload.
type Claims struct {
	Subject   string `json:"sub"`
	Role      Role   `json:"role"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// Issuer signs and verifies bearer tokens of the form
// base64url(claims) "." base64url(HMAC-SHA256(claims)).
type Issuer struct {
	secret []byte
	clock  clock.Clock
	ttl    time.Duration
}

// MinSecretLen is the minimum accepted signing key length in bytes.
const MinSecretLen = 32

// NewIssuer returns an issuer. ttl is the lifetime of issued tokens.
func NewIssuer(secret []byte, clk clock.Clock, ttl time.Duration) (*Issuer, error) {
	if len(secret) < MinSecretLen {
		return nil, errors.New("auth: token secret must be at least 32 bytes")
	}
	if ttl <= 0 {
		return nil, errors.New("auth: token ttl must be positive")
	}
	return &Issuer{secret: append([]byte(nil), secret...), clock: clk, ttl: ttl}, nil
}

// TTL returns the lifetime of issued tokens.
func (i *Issuer) TTL() time.Duration { return i.ttl }

// Issue returns a signed token for the subject and its expiry time.
func (i *Issuer) Issue(subject string, role Role) (string, time.Time, error) {
	if subject == "" || !role.Valid() {
		return "", time.Time{}, errors.New("auth: subject and a valid role are required")
	}
	now := i.clock.Now()
	exp := now.Add(i.ttl)
	payload, err := json.Marshal(Claims{Subject: subject, Role: role, IssuedAt: now.Unix(), ExpiresAt: exp.Unix()})
	if err != nil {
		return "", time.Time{}, err
	}
	body := base64.RawURLEncoding.EncodeToString(payload)
	return body + "." + i.sign(body), exp, nil
}

// Verify checks the signature and expiry of token and returns its claims.
func (i *Issuer) Verify(token string) (Claims, error) {
	body, sig, ok := strings.Cut(token, ".")
	if !ok || body == "" || sig == "" {
		return Claims{}, ErrInvalidToken
	}
	if !hmac.Equal([]byte(sig), []byte(i.sign(body))) {
		return Claims{}, ErrInvalidToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var c Claims
	if err := json.Unmarshal(raw, &c); err != nil || c.Subject == "" || !c.Role.Valid() {
		return Claims{}, ErrInvalidToken
	}
	if c.ExpiresAt == 0 || i.clock.Now().Unix() >= c.ExpiresAt {
		return Claims{}, ErrExpiredToken
	}
	return c, nil
}

func (i *Issuer) sign(body string) string {
	mac := hmac.New(sha256.New, i.secret)
	mac.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
