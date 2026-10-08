package billing

import "time"

// Interval is a subscription billing period.
type Interval string

const (
	IntervalMonth Interval = "month"
	IntervalYear  Interval = "year"
)

// Plan is a purchasable subscription tier.
type Plan struct {
	ID         string    `json:"id"`
	Code       string    `json:"code"`
	Name       string    `json:"name"`
	PriceCents int64     `json:"price_cents"`
	Currency   string    `json:"currency"`
	Interval   Interval  `json:"interval"`
	Active     bool      `json:"active"`
	CreatedAt  time.Time `json:"created_at"`
}

// SubscriptionStatus is the lifecycle state of a subscription.
type SubscriptionStatus string

const (
	SubscriptionActive   SubscriptionStatus = "active"
	SubscriptionCanceled SubscriptionStatus = "canceled"
)

// Subscription links a customer to a plan.
type Subscription struct {
	ID               string             `json:"id"`
	CustomerID       string             `json:"customer_id"`
	PlanID           string             `json:"plan_id"`
	Status           SubscriptionStatus `json:"status"`
	StartedAt        time.Time          `json:"started_at"`
	CurrentPeriodEnd time.Time          `json:"current_period_end"`
	CanceledAt       *time.Time         `json:"canceled_at,omitempty"`
}

// PeriodEnd returns the end of a billing period starting at start.
func (i Interval) PeriodEnd(start time.Time) time.Time {
	if i == IntervalYear {
		return start.AddDate(1, 0, 0)
	}
	return start.AddDate(0, 1, 0)
}
