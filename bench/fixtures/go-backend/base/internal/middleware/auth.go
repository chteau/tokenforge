package middleware

import (
	"errors"
	"net/http"
	"strings"

	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/pkg/httpx"
)

// Authenticate requires a valid "Authorization: Bearer <token>" header and
// stores the auth.Principal in the request context. Requests without a valid
// token are rejected with 401.
func Authenticate(issuer *auth.Issuer) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
			if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" {
				w.Header().Set("WWW-Authenticate", `Bearer realm="api"`)
				httpx.WriteError(w, http.StatusUnauthorized, httpx.ErrorDetail{Code: "missing_token", Message: "a bearer token is required"})
				return
			}
			claims, err := issuer.Verify(token)
			if err != nil {
				code := "invalid_token"
				if errors.Is(err, auth.ErrExpiredToken) {
					code = "token_expired"
				}
				w.Header().Set("WWW-Authenticate", `Bearer realm="api", error="invalid_token"`)
				httpx.WriteError(w, http.StatusUnauthorized, httpx.ErrorDetail{Code: code, Message: "the bearer token is invalid or expired"})
				return
			}
			ctx := auth.WithPrincipal(r.Context(), auth.Principal{UserID: claims.Subject, Role: claims.Role})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireRole rejects authenticated callers without the role with 403. It
// must run after Authenticate. Use it for collection-level endpoints that
// only staff may call at all; per-resource checks belong in the services.
func RequireRole(role auth.Role) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, ok := auth.PrincipalFrom(r.Context())
			if !ok {
				httpx.WriteError(w, http.StatusUnauthorized, httpx.ErrorDetail{Code: "missing_token", Message: "a bearer token is required"})
				return
			}
			if !p.Is(role) {
				httpx.WriteError(w, http.StatusForbidden, httpx.ErrorDetail{Code: "insufficient_role", Message: "this endpoint requires the " + string(role) + " role"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
