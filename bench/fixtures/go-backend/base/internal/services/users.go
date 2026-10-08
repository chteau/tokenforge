package services

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/acme/meridian/internal/apperr"
	"github.com/acme/meridian/internal/audit"
	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/notifications"
	"github.com/acme/meridian/internal/repositories"
	"github.com/acme/meridian/internal/users"
	"github.com/acme/meridian/internal/validation"
	"github.com/acme/meridian/pkg/ids"
	"github.com/acme/meridian/pkg/pagination"
)

var errUserNotFound = apperr.NotFound("user_not_found", "user not found")

// UserService manages accounts.
type UserService struct {
	users    repositories.UserRepository
	audit    *AuditService
	notifier *Notifier
	clock    clock.Clock
}

// NewUserService returns a UserService.
func NewUserService(repo repositories.UserRepository, auditSvc *AuditService, notifier *Notifier, clk clock.Clock) *UserService {
	return &UserService{users: repo, audit: auditSvc, notifier: notifier, clock: clk}
}

// RegisterInput is the payload for self-service sign-up.
type RegisterInput struct {
	Email    string `json:"email"`
	Name     string `json:"name"`
	Password string `json:"password"`
	Phone    string `json:"phone"`
}

// Register creates a regular user account.
func (s *UserService) Register(ctx context.Context, in RegisterInput) (users.User, error) {
	email := users.NormalizeEmail(in.Email)
	v := validation.New()
	v.Required("email", email)
	v.Email("email", email)
	v.Required("name", in.Name)
	v.MaxLen("name", in.Name, 100)
	v.MinLen("password", in.Password, 10)
	v.MaxLen("password", in.Password, 128)
	v.Phone("phone", in.Phone)
	if err := v.Err(); err != nil {
		return users.User{}, err
	}
	return s.create(ctx, email, strings.TrimSpace(in.Name), in.Password, in.Phone, auth.RoleUser)
}

func (s *UserService) create(ctx context.Context, email, name, password, phone string, role auth.Role) (users.User, error) {
	hash, err := auth.HashPassword(password)
	if err != nil {
		return users.User{}, err
	}
	now := s.clock.Now()
	u := users.User{
		ID: ids.New("usr"), Email: email, Name: name, Phone: phone, Role: role,
		PasswordHash: hash, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.users.Create(ctx, u); err != nil {
		if errors.Is(err, repositories.ErrDuplicate) {
			return users.User{}, apperr.Conflict("email_taken", "an account with this email already exists")
		}
		return users.User{}, err
	}
	if err := s.audit.Record(ctx, u.ID, audit.ActionUserRegistered, "user", u.ID, map[string]string{"role": string(role)}); err != nil {
		return users.User{}, err
	}
	s.notifier.NotifyUser(ctx, u.ID, notifications.TemplateWelcome, nil)
	return u, nil
}

// EnsureAdmin creates an admin account with the given credentials unless an
// account with that e-mail already exists. Used to bootstrap a deployment.
func (s *UserService) EnsureAdmin(ctx context.Context, email, password string) (users.User, error) {
	email = users.NormalizeEmail(email)
	if u, err := s.users.GetByEmail(ctx, email); err == nil {
		return u, nil
	}
	v := validation.New()
	v.Email("email", email)
	v.MinLen("password", password, 10)
	if err := v.Err(); err != nil {
		return users.User{}, err
	}
	return s.create(ctx, email, "Administrator", password, "", auth.RoleAdmin)
}

// Authenticate checks credentials. Unknown e-mail, wrong password and
// disabled accounts all produce the same error.
func (s *UserService) Authenticate(ctx context.Context, email, password string) (users.User, error) {
	invalid := apperr.Unauthorized("invalid_credentials", "email or password is incorrect")
	u, err := s.users.GetByEmail(ctx, users.NormalizeEmail(email))
	if errors.Is(err, repositories.ErrNotFound) {
		return users.User{}, invalid
	}
	if err != nil {
		return users.User{}, err
	}
	if !auth.CheckPassword(u.PasswordHash, password) || u.Disabled {
		return users.User{}, invalid
	}
	return u, nil
}

// Get returns a user. Users can read themselves; admins can read anyone.
func (s *UserService) Get(ctx context.Context, p auth.Principal, id string) (users.User, error) {
	if p.UserID != id && !p.Is(auth.RoleAdmin) {
		return users.User{}, errUserNotFound
	}
	u, err := s.users.Get(ctx, id)
	if err != nil {
		return users.User{}, mapNotFound(err, errUserNotFound)
	}
	return u, nil
}

// UpdateProfileInput holds optional profile changes; nil fields are left alone.
type UpdateProfileInput struct {
	Name  *string `json:"name"`
	Phone *string `json:"phone"`
}

// UpdateProfile changes the caller's own profile.
func (s *UserService) UpdateProfile(ctx context.Context, p auth.Principal, in UpdateProfileInput) (users.User, error) {
	v := validation.New()
	if in.Name != nil {
		v.Required("name", *in.Name)
		v.MaxLen("name", *in.Name, 100)
	}
	if in.Phone != nil {
		v.Phone("phone", *in.Phone)
	}
	if err := v.Err(); err != nil {
		return users.User{}, err
	}
	u, err := s.users.Update(ctx, p.UserID, func(u *users.User) error {
		if in.Name != nil {
			u.Name = strings.TrimSpace(*in.Name)
		}
		if in.Phone != nil {
			u.Phone = *in.Phone
		}
		u.UpdatedAt = s.clock.Now()
		return nil
	})
	if err != nil {
		return users.User{}, mapNotFound(err, errUserNotFound)
	}
	return u, nil
}

// SetRole changes a user's role. Admins only; admins cannot change their own role.
func (s *UserService) SetRole(ctx context.Context, p auth.Principal, id string, role auth.Role) (users.User, error) {
	if err := requireRole(p, auth.RoleAdmin); err != nil {
		return users.User{}, err
	}
	if !role.Valid() {
		return users.User{}, apperr.Invalid("validation_failed", "one or more fields are invalid", map[string]string{"role": "must be one of user, billing_admin, admin"})
	}
	if id == p.UserID {
		return users.User{}, apperr.Conflict("cannot_change_own_role", "you cannot change your own role")
	}
	var old auth.Role
	u, err := s.users.Update(ctx, id, func(u *users.User) error {
		old = u.Role
		u.Role = role
		u.UpdatedAt = s.clock.Now()
		return nil
	})
	if err != nil {
		return users.User{}, mapNotFound(err, errUserNotFound)
	}
	if err := s.audit.Record(ctx, p.UserID, audit.ActionUserRoleChanged, "user", id, map[string]string{"from": string(old), "to": string(role)}); err != nil {
		return users.User{}, err
	}
	return u, nil
}

// List returns all users. Admins only.
func (s *UserService) List(ctx context.Context, p auth.Principal, page pagination.Params) (pagination.Page[users.User], error) {
	if err := requireRole(p, auth.RoleAdmin); err != nil {
		return pagination.Page[users.User]{}, err
	}
	all, err := s.users.List(ctx)
	if err != nil {
		return pagination.Page[users.User]{}, err
	}
	return pagination.Slice(all, page), nil
}

// AuthService issues session tokens.
type AuthService struct {
	users  *UserService
	issuer *auth.Issuer
	audit  *AuditService
}

// NewAuthService returns an AuthService.
func NewAuthService(usersSvc *UserService, issuer *auth.Issuer, auditSvc *AuditService) *AuthService {
	return &AuthService{users: usersSvc, issuer: issuer, audit: auditSvc}
}

// Session is the result of a successful login.
type Session struct {
	Token     string     `json:"token"`
	ExpiresAt time.Time  `json:"expires_at"`
	User      users.User `json:"user"`
}

// Login authenticates the credentials and returns a bearer token.
func (s *AuthService) Login(ctx context.Context, email, password string) (Session, error) {
	u, err := s.users.Authenticate(ctx, email, password)
	if err != nil {
		return Session{}, err
	}
	tok, exp, err := s.issuer.Issue(u.ID, u.Role)
	if err != nil {
		return Session{}, err
	}
	if err := s.audit.Record(ctx, u.ID, audit.ActionUserLogin, "user", u.ID, nil); err != nil {
		return Session{}, err
	}
	return Session{Token: tok, ExpiresAt: exp, User: u}, nil
}
