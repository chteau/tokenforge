package services

import (
	"context"
	"log/slog"
	"maps"

	"github.com/acme/meridian/internal/notifications"
	"github.com/acme/meridian/internal/repositories"
)

// Notifier sends templated transactional messages to users. Delivery is best
// effort: failures are logged and never fail the calling operation.
type Notifier struct {
	users     repositories.UserRepository
	email     notifications.EmailSender
	sms       notifications.SMSSender
	templates *notifications.Templates
	logger    *slog.Logger
}

// NewNotifier returns a Notifier.
func NewNotifier(users repositories.UserRepository, email notifications.EmailSender, sms notifications.SMSSender, templates *notifications.Templates, logger *slog.Logger) *Notifier {
	return &Notifier{users: users, email: email, sms: sms, templates: templates, logger: logger}
}

// NotifyUser e-mails userID using the named template. Name and Email are
// added to data automatically.
func (n *Notifier) NotifyUser(ctx context.Context, userID, template string, data map[string]string) {
	u, err := n.users.Get(ctx, userID)
	if err != nil {
		n.logger.WarnContext(ctx, "notify: user lookup failed", "user_id", userID, "template", template, "err", err)
		return
	}
	d := maps.Clone(data)
	if d == nil {
		d = map[string]string{}
	}
	d["Name"] = u.DisplayName()
	d["Email"] = u.Email
	subject, body, err := n.templates.Render(template, d)
	if err != nil {
		n.logger.ErrorContext(ctx, "notify: render failed", "template", template, "err", err)
		return
	}
	if err := n.email.SendEmail(ctx, notifications.Email{To: u.Email, Subject: subject, Body: body}); err != nil {
		n.logger.WarnContext(ctx, "notify: email delivery failed", "user_id", userID, "template", template, "err", err)
	}
}

// TextUser sends an SMS to userID if they have a phone number on file.
func (n *Notifier) TextUser(ctx context.Context, userID, body string) {
	u, err := n.users.Get(ctx, userID)
	if err != nil || u.Phone == "" {
		return
	}
	if err := n.sms.SendSMS(ctx, notifications.SMS{To: u.Phone, Body: body}); err != nil {
		n.logger.WarnContext(ctx, "notify: sms delivery failed", "user_id", userID, "err", err)
	}
}
