package billing

import "time"

// InvoiceStatus is the lifecycle state of an invoice.
//
//	draft --issue--> open --pay in full--> paid
//	draft|open --void--> void
type InvoiceStatus string

const (
	InvoiceDraft InvoiceStatus = "draft"
	InvoiceOpen  InvoiceStatus = "open"
	InvoicePaid  InvoiceStatus = "paid"
	InvoiceVoid  InvoiceStatus = "void"
)

// Line is a single invoice line item.
type Line struct {
	Description string `json:"description"`
	Quantity    int64  `json:"quantity"`
	UnitCents   int64  `json:"unit_cents"`
	AmountCents int64  `json:"amount_cents"`
}

// Invoice is a bill sent to a customer.
type Invoice struct {
	ID            string        `json:"id"`
	Number        string        `json:"number"`
	CustomerID    string        `json:"customer_id"`
	Status        InvoiceStatus `json:"status"`
	Currency      string        `json:"currency"`
	Lines         []Line        `json:"lines"`
	TaxRateBps    int64         `json:"tax_rate_bps"`
	SubtotalCents int64         `json:"subtotal_cents"`
	TaxCents      int64         `json:"tax_cents"`
	TotalCents    int64         `json:"total_cents"`
	PaidCents     int64         `json:"paid_cents"`
	DueInDays     int           `json:"due_in_days"`
	IssuedAt      *time.Time    `json:"issued_at,omitempty"`
	DueAt         *time.Time    `json:"due_at,omitempty"`
	PaidAt        *time.Time    `json:"paid_at,omitempty"`
	VoidedAt      *time.Time    `json:"voided_at,omitempty"`
	CreatedAt     time.Time     `json:"created_at"`
	UpdatedAt     time.Time     `json:"updated_at"`
}

// Recalculate recomputes line amounts and invoice totals.
func (inv *Invoice) Recalculate() {
	var subtotal int64
	for i := range inv.Lines {
		inv.Lines[i].AmountCents = inv.Lines[i].Quantity * inv.Lines[i].UnitCents
		subtotal += inv.Lines[i].AmountCents
	}
	inv.SubtotalCents = subtotal
	inv.TaxCents = ApplyBasisPoints(subtotal, inv.TaxRateBps)
	inv.TotalCents = subtotal + inv.TaxCents
}

// OutstandingCents is the amount still to be paid.
func (inv *Invoice) OutstandingCents() int64 {
	return max(inv.TotalCents-inv.PaidCents, 0)
}

// Overdue reports whether an open invoice is past its due date at now.
func (inv *Invoice) Overdue(now time.Time) bool {
	return inv.Status == InvoiceOpen && inv.DueAt != nil && now.After(*inv.DueAt)
}

// Clone returns a deep copy so callers cannot mutate repository state.
func (inv Invoice) Clone() Invoice {
	inv.Lines = append([]Line(nil), inv.Lines...)
	inv.IssuedAt = cloneTime(inv.IssuedAt)
	inv.DueAt = cloneTime(inv.DueAt)
	inv.PaidAt = cloneTime(inv.PaidAt)
	inv.VoidedAt = cloneTime(inv.VoidedAt)
	return inv
}

func cloneTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	c := *t
	return &c
}

// PaymentMethod is how a payment was received.
type PaymentMethod string

const (
	MethodCard         PaymentMethod = "card"
	MethodBankTransfer PaymentMethod = "bank_transfer"
	MethodCash         PaymentMethod = "cash"
)

// Payment is money received against an invoice.
type Payment struct {
	ID          string        `json:"id"`
	InvoiceID   string        `json:"invoice_id"`
	AmountCents int64         `json:"amount_cents"`
	Method      PaymentMethod `json:"method"`
	Reference   string        `json:"reference,omitempty"`
	RecordedBy  string        `json:"recorded_by"`
	ReceivedAt  time.Time     `json:"received_at"`
}
