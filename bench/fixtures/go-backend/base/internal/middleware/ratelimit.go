package middleware

import (
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/pkg/httpx"
)

// RateLimiter is a per-key token bucket limiter.
type RateLimiter struct {
	mu      sync.Mutex
	clock   clock.Clock
	rate    float64 // tokens per second
	burst   float64
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewRateLimiter allows perMinute requests per key with the given burst.
func NewRateLimiter(clk clock.Clock, perMinute, burst int) *RateLimiter {
	return &RateLimiter{clock: clk, rate: float64(perMinute) / 60, burst: float64(burst), buckets: map[string]*bucket{}}
}

// Allow consumes a token for key. When the bucket is empty it returns false
// and how long the caller should wait.
func (l *RateLimiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.clock.Now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
	return false, wait
}

// Sweep drops buckets that have been idle long enough to be full again.
func (l *RateLimiter) Sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	full := time.Duration(l.burst / l.rate * float64(time.Second))
	now := l.clock.Now()
	for k, b := range l.buckets {
		if now.Sub(b.last) > full {
			delete(l.buckets, k)
		}
	}
}

// RateLimit rejects requests over the limit with 429, keyed by client IP.
func RateLimit(l *RateLimiter, trustProxy bool) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ok, wait := l.Allow(httpx.ClientIP(r, trustProxy))
			if !ok {
				w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
				httpx.WriteError(w, http.StatusTooManyRequests, httpx.ErrorDetail{Code: "rate_limited", Message: "too many requests"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
