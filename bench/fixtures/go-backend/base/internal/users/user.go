// Package users defines the user account model.
package users

import (
	"strings"
	"time"

	"github.com/acme/meridian/internal/auth"
)

// User is a customer or staff account.
type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	Name         string    `json:"name"`
	Phone        string    `json:"phone,omitempty"`
	Role         auth.Role `json:"role"`
	Disabled     bool      `json:"disabled"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// NormalizeEmail lower-cases and trims an e-mail address so that lookups are
// case-insensitive.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// DisplayName returns the name, falling back to the local part of the e-mail.
func (u User) DisplayName() string {
	if u.Name != "" {
		return u.Name
	}
	local, _, _ := strings.Cut(u.Email, "@")
	return local
}
