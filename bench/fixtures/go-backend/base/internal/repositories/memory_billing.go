package repositories

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/acme/meridian/internal/billing"
)

// MemoryPlans is an in-memory PlanRepository.
type MemoryPlans struct {
	mu    sync.RWMutex
	plans map[string]billing.Plan
}

// NewMemoryPlans returns an empty repository.
func NewMemoryPlans() *MemoryPlans { return &MemoryPlans{plans: map[string]billing.Plan{}} }

func (m *MemoryPlans) Create(_ context.Context, p billing.Plan) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.plans {
		if existing.ID == p.ID || existing.Code == p.Code {
			return ErrDuplicate
		}
	}
	m.plans[p.ID] = p
	return nil
}

func (m *MemoryPlans) Get(_ context.Context, id string) (billing.Plan, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.plans[id]
	if !ok {
		return billing.Plan{}, ErrNotFound
	}
	return p, nil
}

func (m *MemoryPlans) GetByCode(_ context.Context, code string) (billing.Plan, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, p := range m.plans {
		if p.Code == code {
			return p, nil
		}
	}
	return billing.Plan{}, ErrNotFound
}

func (m *MemoryPlans) List(_ context.Context) ([]billing.Plan, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]billing.Plan, 0, len(m.plans))
	for _, p := range m.plans {
		out = append(out, p)
	}
	slices.SortFunc(out, func(a, b billing.Plan) int {
		if a.PriceCents != b.PriceCents {
			return int(a.PriceCents - b.PriceCents)
		}
		return strings.Compare(a.Code, b.Code)
	})
	return out, nil
}

// MemorySubscriptions is an in-memory SubscriptionRepository.
type MemorySubscriptions struct {
	mu   sync.RWMutex
	subs map[string]billing.Subscription
}

// NewMemorySubscriptions returns an empty repository.
func NewMemorySubscriptions() *MemorySubscriptions {
	return &MemorySubscriptions{subs: map[string]billing.Subscription{}}
}

func (m *MemorySubscriptions) Create(_ context.Context, s billing.Subscription) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.subs[s.ID]; ok {
		return ErrDuplicate
	}
	m.subs[s.ID] = s
	return nil
}

func (m *MemorySubscriptions) Get(_ context.Context, id string) (billing.Subscription, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.subs[id]
	if !ok {
		return billing.Subscription{}, ErrNotFound
	}
	return s, nil
}

func (m *MemorySubscriptions) Update(_ context.Context, id string, fn func(*billing.Subscription) error) (billing.Subscription, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.subs[id]
	if !ok {
		return billing.Subscription{}, ErrNotFound
	}
	if err := fn(&s); err != nil {
		return billing.Subscription{}, err
	}
	s.ID = id
	m.subs[id] = s
	return s, nil
}

func (m *MemorySubscriptions) ListByCustomer(_ context.Context, customerID string) ([]billing.Subscription, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []billing.Subscription
	for _, s := range m.subs {
		if s.CustomerID == customerID {
			out = append(out, s)
		}
	}
	slices.SortFunc(out, func(a, b billing.Subscription) int { return a.StartedAt.Compare(b.StartedAt) })
	return out, nil
}

// MemoryInvoices is an in-memory InvoiceRepository.
type MemoryInvoices struct {
	mu       sync.RWMutex
	invoices map[string]billing.Invoice
	seq      int
}

// NewMemoryInvoices returns an empty repository.
func NewMemoryInvoices() *MemoryInvoices {
	return &MemoryInvoices{invoices: map[string]billing.Invoice{}}
}

func (m *MemoryInvoices) Create(_ context.Context, inv billing.Invoice) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.invoices[inv.ID]; ok {
		return ErrDuplicate
	}
	m.invoices[inv.ID] = inv.Clone()
	return nil
}

func (m *MemoryInvoices) Get(_ context.Context, id string) (billing.Invoice, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	inv, ok := m.invoices[id]
	if !ok {
		return billing.Invoice{}, ErrNotFound
	}
	return inv.Clone(), nil
}

func (m *MemoryInvoices) Update(_ context.Context, id string, fn func(*billing.Invoice) error) (billing.Invoice, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.invoices[id]
	if !ok {
		return billing.Invoice{}, ErrNotFound
	}
	inv := cur.Clone()
	if err := fn(&inv); err != nil {
		return billing.Invoice{}, err
	}
	inv.ID = id
	m.invoices[id] = inv.Clone()
	return inv, nil
}

func (m *MemoryInvoices) List(_ context.Context, f InvoiceFilter) ([]billing.Invoice, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []billing.Invoice
	for _, inv := range m.invoices {
		if f.CustomerID != "" && inv.CustomerID != f.CustomerID {
			continue
		}
		if f.Status != "" && inv.Status != f.Status {
			continue
		}
		out = append(out, inv.Clone())
	}
	slices.SortFunc(out, func(a, b billing.Invoice) int {
		if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(b.Number, a.Number)
	})
	return out, nil
}

func (m *MemoryInvoices) NextNumber(_ context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	return fmt.Sprintf("INV-%06d", m.seq), nil
}

// MemoryPayments is an in-memory PaymentRepository.
type MemoryPayments struct {
	mu       sync.RWMutex
	payments []billing.Payment
}

// NewMemoryPayments returns an empty repository.
func NewMemoryPayments() *MemoryPayments { return &MemoryPayments{} }

func (m *MemoryPayments) Create(_ context.Context, p billing.Payment) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.payments = append(m.payments, p)
	return nil
}

func (m *MemoryPayments) ListByInvoice(_ context.Context, invoiceID string) ([]billing.Payment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []billing.Payment
	for _, p := range m.payments {
		if p.InvoiceID == invoiceID {
			out = append(out, p)
		}
	}
	return out, nil
}
