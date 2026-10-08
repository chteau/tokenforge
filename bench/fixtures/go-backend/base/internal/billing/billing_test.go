package billing

import (
	"testing"
	"time"
)

func TestFormatCents(t *testing.T) {
	tests := []struct {
		cents    int64
		currency string
		want     string
	}{
		{0, "EUR", "€0.00"},
		{5, "USD", "$0.05"},
		{123456, "EUR", "€1,234.56"},
		{-123456789, "GBP", "-£1,234,567.89"},
		{1000, "CHF", "10.00 CHF"},
	}
	for _, tt := range tests {
		if got := FormatCents(tt.cents, tt.currency); got != tt.want {
			t.Errorf("FormatCents(%d, %s) = %q, want %q", tt.cents, tt.currency, got, tt.want)
		}
	}
}

func TestParseAmount(t *testing.T) {
	tests := []struct {
		in      string
		want    int64
		wantErr bool
	}{
		{"12", 1200, false},
		{"12.5", 1250, false},
		{"12.05", 1205, false},
		{"0.99", 99, false},
		{"", 0, true},
		{"-1", 0, true},
		{"1.234", 0, true},
		{"1.", 0, true},
		{".5", 0, true},
		{"abc", 0, true},
	}
	for _, tt := range tests {
		got, err := ParseAmount(tt.in)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("ParseAmount(%q) = %d, %v", tt.in, got, err)
		}
	}
}

func TestApplyBasisPoints(t *testing.T) {
	tests := []struct{ cents, bps, want int64 }{
		{10000, 2000, 2000},
		{999, 2000, 200}, // 199.8 rounds up
		{1001, 2000, 200},
		{25, 2000, 5},
		{12345, 0, 0},
	}
	for _, tt := range tests {
		if got := ApplyBasisPoints(tt.cents, tt.bps); got != tt.want {
			t.Errorf("ApplyBasisPoints(%d, %d) = %d, want %d", tt.cents, tt.bps, got, tt.want)
		}
	}
}

func TestInvoiceRecalculate(t *testing.T) {
	inv := Invoice{TaxRateBps: 2000, Lines: []Line{
		{Description: "Seats", Quantity: 3, UnitCents: 1500},
		{Description: "Support", Quantity: 1, UnitCents: 2000},
	}}
	inv.Recalculate()
	if inv.SubtotalCents != 6500 || inv.TaxCents != 1300 || inv.TotalCents != 7800 {
		t.Fatalf("totals = %d/%d/%d", inv.SubtotalCents, inv.TaxCents, inv.TotalCents)
	}
	if inv.Lines[0].AmountCents != 4500 {
		t.Fatalf("line amount = %d", inv.Lines[0].AmountCents)
	}
	inv.PaidCents = 8000
	if inv.OutstandingCents() != 0 {
		t.Fatalf("outstanding = %d", inv.OutstandingCents())
	}
}

func TestInvoiceOverdueAndClone(t *testing.T) {
	due := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	inv := Invoice{Status: InvoiceOpen, DueAt: &due, Lines: []Line{{Description: "x"}}}
	if inv.Overdue(due) {
		t.Fatal("not overdue at exactly the due time")
	}
	if !inv.Overdue(due.Add(time.Second)) {
		t.Fatal("should be overdue")
	}
	c := inv.Clone()
	c.Lines[0].Description = "changed"
	*c.DueAt = due.Add(time.Hour)
	if inv.Lines[0].Description != "x" || !inv.DueAt.Equal(due) {
		t.Fatal("clone shares memory with original")
	}
}

func TestIntervalPeriodEnd(t *testing.T) {
	start := time.Date(2026, 1, 31, 0, 0, 0, 0, time.UTC)
	if got := IntervalYear.PeriodEnd(start); got.Year() != 2027 {
		t.Fatalf("year end = %v", got)
	}
	if got := IntervalMonth.PeriodEnd(start); got.Month() != time.March {
		t.Fatalf("month end = %v (Go normalises Feb 31 to Mar 3)", got)
	}
}
