package repositories

import (
	"context"
	"maps"
	"sync"

	"github.com/acme/meridian/internal/audit"
)

// MemoryAudit is an in-memory AuditRepository. Events are kept in insertion order.
type MemoryAudit struct {
	mu     sync.RWMutex
	events []audit.Event
}

// NewMemoryAudit returns an empty audit log.
func NewMemoryAudit() *MemoryAudit { return &MemoryAudit{} }

func (m *MemoryAudit) Append(_ context.Context, e audit.Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e.Metadata = maps.Clone(e.Metadata)
	m.events = append(m.events, e)
	return nil
}

func (m *MemoryAudit) List(_ context.Context, f audit.Filter) ([]audit.Event, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []audit.Event
	for _, e := range m.events {
		if f.Matches(e) {
			e.Metadata = maps.Clone(e.Metadata)
			out = append(out, e)
		}
	}
	return out, nil
}
