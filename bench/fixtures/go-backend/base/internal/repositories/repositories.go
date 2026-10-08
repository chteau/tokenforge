// Package repositories defines persistence interfaces and their in-memory
// and file-backed implementations. Services depend on the interfaces only;
// concrete implementations are chosen in internal/app.
//
// Conventions:
//   - Get-style methods return ErrNotFound when nothing matches.
//   - Values are returned by copy; callers never hold pointers into storage.
//   - Read-modify-write goes through Update, which applies fn atomically
//     under the repository lock. If fn returns an error nothing is stored.
package repositories

import (
	"context"
	"errors"

	"github.com/acme/meridian/internal/audit"
	"github.com/acme/meridian/internal/billing"
	"github.com/acme/meridian/internal/flags"
	"github.com/acme/meridian/internal/users"
)

var (
	// ErrNotFound is returned when a record does not exist.
	ErrNotFound = errors.New("repositories: not found")
	// ErrDuplicate is returned when a uniqueness constraint is violated.
	ErrDuplicate = errors.New("repositories: duplicate")
)

// UserRepository stores user accounts. E-mail addresses are unique.
type UserRepository interface {
	Create(ctx context.Context, u users.User) error
	Get(ctx context.Context, id string) (users.User, error)
	GetByEmail(ctx context.Context, email string) (users.User, error)
	Update(ctx context.Context, id string, fn func(*users.User) error) (users.User, error)
	List(ctx context.Context) ([]users.User, error)
}

// PlanRepository stores subscription plans. Plan codes are unique.
type PlanRepository interface {
	Create(ctx context.Context, p billing.Plan) error
	Get(ctx context.Context, id string) (billing.Plan, error)
	GetByCode(ctx context.Context, code string) (billing.Plan, error)
	List(ctx context.Context) ([]billing.Plan, error)
}

// SubscriptionRepository stores customer subscriptions.
type SubscriptionRepository interface {
	Create(ctx context.Context, s billing.Subscription) error
	Get(ctx context.Context, id string) (billing.Subscription, error)
	Update(ctx context.Context, id string, fn func(*billing.Subscription) error) (billing.Subscription, error)
	ListByCustomer(ctx context.Context, customerID string) ([]billing.Subscription, error)
}

// InvoiceFilter narrows invoice listings. Empty fields match everything.
type InvoiceFilter struct {
	CustomerID string
	Status     billing.InvoiceStatus
}

// InvoiceRepository stores invoices.
type InvoiceRepository interface {
	Create(ctx context.Context, inv billing.Invoice) error
	Get(ctx context.Context, id string) (billing.Invoice, error)
	Update(ctx context.Context, id string, fn func(*billing.Invoice) error) (billing.Invoice, error)
	List(ctx context.Context, f InvoiceFilter) ([]billing.Invoice, error)
	// NextNumber returns the next human-readable invoice number (INV-000001, ...).
	NextNumber(ctx context.Context) (string, error)
}

// PaymentRepository stores payments received against invoices.
type PaymentRepository interface {
	Create(ctx context.Context, p billing.Payment) error
	ListByInvoice(ctx context.Context, invoiceID string) ([]billing.Payment, error)
}

// AuditRepository is the append-only audit trail.
type AuditRepository interface {
	Append(ctx context.Context, e audit.Event) error
	List(ctx context.Context, f audit.Filter) ([]audit.Event, error)
}

// FlagRepository stores feature flags.
type FlagRepository interface {
	Get(ctx context.Context, key string) (flags.Flag, error)
	Put(ctx context.Context, f flags.Flag) error
	List(ctx context.Context) ([]flags.Flag, error)
}
