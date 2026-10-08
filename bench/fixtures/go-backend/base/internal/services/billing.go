package services

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/acme/meridian/internal/apperr"
	"github.com/acme/meridian/internal/audit"
	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/billing"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/notifications"
	"github.com/acme/meridian/internal/repositories"
	"github.com/acme/meridian/internal/validation"
	"github.com/acme/meridian/pkg/ids"
	"github.com/acme/meridian/pkg/pagination"
)

var errInvoiceNotFound = apperr.NotFound("invoice_not_found", "invoice not found")

const defaultDueInDays = 30

// BillingService manages invoices and payments.
type BillingService struct {
	invoices repositories.InvoiceRepository
	payments repositories.PaymentRepository
	users    repositories.UserRepository
	audit    *AuditService
	notifier *Notifier
	clock    clock.Clock
}

// NewBillingService returns a BillingService.
func NewBillingService(invoices repositories.InvoiceRepository, payments repositories.PaymentRepository, usersRepo repositories.UserRepository, auditSvc *AuditService, notifier *Notifier, clk clock.Clock) *BillingService {
	return &BillingService{invoices: invoices, payments: payments, users: usersRepo, audit: auditSvc, notifier: notifier, clock: clk}
}

// loadInvoiceFor returns the invoice if p may see it: its customer and
// billing admins can, everyone else gets the same error as for a missing ID.
func (s *BillingService) loadInvoiceFor(ctx context.Context, p auth.Principal, id string) (billing.Invoice, error) {
	inv, err := s.invoices.Get(ctx, id)
	if err != nil {
		return billing.Invoice{}, mapNotFound(err, errInvoiceNotFound)
	}
	if inv.CustomerID != p.UserID && !p.Is(auth.RoleBillingAdmin) {
		return billing.Invoice{}, errInvoiceNotFound
	}
	return inv, nil
}

// LineInput is one requested invoice line.
type LineInput struct {
	Description string `json:"description"`
	Quantity    int64  `json:"quantity"`
	UnitCents   int64  `json:"unit_cents"`
}

// CreateInvoiceInput is the payload for creating a draft invoice.
type CreateInvoiceInput struct {
	CustomerID string      `json:"customer_id"`
	Currency   string      `json:"currency"`
	TaxRateBps int64       `json:"tax_rate_bps"`
	DueInDays  int         `json:"due_in_days"`
	Lines      []LineInput `json:"lines"`
}

func (in CreateInvoiceInput) validate() error {
	v := validation.New()
	v.Required("customer_id", in.CustomerID)
	v.Currency("currency", in.Currency)
	v.Between("tax_rate_bps", in.TaxRateBps, 0, 10_000)
	v.Between("due_in_days", int64(in.DueInDays), 0, 365)
	v.Check(len(in.Lines) > 0, "lines", "at least one line is required")
	v.Check(len(in.Lines) <= 100, "lines", "at most 100 lines are allowed")
	for i, l := range in.Lines {
		prefix := "lines[" + strconv.Itoa(i) + "]."
		v.Required(prefix+"description", l.Description)
		v.MaxLen(prefix+"description", l.Description, 200)
		v.Between(prefix+"quantity", l.Quantity, 1, 10_000)
		v.Between(prefix+"unit_cents", l.UnitCents, 0, 100_000_000)
	}
	return v.Err()
}

// CreateInvoice creates a draft invoice for a customer. Billing admins only.
func (s *BillingService) CreateInvoice(ctx context.Context, p auth.Principal, in CreateInvoiceInput) (billing.Invoice, error) {
	if err := requireRole(p, auth.RoleBillingAdmin); err != nil {
		return billing.Invoice{}, err
	}
	if err := in.validate(); err != nil {
		return billing.Invoice{}, err
	}
	if _, err := s.users.Get(ctx, in.CustomerID); err != nil {
		if errors.Is(err, repositories.ErrNotFound) {
			return billing.Invoice{}, apperr.Invalid("validation_failed", "one or more fields are invalid", map[string]string{"customer_id": "does not exist"})
		}
		return billing.Invoice{}, err
	}
	number, err := s.invoices.NextNumber(ctx)
	if err != nil {
		return billing.Invoice{}, err
	}
	now := s.clock.Now()
	inv := billing.Invoice{
		ID:         ids.New("inv"),
		Number:     number,
		CustomerID: in.CustomerID,
		Status:     billing.InvoiceDraft,
		Currency:   in.Currency,
		TaxRateBps: in.TaxRateBps,
		DueInDays:  in.DueInDays,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if inv.DueInDays == 0 {
		inv.DueInDays = defaultDueInDays
	}
	for _, l := range in.Lines {
		inv.Lines = append(inv.Lines, billing.Line{Description: strings.TrimSpace(l.Description), Quantity: l.Quantity, UnitCents: l.UnitCents})
	}
	inv.Recalculate()
	if err := s.invoices.Create(ctx, inv); err != nil {
		return billing.Invoice{}, err
	}
	if err := s.audit.Record(ctx, p.UserID, audit.ActionInvoiceCreated, "invoice", inv.ID, map[string]string{"customer_id": inv.CustomerID, "total_cents": strconv.FormatInt(inv.TotalCents, 10)}); err != nil {
		return billing.Invoice{}, err
	}
	return inv, nil
}

// GetInvoice returns an invoice visible to p.
func (s *BillingService) GetInvoice(ctx context.Context, p auth.Principal, id string) (billing.Invoice, error) {
	return s.loadInvoiceFor(ctx, p, id)
}

// ListInvoicesInput filters invoice listings.
type ListInvoicesInput struct {
	CustomerID string
	Status     string
}

// ListInvoices lists invoices, newest first. Customers only ever see their
// own invoices; billing admins may filter by customer.
func (s *BillingService) ListInvoices(ctx context.Context, p auth.Principal, in ListInvoicesInput, page pagination.Params) (pagination.Page[billing.Invoice], error) {
	f := repositories.InvoiceFilter{CustomerID: in.CustomerID, Status: billing.InvoiceStatus(in.Status)}
	if in.Status != "" {
		v := validation.New()
		v.OneOf("status", in.Status, string(billing.InvoiceDraft), string(billing.InvoiceOpen), string(billing.InvoicePaid), string(billing.InvoiceVoid))
		if err := v.Err(); err != nil {
			return pagination.Page[billing.Invoice]{}, err
		}
	}
	if !p.Is(auth.RoleBillingAdmin) {
		f.CustomerID = p.UserID
	}
	list, err := s.invoices.List(ctx, f)
	if err != nil {
		return pagination.Page[billing.Invoice]{}, err
	}
	return pagination.Slice(list, page), nil
}

// IssueInvoice finalises a draft invoice and notifies the customer.
func (s *BillingService) IssueInvoice(ctx context.Context, p auth.Principal, id string) (billing.Invoice, error) {
	if _, err := s.loadInvoiceFor(ctx, p, id); err != nil {
		return billing.Invoice{}, err
	}
	if err := requireRole(p, auth.RoleBillingAdmin); err != nil {
		return billing.Invoice{}, err
	}
	now := s.clock.Now()
	inv, err := s.invoices.Update(ctx, id, func(inv *billing.Invoice) error {
		if inv.Status != billing.InvoiceDraft {
			return apperr.Conflict("invoice_not_draft", "only draft invoices can be issued")
		}
		if inv.TotalCents <= 0 {
			return apperr.Conflict("invoice_empty", "an invoice with a zero total cannot be issued")
		}
		due := now.AddDate(0, 0, inv.DueInDays)
		inv.Status = billing.InvoiceOpen
		inv.IssuedAt = &now
		inv.DueAt = &due
		inv.UpdatedAt = now
		return nil
	})
	if err != nil {
		return billing.Invoice{}, mapNotFound(err, errInvoiceNotFound)
	}
	if err := s.audit.Record(ctx, p.UserID, audit.ActionInvoiceIssued, "invoice", inv.ID, nil); err != nil {
		return billing.Invoice{}, err
	}
	s.notifier.NotifyUser(ctx, inv.CustomerID, notifications.TemplateInvoiceIssued, map[string]string{
		"Number":  inv.Number,
		"Total":   billing.FormatCents(inv.TotalCents, inv.Currency),
		"DueDate": inv.DueAt.Format(time.DateOnly),
	})
	return inv, nil
}

// RecordPaymentInput is the payload for recording a received payment.
type RecordPaymentInput struct {
	AmountCents int64  `json:"amount_cents"`
	Method      string `json:"method"`
	Reference   string `json:"reference"`
}

// RecordPayment registers money received against an open invoice. The
// invoice becomes paid once the outstanding amount reaches zero.
func (s *BillingService) RecordPayment(ctx context.Context, p auth.Principal, id string, in RecordPaymentInput) (billing.Payment, error) {
	if _, err := s.loadInvoiceFor(ctx, p, id); err != nil {
		return billing.Payment{}, err
	}
	if err := requireRole(p, auth.RoleBillingAdmin); err != nil {
		return billing.Payment{}, err
	}
	v := validation.New()
	v.Positive("amount_cents", in.AmountCents)
	v.OneOf("method", in.Method, string(billing.MethodCard), string(billing.MethodBankTransfer), string(billing.MethodCash))
	v.MaxLen("reference", in.Reference, 100)
	if err := v.Err(); err != nil {
		return billing.Payment{}, err
	}
	now := s.clock.Now()
	inv, err := s.invoices.Update(ctx, id, func(inv *billing.Invoice) error {
		if inv.Status != billing.InvoiceOpen {
			return apperr.Conflict("invoice_not_open", "payments can only be recorded against open invoices")
		}
		if in.AmountCents > inv.OutstandingCents() {
			return apperr.Invalid("amount_exceeds_outstanding", "amount exceeds the outstanding balance",
				map[string]string{"amount_cents": "must not exceed " + strconv.FormatInt(inv.OutstandingCents(), 10)})
		}
		inv.PaidCents += in.AmountCents
		if inv.OutstandingCents() == 0 {
			inv.Status = billing.InvoicePaid
			inv.PaidAt = &now
		}
		inv.UpdatedAt = now
		return nil
	})
	if err != nil {
		return billing.Payment{}, mapNotFound(err, errInvoiceNotFound)
	}
	pay := billing.Payment{
		ID:          ids.New("pay"),
		InvoiceID:   inv.ID,
		AmountCents: in.AmountCents,
		Method:      billing.PaymentMethod(in.Method),
		Reference:   in.Reference,
		RecordedBy:  p.UserID,
		ReceivedAt:  now,
	}
	if err := s.payments.Create(ctx, pay); err != nil {
		return billing.Payment{}, err
	}
	if err := s.audit.Record(ctx, p.UserID, audit.ActionPaymentRecorded, "invoice", inv.ID, map[string]string{
		"payment_id": pay.ID, "amount_cents": strconv.FormatInt(pay.AmountCents, 10),
	}); err != nil {
		return billing.Payment{}, err
	}
	s.notifier.NotifyUser(ctx, inv.CustomerID, notifications.TemplatePaymentReceived, map[string]string{
		"Number":      inv.Number,
		"Amount":      billing.FormatCents(pay.AmountCents, inv.Currency),
		"Outstanding": billing.FormatCents(inv.OutstandingCents(), inv.Currency),
	})
	return pay, nil
}

// ListPayments returns the payments recorded against an invoice visible to p.
func (s *BillingService) ListPayments(ctx context.Context, p auth.Principal, id string) ([]billing.Payment, error) {
	if _, err := s.loadInvoiceFor(ctx, p, id); err != nil {
		return nil, err
	}
	list, err := s.payments.ListByInvoice(ctx, id)
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []billing.Payment{}
	}
	return list, nil
}

// VoidInvoice cancels a draft or open invoice that has no payments.
func (s *BillingService) VoidInvoice(ctx context.Context, p auth.Principal, id string) (billing.Invoice, error) {
	if _, err := s.loadInvoiceFor(ctx, p, id); err != nil {
		return billing.Invoice{}, err
	}
	if err := requireRole(p, auth.RoleBillingAdmin); err != nil {
		return billing.Invoice{}, err
	}
	now := s.clock.Now()
	inv, err := s.invoices.Update(ctx, id, func(inv *billing.Invoice) error {
		if (inv.Status != billing.InvoiceDraft && inv.Status != billing.InvoiceOpen) || inv.PaidCents > 0 {
			return apperr.Conflict("invoice_not_voidable", "only unpaid draft or open invoices can be voided")
		}
		inv.Status = billing.InvoiceVoid
		inv.VoidedAt = &now
		inv.UpdatedAt = now
		return nil
	})
	if err != nil {
		return billing.Invoice{}, mapNotFound(err, errInvoiceNotFound)
	}
	if err := s.audit.Record(ctx, p.UserID, audit.ActionInvoiceVoided, "invoice", inv.ID, nil); err != nil {
		return billing.Invoice{}, err
	}
	s.notifier.NotifyUser(ctx, inv.CustomerID, notifications.TemplateInvoiceVoided, map[string]string{"Number": inv.Number})
	return inv, nil
}

// createSubscriptionInvoice raises and issues the invoice for a subscription period.
func (s *BillingService) createSubscriptionInvoice(ctx context.Context, sub billing.Subscription, plan billing.Plan) (billing.Invoice, error) {
	number, err := s.invoices.NextNumber(ctx)
	if err != nil {
		return billing.Invoice{}, err
	}
	now := s.clock.Now()
	due := now.AddDate(0, 0, defaultDueInDays)
	inv := billing.Invoice{
		ID:         ids.New("inv"),
		Number:     number,
		CustomerID: sub.CustomerID,
		Status:     billing.InvoiceOpen,
		Currency:   plan.Currency,
		DueInDays:  defaultDueInDays,
		Lines: []billing.Line{{
			Description: plan.Name + " (" + sub.StartedAt.Format(time.DateOnly) + " to " + sub.CurrentPeriodEnd.Format(time.DateOnly) + ")",
			Quantity:    1,
			UnitCents:   plan.PriceCents,
		}},
		IssuedAt:  &now,
		DueAt:     &due,
		CreatedAt: now,
		UpdatedAt: now,
	}
	inv.Recalculate()
	if err := s.invoices.Create(ctx, inv); err != nil {
		return billing.Invoice{}, err
	}
	return inv, nil
}
