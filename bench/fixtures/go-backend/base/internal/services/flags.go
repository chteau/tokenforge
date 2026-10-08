package services

import (
	"context"
	"regexp"
	"strconv"

	"github.com/acme/meridian/internal/audit"
	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/flags"
	"github.com/acme/meridian/internal/repositories"
	"github.com/acme/meridian/internal/validation"
)

var flagKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}$`)

// FlagService manages and evaluates feature flags.
type FlagService struct {
	repo  repositories.FlagRepository
	audit *AuditService
	clock clock.Clock
}

// NewFlagService returns a FlagService.
func NewFlagService(repo repositories.FlagRepository, auditSvc *AuditService, clk clock.Clock) *FlagService {
	return &FlagService{repo: repo, audit: auditSvc, clock: clk}
}

// FlagState is a flag evaluated for one user.
type FlagState struct {
	Key     string `json:"key"`
	Enabled bool   `json:"enabled"`
}

// IsEnabled reports whether key is on for userID. Unknown flags are off.
func (s *FlagService) IsEnabled(ctx context.Context, key, userID string) bool {
	f, err := s.repo.Get(ctx, key)
	if err != nil {
		return false
	}
	return f.EnabledFor(userID)
}

// Evaluate returns the state of key for the caller.
func (s *FlagService) Evaluate(ctx context.Context, p auth.Principal, key string) FlagState {
	return FlagState{Key: key, Enabled: s.IsEnabled(ctx, key, p.UserID)}
}

// List returns every flag. Admins only.
func (s *FlagService) List(ctx context.Context, p auth.Principal) ([]flags.Flag, error) {
	if err := requireRole(p, auth.RoleAdmin); err != nil {
		return nil, err
	}
	return s.repo.List(ctx)
}

// SaveFlagInput creates or replaces a flag.
type SaveFlagInput struct {
	Description    string   `json:"description"`
	Enabled        bool     `json:"enabled"`
	RolloutPercent int      `json:"rollout_percent"`
	AllowUsers     []string `json:"allow_users"`
}

// Save creates or replaces the flag key. Admins only.
func (s *FlagService) Save(ctx context.Context, p auth.Principal, key string, in SaveFlagInput) (flags.Flag, error) {
	if err := requireRole(p, auth.RoleAdmin); err != nil {
		return flags.Flag{}, err
	}
	v := validation.New()
	v.Check(flagKeyPattern.MatchString(key), "key", "must be 2-64 lowercase letters, digits or underscores")
	v.MaxLen("description", in.Description, 200)
	v.Between("rollout_percent", int64(in.RolloutPercent), 0, 100)
	v.Check(len(in.AllowUsers) <= 500, "allow_users", "at most 500 users")
	if err := v.Err(); err != nil {
		return flags.Flag{}, err
	}
	f := flags.Flag{
		Key: key, Description: in.Description, Enabled: in.Enabled, RolloutPercent: in.RolloutPercent,
		AllowUsers: in.AllowUsers, UpdatedAt: s.clock.Now(),
	}
	if err := s.repo.Put(ctx, f); err != nil {
		return flags.Flag{}, err
	}
	if err := s.audit.Record(ctx, p.UserID, audit.ActionFeatureFlagSaved, "feature_flag", key, map[string]string{
		"enabled": strconv.FormatBool(f.Enabled), "rollout_percent": strconv.Itoa(f.RolloutPercent),
	}); err != nil {
		return flags.Flag{}, err
	}
	return f, nil
}
