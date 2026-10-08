package services

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/acme/meridian/internal/apperr"
	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/billing"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/notifications"
	"github.com/acme/meridian/internal/repositories"
	"github.com/acme/meridian/internal/users"
)

type billingFixture struct {
	svc      *BillingService
	invoices *repositories.MemoryInvoices
	clock    *clock.Fake
	admin    auth.Principal
	customer auth.Principal
}

func newBillingFixture(t *testing.T) *billingFixture {
	t.Helper()
	clk := clock.NewFake(time.Date(2026, 5, 1, 8, 0, 0, 0, time.UTC))
	usersRepo := repositories.NewMemoryUsers()
	_ = usersRepo.Create(context.Background(), users.User{ID: "usr_c", Email: "c@example.com", Role: auth.RoleUser})
	tpls, err := notifications.NewTemplates()
	if err != nil {
		t.Fatal(err)
	}
	notifier := NewNotifier(usersRepo, &notifications.FakeEmailSender{}, &notifications.FakeSMSSender{}, tpls, slog.New(slog.NewTextHandler(io.Discard, nil)))
	invoices := repositories.NewMemoryInvoices()
	auditSvc := NewAuditService(repositories.NewMemoryAudit(), clk)
	return &billingFixture{
		svc:      NewBillingService(invoices, repositories.NewMemoryPayments(), usersRepo, auditSvc, notifier, clk),
		invoices: invoices,
		clock:    clk,
		admin:    auth.Principal{UserID: "usr_b", Role: auth.RoleBillingAdmin},
		customer: auth.Principal{UserID: "usr_c", Role: auth.RoleUser},
	}
}

func (f *billingFixture) openInvoice(t *testing.T, unitCents int64) billing.Invoice {
	t.Helper()
	ctx := context.Background()
	inv, err := f.svc.CreateInvoice(ctx, f.admin, CreateInvoiceInput{
		CustomerID: "usr_c", Currency: "USD", Lines: []LineInput{{Description: "Plan", Quantity: 1, UnitCents: unitCents}},
	})
	if err != nil {
		t.Fatal(err)
	}
	inv, err = f.svc.IssueInvoice(ctx, f.admin, inv.ID)
	if err != nil {
		t.Fatal(err)
	}
	return inv
}

func TestCreateInvoiceDefaults(t *testing.T) {
	f := newBillingFixture(t)
	inv, err := f.svc.CreateInvoice(context.Background(), f.admin, CreateInvoiceInput{
		CustomerID: "usr_c", Currency: "USD", TaxRateBps: 750,
		Lines: []LineInput{{Description: "  Seats  ", Quantity: 3, UnitCents: 333}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if inv.DueInDays != 30 || inv.Status != billing.InvoiceDraft || inv.Lines[0].Description != "Seats" {
		t.Fatalf("invoice = %+v", inv)
	}
	if inv.SubtotalCents != 999 || inv.TaxCents != 75 || inv.TotalCents != 1074 {
		t.Fatalf("totals = %d/%d/%d", inv.SubtotalCents, inv.TaxCents, inv.TotalCents)
	}
}

func TestRecordPayment(t *testing.T) {
	tests := []struct {
		name       string
		amounts    []int64
		wantKind   apperr.Kind // for the last payment; KindInternal means success
		wantStatus billing.InvoiceStatus
		wantPaid   int64
	}{
		{name: "partial", amounts: []int64{400}, wantStatus: billing.InvoiceOpen, wantPaid: 400},
		{name: "exact", amounts: []int64{1000}, wantStatus: billing.InvoicePaid, wantPaid: 1000},
		{name: "two instalments", amounts: []int64{600, 400}, wantStatus: billing.InvoicePaid, wantPaid: 1000},
		{name: "overpay", amounts: []int64{600, 401}, wantKind: apperr.KindInvalid, wantStatus: billing.InvoiceOpen, wantPaid: 600},
		{name: "after paid", amounts: []int64{1000, 1}, wantKind: apperr.KindConflict, wantStatus: billing.InvoicePaid, wantPaid: 1000},
		{name: "zero", amounts: []int64{0}, wantKind: apperr.KindInvalid, wantStatus: billing.InvoiceOpen},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newBillingFixture(t)
			inv := f.openInvoice(t, 1000)
			var err error
			for _, a := range tt.amounts {
				_, err = f.svc.RecordPayment(context.Background(), f.admin, inv.ID, RecordPaymentInput{AmountCents: a, Method: "card"})
			}
			if tt.wantKind == apperr.KindInternal && err != nil {
				t.Fatalf("unexpected error %v", err)
			}
			if tt.wantKind != apperr.KindInternal && apperr.KindOf(err) != tt.wantKind {
				t.Fatalf("err = %v, want kind %v", err, tt.wantKind)
			}
			got, _ := f.invoices.Get(context.Background(), inv.ID)
			if got.Status != tt.wantStatus || got.PaidCents != tt.wantPaid {
				t.Fatalf("status=%s paid=%d", got.Status, got.PaidCents)
			}
		})
	}
}

func TestInvoicePermissions(t *testing.T) {
	f := newBillingFixture(t)
	inv := f.openInvoice(t, 1000)
	stranger := auth.Principal{UserID: "usr_x", Role: auth.RoleUser}
	ctx := context.Background()

	if _, err := f.svc.GetInvoice(ctx, stranger, inv.ID); apperr.KindOf(err) != apperr.KindNotFound {
		t.Fatalf("stranger get: %v", err)
	}
	if _, err := f.svc.VoidInvoice(ctx, f.customer, inv.ID); apperr.KindOf(err) != apperr.KindForbidden {
		t.Fatalf("owner void: %v", err)
	}
	if _, err := f.svc.VoidInvoice(ctx, stranger, inv.ID); apperr.KindOf(err) != apperr.KindNotFound {
		t.Fatalf("stranger void: %v", err)
	}
	if _, err := f.svc.CreateInvoice(ctx, f.customer, CreateInvoiceInput{}); apperr.KindOf(err) != apperr.KindForbidden {
		t.Fatalf("customer create: %v", err)
	}
	if _, err := f.svc.VoidInvoice(ctx, f.admin, inv.ID); err != nil {
		t.Fatalf("admin void: %v", err)
	}
}
