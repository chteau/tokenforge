// Package app wires repositories, services and the HTTP router together.
// It is the only place that chooses concrete implementations.
package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/handlers"
	"github.com/acme/meridian/internal/middleware"
	"github.com/acme/meridian/internal/notifications"
	"github.com/acme/meridian/internal/repositories"
	"github.com/acme/meridian/internal/services"
)

// Config configures an App. Zero values select sensible defaults, except
// TokenSecret, which is required.
type Config struct {
	TokenSecret []byte
	TokenTTL    time.Duration // default 12h

	// Clock defaults to the wall clock.
	Clock clock.Clock
	// Logger defaults to discarding output.
	Logger *slog.Logger

	// Email and SMS default to logging senders.
	Email notifications.EmailSender
	SMS   notifications.SMSSender

	// FlagsFile persists feature flags as JSON. Empty keeps them in memory.
	FlagsFile string

	// RateLimitPerMinute per client IP; 0 disables rate limiting.
	RateLimitPerMinute int
	RateLimitBurst     int
	TrustProxy         bool

	// BootstrapAdminEmail/Password create an admin account on start-up if it
	// does not exist yet.
	BootstrapAdminEmail    string
	BootstrapAdminPassword string
}

// Repositories groups the storage implementations.
type Repositories struct {
	Users         repositories.UserRepository
	Plans         repositories.PlanRepository
	Subscriptions repositories.SubscriptionRepository
	Invoices      repositories.InvoiceRepository
	Payments      repositories.PaymentRepository
	Audit         repositories.AuditRepository
	Flags         repositories.FlagRepository
}

// App is a fully wired application.
type App struct {
	Handler http.Handler
	Clock   clock.Clock
	Logger  *slog.Logger
	Issuer  *auth.Issuer
	Repos   Repositories

	Users   *services.UserService
	Auth    *services.AuthService
	Billing *services.BillingService
	Plans   *services.PlanService
	Audit   *services.AuditService
	Flags   *services.FlagService

	limiter *middleware.RateLimiter
}

// New builds an App from cfg.
func New(cfg Config) (*App, error) {
	if cfg.Clock == nil {
		cfg.Clock = clock.Real{}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.TokenTTL == 0 {
		cfg.TokenTTL = 12 * time.Hour
	}
	if cfg.Email == nil {
		cfg.Email = notifications.LogSender{Logger: cfg.Logger}
	}
	if cfg.SMS == nil {
		cfg.SMS = notifications.LogSender{Logger: cfg.Logger}
	}

	issuer, err := auth.NewIssuer(cfg.TokenSecret, cfg.Clock, cfg.TokenTTL)
	if err != nil {
		return nil, err
	}
	templates, err := notifications.NewTemplates()
	if err != nil {
		return nil, err
	}

	repos := Repositories{
		Users:         repositories.NewMemoryUsers(),
		Plans:         repositories.NewMemoryPlans(),
		Subscriptions: repositories.NewMemorySubscriptions(),
		Invoices:      repositories.NewMemoryInvoices(),
		Payments:      repositories.NewMemoryPayments(),
		Audit:         repositories.NewMemoryAudit(),
		Flags:         repositories.NewMemoryFlags(),
	}
	if cfg.FlagsFile != "" {
		ff, err := repositories.OpenFileFlags(cfg.FlagsFile)
		if err != nil {
			return nil, err
		}
		repos.Flags = ff
	}

	a := &App{Clock: cfg.Clock, Logger: cfg.Logger, Issuer: issuer, Repos: repos}
	notifier := services.NewNotifier(repos.Users, cfg.Email, cfg.SMS, templates, cfg.Logger)
	a.Audit = services.NewAuditService(repos.Audit, cfg.Clock)
	a.Users = services.NewUserService(repos.Users, a.Audit, notifier, cfg.Clock)
	a.Auth = services.NewAuthService(a.Users, issuer, a.Audit)
	a.Billing = services.NewBillingService(repos.Invoices, repos.Payments, repos.Users, a.Audit, notifier, cfg.Clock)
	a.Plans = services.NewPlanService(repos.Plans, repos.Subscriptions, a.Billing, a.Audit, cfg.Clock)
	a.Flags = services.NewFlagService(repos.Flags, a.Audit, cfg.Clock)

	if cfg.RateLimitPerMinute > 0 {
		burst := cfg.RateLimitBurst
		if burst <= 0 {
			burst = cfg.RateLimitPerMinute
		}
		a.limiter = middleware.NewRateLimiter(cfg.Clock, cfg.RateLimitPerMinute, burst)
	}

	if cfg.BootstrapAdminEmail != "" {
		if _, err := a.Users.EnsureAdmin(context.Background(), cfg.BootstrapAdminEmail, cfg.BootstrapAdminPassword); err != nil {
			return nil, fmt.Errorf("bootstrap admin: %w", err)
		}
	}

	a.Handler = handlers.NewRouter(handlers.Deps{
		Users:      a.Users,
		Auth:       a.Auth,
		Billing:    a.Billing,
		Plans:      a.Plans,
		Audit:      a.Audit,
		Flags:      a.Flags,
		Issuer:     issuer,
		Clock:      cfg.Clock,
		Logger:     cfg.Logger,
		Limiter:    a.limiter,
		TrustProxy: cfg.TrustProxy,
	})
	return a, nil
}

// RunBackground starts periodic maintenance jobs until ctx is canceled.
func (a *App) RunBackground(ctx context.Context) {
	if a.limiter == nil {
		return
	}
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				a.limiter.Sweep()
			}
		}
	}()
}

// ErrMissingSecret is returned by ConfigFromEnv when no token secret is set.
var ErrMissingSecret = errors.New("TOKEN_SECRET must be set (at least 32 bytes)")
