package repositories

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/acme/meridian/internal/audit"
	"github.com/acme/meridian/internal/billing"
	"github.com/acme/meridian/internal/flags"
	"github.com/acme/meridian/internal/users"
)

var ctx = context.Background()

func TestMemoryUsers(t *testing.T) {
	r := NewMemoryUsers()
	u := users.User{ID: "usr_1", Email: "a@example.com"}
	if err := r.Create(ctx, u); err != nil {
		t.Fatal(err)
	}
	if err := r.Create(ctx, users.User{ID: "usr_2", Email: "a@example.com"}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate email: %v", err)
	}
	if _, err := r.Get(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	got, err := r.Update(ctx, "usr_1", func(u *users.User) error { u.Email = "b@example.com"; return nil })
	if err != nil || got.Email != "b@example.com" {
		t.Fatalf("update = %+v, %v", got, err)
	}
	if _, err := r.GetByEmail(ctx, "a@example.com"); !errors.Is(err, ErrNotFound) {
		t.Fatal("old email index not removed")
	}
	if _, err := r.GetByEmail(ctx, "b@example.com"); err != nil {
		t.Fatal(err)
	}
	boom := errors.New("boom")
	if _, err := r.Update(ctx, "usr_1", func(u *users.User) error { u.Name = "x"; return boom }); err != boom {
		t.Fatal(err)
	}
	if u, _ := r.Get(ctx, "usr_1"); u.Name != "" {
		t.Fatal("failed update must not be stored")
	}
}

func TestMemoryInvoicesUpdateIsAtomic(t *testing.T) {
	r := NewMemoryInvoices()
	if err := r.Create(ctx, billing.Invoice{ID: "inv_1", TotalCents: 1000}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = r.Update(ctx, "inv_1", func(inv *billing.Invoice) error {
				inv.PaidCents += 10
				return nil
			})
		}()
	}
	wg.Wait()
	inv, _ := r.Get(ctx, "inv_1")
	if inv.PaidCents != 500 {
		t.Fatalf("paid = %d, want 500", inv.PaidCents)
	}
}

func TestMemoryInvoicesListAndNumbers(t *testing.T) {
	r := NewMemoryInvoices()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i, c := range []string{"usr_a", "usr_b", "usr_a"} {
		n, _ := r.NextNumber(ctx)
		_ = r.Create(ctx, billing.Invoice{ID: n, Number: n, CustomerID: c, Status: billing.InvoiceDraft, CreatedAt: base.Add(time.Duration(i) * time.Hour)})
	}
	got, _ := r.List(ctx, InvoiceFilter{CustomerID: "usr_a"})
	if len(got) != 2 || got[0].Number != "INV-000003" {
		t.Fatalf("list = %+v", got)
	}
	got, _ = r.List(ctx, InvoiceFilter{Status: billing.InvoicePaid})
	if len(got) != 0 {
		t.Fatalf("status filter = %+v", got)
	}
}

func TestMemoryAudit(t *testing.T) {
	r := NewMemoryAudit()
	meta := map[string]string{"k": "v"}
	_ = r.Append(ctx, audit.Event{ID: "1", Action: "a", Metadata: meta})
	_ = r.Append(ctx, audit.Event{ID: "2", Action: "b"})
	meta["k"] = "mutated"
	got, _ := r.List(ctx, audit.Filter{Action: "a"})
	if len(got) != 1 || got[0].Metadata["k"] != "v" {
		t.Fatalf("got %+v", got)
	}
}

func TestFileFlagsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "flags.json")
	ff, err := OpenFileFlags(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := ff.Put(ctx, flags.Flag{Key: "b", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := ff.Put(ctx, flags.Flag{Key: "a", RolloutPercent: 10}); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenFileFlags(path)
	if err != nil {
		t.Fatal(err)
	}
	list, _ := reopened.List(ctx)
	if len(list) != 2 || list[0].Key != "a" || !list[1].Enabled {
		t.Fatalf("list = %+v", list)
	}
	if _, err := reopened.Get(ctx, "zzz"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}
