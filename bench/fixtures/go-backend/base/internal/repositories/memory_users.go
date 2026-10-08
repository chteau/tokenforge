package repositories

import (
	"context"
	"slices"
	"strings"
	"sync"

	"github.com/acme/meridian/internal/users"
)

// MemoryUsers is an in-memory UserRepository.
type MemoryUsers struct {
	mu      sync.RWMutex
	byID    map[string]users.User
	byEmail map[string]string
}

// NewMemoryUsers returns an empty repository.
func NewMemoryUsers() *MemoryUsers {
	return &MemoryUsers{byID: map[string]users.User{}, byEmail: map[string]string{}}
}

func (m *MemoryUsers) Create(_ context.Context, u users.User) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.byID[u.ID]; ok {
		return ErrDuplicate
	}
	if _, ok := m.byEmail[u.Email]; ok {
		return ErrDuplicate
	}
	m.byID[u.ID] = u
	m.byEmail[u.Email] = u.ID
	return nil
}

func (m *MemoryUsers) Get(_ context.Context, id string) (users.User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	u, ok := m.byID[id]
	if !ok {
		return users.User{}, ErrNotFound
	}
	return u, nil
}

func (m *MemoryUsers) GetByEmail(_ context.Context, email string) (users.User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	id, ok := m.byEmail[email]
	if !ok {
		return users.User{}, ErrNotFound
	}
	return m.byID[id], nil
}

func (m *MemoryUsers) Update(_ context.Context, id string, fn func(*users.User) error) (users.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.byID[id]
	if !ok {
		return users.User{}, ErrNotFound
	}
	oldEmail := u.Email
	if err := fn(&u); err != nil {
		return users.User{}, err
	}
	u.ID = id
	if u.Email != oldEmail {
		if _, taken := m.byEmail[u.Email]; taken {
			return users.User{}, ErrDuplicate
		}
		delete(m.byEmail, oldEmail)
		m.byEmail[u.Email] = id
	}
	m.byID[id] = u
	return u, nil
}

func (m *MemoryUsers) List(_ context.Context) ([]users.User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]users.User, 0, len(m.byID))
	for _, u := range m.byID {
		out = append(out, u)
	}
	slices.SortFunc(out, func(a, b users.User) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out, nil
}
