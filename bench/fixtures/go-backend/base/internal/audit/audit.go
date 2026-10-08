// Package audit defines the append-only audit trail of security- and
// billing-relevant actions.
package audit

import "time"

// Event is a single audit record.
type Event struct {
	ID         string            `json:"id"`
	ActorID    string            `json:"actor_id"`
	Action     string            `json:"action"`
	TargetType string            `json:"target_type"`
	TargetID   string            `json:"target_id"`
	Metadata   map[string]string `json:"metadata,omitempty"`
	OccurredAt time.Time         `json:"occurred_at"`
}

// Filter narrows audit queries. Empty fields match everything.
type Filter struct {
	ActorID  string
	Action   string
	TargetID string
	Since    time.Time
}

// Matches reports whether e satisfies f.
func (f Filter) Matches(e Event) bool {
	return (f.ActorID == "" || e.ActorID == f.ActorID) &&
		(f.Action == "" || e.Action == f.Action) &&
		(f.TargetID == "" || e.TargetID == f.TargetID) &&
		(f.Since.IsZero() || !e.OccurredAt.Before(f.Since))
}

// Well-known actions.
const (
	ActionUserRegistered   = "user.registered"
	ActionUserLogin        = "user.login"
	ActionUserRoleChanged  = "user.role_changed"
	ActionPlanCreated      = "plan.created"
	ActionSubscribed       = "subscription.created"
	ActionSubCanceled      = "subscription.canceled"
	ActionInvoiceCreated   = "invoice.created"
	ActionInvoiceIssued    = "invoice.issued"
	ActionInvoiceVoided    = "invoice.voided"
	ActionPaymentRecorded  = "invoice.payment_recorded"
	ActionFeatureFlagSaved = "feature_flag.saved"
)
