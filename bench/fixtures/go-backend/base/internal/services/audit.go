package services

import (
	"context"
	"fmt"
	"maps"

	"github.com/acme/meridian/internal/audit"
	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/repositories"
	"github.com/acme/meridian/pkg/ids"
	"github.com/acme/meridian/pkg/pagination"
)

// AuditService records and queries the audit trail.
type AuditService struct {
	repo  repositories.AuditRepository
	clock clock.Clock
}

// NewAuditService returns an AuditService.
func NewAuditService(repo repositories.AuditRepository, clk clock.Clock) *AuditService {
	return &AuditService{repo: repo, clock: clk}
}

// Record appends an audit event. Callers must treat failures as fatal for the
// operation: billing changes without an audit trail are not acceptable.
func (s *AuditService) Record(ctx context.Context, actorID, action, targetType, targetID string, meta map[string]string) error {
	e := audit.Event{
		ID:         ids.New("aud"),
		ActorID:    actorID,
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		Metadata:   maps.Clone(meta),
		OccurredAt: s.clock.Now(),
	}
	if err := s.repo.Append(ctx, e); err != nil {
		return fmt.Errorf("append audit event: %w", err)
	}
	return nil
}

// List returns audit events matching f, oldest first. Admins only.
func (s *AuditService) List(ctx context.Context, p auth.Principal, f audit.Filter, page pagination.Params) (pagination.Page[audit.Event], error) {
	if err := requireRole(p, auth.RoleAdmin); err != nil {
		return pagination.Page[audit.Event]{}, err
	}
	events, err := s.repo.List(ctx, f)
	if err != nil {
		return pagination.Page[audit.Event]{}, err
	}
	return pagination.Slice(events, page), nil
}
