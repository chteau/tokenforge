// Package services contains the business logic. Handlers call services with
// the authenticated auth.Principal; services enforce authorization, validate
// input, talk to repositories and return *apperr.Error values for every
// client-visible failure.
//
// Authorization conventions:
//   - A caller that may not see a resource gets a NotFound error, exactly as
//     if the resource did not exist, so IDs cannot be probed.
//   - A caller that can see a resource but may not perform the requested
//     action on it gets a Forbidden error.
package services

import (
	"errors"
	"fmt"

	"github.com/acme/meridian/internal/apperr"
	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/repositories"
)

// mapNotFound converts repositories.ErrNotFound into nf and wraps anything else.
func mapNotFound(err error, nf *apperr.Error) error {
	if errors.Is(err, repositories.ErrNotFound) {
		return nf
	}
	if _, ok := apperr.As(err); ok {
		return err
	}
	return fmt.Errorf("repository: %w", err)
}

func requireRole(p auth.Principal, role auth.Role) error {
	if !p.Is(role) {
		return apperr.Forbidden("insufficient_role", fmt.Sprintf("this action requires the %s role", role))
	}
	return nil
}
