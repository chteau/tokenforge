// Package auth implements roles, the authenticated principal, password
// hashing and HMAC-signed bearer tokens.
package auth

import "context"

// Role is a coarse permission level attached to every user.
type Role string

const (
	// RoleUser is a regular customer account.
	RoleUser Role = "user"
	// RoleBillingAdmin may manage invoices and payments for every customer.
	RoleBillingAdmin Role = "billing_admin"
	// RoleAdmin may do everything, including user and feature flag management.
	RoleAdmin Role = "admin"
)

var rank = map[Role]int{RoleUser: 1, RoleBillingAdmin: 2, RoleAdmin: 3}

// Valid reports whether r is a known role.
func (r Role) Valid() bool { _, ok := rank[r]; return ok }

// Satisfies reports whether r grants at least the permissions of required.
// Roles are hierarchical: admin > billing_admin > user.
func (r Role) Satisfies(required Role) bool {
	have, ok := rank[r]
	return ok && have >= rank[required]
}

// Principal is the authenticated caller of a request.
type Principal struct {
	UserID string
	Role   Role
}

// Is reports whether the principal has at least the given role.
func (p Principal) Is(role Role) bool { return p.Role.Satisfies(role) }

type principalKey struct{}

// WithPrincipal stores p in ctx.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFrom returns the principal stored in ctx by the auth middleware.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok && p.UserID != ""
}
