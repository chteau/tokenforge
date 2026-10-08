// Package notifications sends transactional e-mail and SMS messages.
// Delivery providers are abstracted behind the EmailSender and SMSSender
// interfaces; the fakes in this package are used in tests and local runs.
package notifications

import (
	"context"
	"errors"
	"log/slog"
	"sync"
)

// Email is an outgoing e-mail.
type Email struct {
	To      string
	Subject string
	Body    string
}

// SMS is an outgoing text message.
type SMS struct {
	To   string
	Body string
}

// EmailSender delivers e-mail.
type EmailSender interface {
	SendEmail(ctx context.Context, msg Email) error
}

// SMSSender delivers text messages.
type SMSSender interface {
	SendSMS(ctx context.Context, msg SMS) error
}

// ErrDeliveryFailed is returned by the fakes when told to fail.
var ErrDeliveryFailed = errors.New("notifications: delivery failed")

// FakeEmailSender records messages in memory. It is safe for concurrent use.
type FakeEmailSender struct {
	mu       sync.Mutex
	sent     []Email
	failNext int
}

// SendEmail records msg, or fails if FailNext was called.
func (f *FakeEmailSender) SendEmail(_ context.Context, msg Email) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext > 0 {
		f.failNext--
		return ErrDeliveryFailed
	}
	f.sent = append(f.sent, msg)
	return nil
}

// FailNext makes the next n sends fail.
func (f *FakeEmailSender) FailNext(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failNext = n
}

// Sent returns a copy of the delivered messages.
func (f *FakeEmailSender) Sent() []Email {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Email(nil), f.sent...)
}

// FakeSMSSender records messages in memory. It is safe for concurrent use.
type FakeSMSSender struct {
	mu       sync.Mutex
	sent     []SMS
	failNext int
}

// SendSMS records msg, or fails if FailNext was called.
func (f *FakeSMSSender) SendSMS(_ context.Context, msg SMS) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext > 0 {
		f.failNext--
		return ErrDeliveryFailed
	}
	f.sent = append(f.sent, msg)
	return nil
}

// FailNext makes the next n sends fail.
func (f *FakeSMSSender) FailNext(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failNext = n
}

// Sent returns a copy of the delivered messages.
func (f *FakeSMSSender) Sent() []SMS {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]SMS(nil), f.sent...)
}

// LogSender writes messages to a structured logger instead of delivering
// them. It is the default in local development.
type LogSender struct {
	Logger *slog.Logger
}

// SendEmail logs msg.
func (l LogSender) SendEmail(ctx context.Context, msg Email) error {
	l.Logger.InfoContext(ctx, "email", "to", msg.To, "subject", msg.Subject)
	return nil
}

// SendSMS logs msg.
func (l LogSender) SendSMS(ctx context.Context, msg SMS) error {
	l.Logger.InfoContext(ctx, "sms", "to", msg.To, "chars", len(msg.Body))
	return nil
}
