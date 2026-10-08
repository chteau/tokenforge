// Package handlers exposes the services over HTTP. Handlers stay thin: they
// decode the request, call exactly one service method with the caller's
// principal, and encode the result or map the error via responder.fail.
package handlers

import (
	"log/slog"
	"net/http"

	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/middleware"
	"github.com/acme/meridian/internal/services"
	"github.com/acme/meridian/pkg/httpx"
)

// Deps are the collaborators the router needs. They are assembled in internal/app.
type Deps struct {
	Users   *services.UserService
	Auth    *services.AuthService
	Billing *services.BillingService
	Plans   *services.PlanService
	Audit   *services.AuditService
	Flags   *services.FlagService

	Issuer     *auth.Issuer
	Clock      clock.Clock
	Logger     *slog.Logger
	Limiter    *middleware.RateLimiter // nil disables rate limiting
	TrustProxy bool
}

// NewRouter builds the HTTP handler with every route and the global middleware.
func NewRouter(d Deps) http.Handler {
	rs := responder{logger: d.Logger}
	authn := middleware.Authenticate(d.Issuer)

	// protected requires a valid bearer token.
	protected := func(h http.HandlerFunc) http.Handler { return authn(h) }
	// staff additionally requires a minimum role for the whole endpoint.
	staff := func(role auth.Role, h http.HandlerFunc) http.Handler {
		return middleware.Chain(h, authn, middleware.RequireRole(role))
	}

	ah := &authHandler{responder: rs, auth: d.Auth, users: d.Users}
	uh := &userHandler{responder: rs, users: d.Users}
	bh := &billingHandler{responder: rs, billing: d.Billing}
	ph := &planHandler{responder: rs, plans: d.Plans}
	adm := &adminHandler{responder: rs, users: d.Users, audit: d.Audit, flags: d.Flags}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", health)

	mux.HandleFunc("POST /v1/auth/register", ah.register)
	mux.HandleFunc("POST /v1/auth/login", ah.login)

	mux.Handle("GET /v1/me", protected(uh.me))
	mux.Handle("PATCH /v1/me", protected(uh.updateMe))
	mux.Handle("GET /v1/users/{id}", protected(uh.get))

	mux.HandleFunc("GET /v1/plans", ph.list)
	mux.Handle("POST /v1/subscriptions", protected(ph.subscribe))
	mux.Handle("GET /v1/subscriptions", protected(ph.listSubscriptions))
	mux.Handle("POST /v1/subscriptions/{id}/cancel", protected(ph.cancel))

	mux.Handle("POST /v1/invoices", staff(auth.RoleBillingAdmin, bh.create))
	mux.Handle("GET /v1/invoices", protected(bh.list))
	mux.Handle("GET /v1/invoices/{id}", protected(bh.get))
	mux.Handle("POST /v1/invoices/{id}/issue", protected(bh.issue))
	mux.Handle("POST /v1/invoices/{id}/void", protected(bh.void))
	mux.Handle("POST /v1/invoices/{id}/payments", protected(bh.recordPayment))
	mux.Handle("GET /v1/invoices/{id}/payments", protected(bh.listPayments))

	mux.Handle("GET /v1/flags/{key}", protected(adm.evaluateFlag))

	mux.Handle("GET /v1/admin/users", staff(auth.RoleAdmin, adm.listUsers))
	mux.Handle("PATCH /v1/admin/users/{id}/role", staff(auth.RoleAdmin, adm.setRole))
	mux.Handle("POST /v1/admin/plans", staff(auth.RoleAdmin, ph.create))
	mux.Handle("GET /v1/admin/audit", staff(auth.RoleAdmin, adm.listAudit))
	mux.Handle("GET /v1/admin/flags", staff(auth.RoleAdmin, adm.listFlags))
	mux.Handle("PUT /v1/admin/flags/{key}", staff(auth.RoleAdmin, adm.saveFlag))

	mux.HandleFunc("/", notFound)

	mws := []middleware.Middleware{middleware.RequestID, middleware.Logging(d.Logger, d.Clock), middleware.Recover(d.Logger)}
	if d.Limiter != nil {
		mws = append(mws, middleware.RateLimit(d.Limiter, d.TrustProxy))
	}
	return middleware.Chain(mux, mws...)
}

func health(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteError(w, http.StatusNotFound, httpx.ErrorDetail{Code: "route_not_found", Message: "no such endpoint"})
}
