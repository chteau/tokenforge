package services

import (
	"context"
	"errors"
	"regexp"

	"github.com/acme/meridian/internal/apperr"
	"github.com/acme/meridian/internal/audit"
	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/billing"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/repositories"
	"github.com/acme/meridian/internal/validation"
	"github.com/acme/meridian/pkg/ids"
)

var (
	errSubscriptionNotFound = apperr.NotFound("subscription_not_found", "subscription not found")
	planCodePattern         = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
)

// PlanService manages plans and subscriptions.
type PlanService struct {
	plans   repositories.PlanRepository
	subs    repositories.SubscriptionRepository
	billing *BillingService
	audit   *AuditService
	clock   clock.Clock
}

// NewPlanService returns a PlanService.
func NewPlanService(plans repositories.PlanRepository, subs repositories.SubscriptionRepository, billingSvc *BillingService, auditSvc *AuditService, clk clock.Clock) *PlanService {
	return &PlanService{plans: plans, subs: subs, billing: billingSvc, audit: auditSvc, clock: clk}
}

// ListPlans returns the active plans, cheapest first.
func (s *PlanService) ListPlans(ctx context.Context) ([]billing.Plan, error) {
	all, err := s.plans.List(ctx)
	if err != nil {
		return nil, err
	}
	out := []billing.Plan{}
	for _, p := range all {
		if p.Active {
			out = append(out, p)
		}
	}
	return out, nil
}

// CreatePlanInput is the payload for a new plan.
type CreatePlanInput struct {
	Code       string `json:"code"`
	Name       string `json:"name"`
	PriceCents int64  `json:"price_cents"`
	Currency   string `json:"currency"`
	Interval   string `json:"interval"`
}

// CreatePlan adds an active plan. Admins only.
func (s *PlanService) CreatePlan(ctx context.Context, p auth.Principal, in CreatePlanInput) (billing.Plan, error) {
	if err := requireRole(p, auth.RoleAdmin); err != nil {
		return billing.Plan{}, err
	}
	v := validation.New()
	v.Check(planCodePattern.MatchString(in.Code), "code", "must be 2-32 lowercase letters, digits or dashes")
	v.Required("name", in.Name)
	v.MaxLen("name", in.Name, 80)
	v.Between("price_cents", in.PriceCents, 0, 10_000_000)
	v.Currency("currency", in.Currency)
	v.OneOf("interval", in.Interval, string(billing.IntervalMonth), string(billing.IntervalYear))
	if err := v.Err(); err != nil {
		return billing.Plan{}, err
	}
	plan := billing.Plan{
		ID: ids.New("pln"), Code: in.Code, Name: in.Name, PriceCents: in.PriceCents,
		Currency: in.Currency, Interval: billing.Interval(in.Interval), Active: true, CreatedAt: s.clock.Now(),
	}
	if err := s.plans.Create(ctx, plan); err != nil {
		if errors.Is(err, repositories.ErrDuplicate) {
			return billing.Plan{}, apperr.Conflict("plan_code_taken", "a plan with this code already exists")
		}
		return billing.Plan{}, err
	}
	if err := s.audit.Record(ctx, p.UserID, audit.ActionPlanCreated, "plan", plan.ID, map[string]string{"code": plan.Code}); err != nil {
		return billing.Plan{}, err
	}
	return plan, nil
}

// SubscriptionResult is returned by Subscribe.
type SubscriptionResult struct {
	Subscription billing.Subscription `json:"subscription"`
	Invoice      billing.Invoice      `json:"invoice"`
}

// Subscribe starts a subscription for the caller and issues its first invoice.
func (s *PlanService) Subscribe(ctx context.Context, p auth.Principal, planCode string) (SubscriptionResult, error) {
	plan, err := s.plans.GetByCode(ctx, planCode)
	if errors.Is(err, repositories.ErrNotFound) || (err == nil && !plan.Active) {
		return SubscriptionResult{}, apperr.Invalid("validation_failed", "one or more fields are invalid", map[string]string{"plan_code": "unknown plan"})
	}
	if err != nil {
		return SubscriptionResult{}, err
	}
	existing, err := s.subs.ListByCustomer(ctx, p.UserID)
	if err != nil {
		return SubscriptionResult{}, err
	}
	for _, sub := range existing {
		if sub.PlanID == plan.ID && sub.Status == billing.SubscriptionActive {
			return SubscriptionResult{}, apperr.Conflict("already_subscribed", "you already have an active subscription to this plan")
		}
	}
	now := s.clock.Now()
	sub := billing.Subscription{
		ID: ids.New("sub"), CustomerID: p.UserID, PlanID: plan.ID, Status: billing.SubscriptionActive,
		StartedAt: now, CurrentPeriodEnd: plan.Interval.PeriodEnd(now),
	}
	if err := s.subs.Create(ctx, sub); err != nil {
		return SubscriptionResult{}, err
	}
	inv, err := s.billing.createSubscriptionInvoice(ctx, sub, plan)
	if err != nil {
		return SubscriptionResult{}, err
	}
	if err := s.audit.Record(ctx, p.UserID, audit.ActionSubscribed, "subscription", sub.ID, map[string]string{"plan": plan.Code, "invoice_id": inv.ID}); err != nil {
		return SubscriptionResult{}, err
	}
	return SubscriptionResult{Subscription: sub, Invoice: inv}, nil
}

// ListSubscriptions returns the caller's subscriptions.
func (s *PlanService) ListSubscriptions(ctx context.Context, p auth.Principal) ([]billing.Subscription, error) {
	list, err := s.subs.ListByCustomer(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []billing.Subscription{}
	}
	return list, nil
}

// CancelSubscription cancels a subscription owned by the caller (or any
// subscription, for billing admins).
func (s *PlanService) CancelSubscription(ctx context.Context, p auth.Principal, id string) (billing.Subscription, error) {
	sub, err := s.subs.Get(ctx, id)
	if err != nil {
		return billing.Subscription{}, mapNotFound(err, errSubscriptionNotFound)
	}
	if sub.CustomerID != p.UserID && !p.Is(auth.RoleBillingAdmin) {
		return billing.Subscription{}, errSubscriptionNotFound
	}
	now := s.clock.Now()
	sub, err = s.subs.Update(ctx, id, func(sub *billing.Subscription) error {
		if sub.Status == billing.SubscriptionCanceled {
			return apperr.Conflict("subscription_canceled", "subscription is already canceled")
		}
		sub.Status = billing.SubscriptionCanceled
		sub.CanceledAt = &now
		return nil
	})
	if err != nil {
		return billing.Subscription{}, mapNotFound(err, errSubscriptionNotFound)
	}
	if err := s.audit.Record(ctx, p.UserID, audit.ActionSubCanceled, "subscription", sub.ID, nil); err != nil {
		return billing.Subscription{}, err
	}
	return sub, nil
}
