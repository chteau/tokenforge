// Package clock provides an injectable source of time. Production code must
// obtain the current time from a Clock instead of calling time.Now directly,
// so that time-dependent behaviour can be tested deterministically.
package clock

import (
	"sync"
	"time"
)

// Clock reports the current time.
type Clock interface {
	Now() time.Time
}

// Real is the wall clock. Times are returned in UTC.
type Real struct{}

// Now returns the current UTC time.
func (Real) Now() time.Time { return time.Now().UTC() }

// Fake is a manually controlled clock for tests.
type Fake struct {
	mu  sync.Mutex
	now time.Time
}

// NewFake returns a fake clock set to t.
func NewFake(t time.Time) *Fake { return &Fake{now: t} }

// Now returns the fake's current time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// Set moves the clock to t.
func (f *Fake) Set(t time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = t
}

// Advance moves the clock forward by d.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}
