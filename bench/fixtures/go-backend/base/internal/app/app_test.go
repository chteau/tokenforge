package app_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/acme/meridian/internal/app"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/notifications"
)

const (
	adminEmail    = "root@example.com"
	adminPassword = "super-secret-admin"
)

type testEnv struct {
	t     *testing.T
	app   *app.App
	srv   *httptest.Server
	clock *clock.Fake
	email *notifications.FakeEmailSender
	admin string // admin bearer token
}

func newTestEnv(t *testing.T, mutate ...func(*app.Config)) *testEnv {
	t.Helper()
	env := &testEnv{
		t:     t,
		clock: clock.NewFake(time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC)),
		email: &notifications.FakeEmailSender{},
	}
	cfg := app.Config{
		TokenSecret:            []byte("test-secret-test-secret-test-secret"),
		Clock:                  env.clock,
		Email:                  env.email,
		SMS:                    &notifications.FakeSMSSender{},
		BootstrapAdminEmail:    adminEmail,
		BootstrapAdminPassword: adminPassword,
	}
	for _, m := range mutate {
		m(&cfg)
	}
	a, err := app.New(cfg)
	if err != nil {
		t.Fatalf("app.New: %v", err)
	}
	env.app = a
	env.srv = httptest.NewServer(a.Handler)
	t.Cleanup(env.srv.Close)
	env.admin = env.login(adminEmail, adminPassword)
	return env
}

type response struct {
	status int
	body   map[string]any
	raw    string
}

func (e *testEnv) do(method, path, token string, body any) response {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, rd)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := e.srv.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := response{status: res.StatusCode, raw: string(raw)}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

func (e *testEnv) expect(r response, status int) response {
	e.t.Helper()
	if r.status != status {
		e.t.Fatalf("status = %d, want %d; body: %s", r.status, status, r.raw)
	}
	return r
}

func (e *testEnv) register(email string) string {
	e.t.Helper()
	r := e.expect(e.do("POST", "/v1/auth/register", "", map[string]string{
		"email": email, "name": strings.Split(email, "@")[0], "password": "password-123",
	}), http.StatusCreated)
	return r.body["id"].(string)
}

func (e *testEnv) login(email, password string) string {
	e.t.Helper()
	r := e.expect(e.do("POST", "/v1/auth/login", "", map[string]string{"email": email, "password": password}), http.StatusOK)
	return r.body["token"].(string)
}

// user registers an account, optionally promotes it, and returns (id, token).
func (e *testEnv) user(email, role string) (string, string) {
	e.t.Helper()
	id := e.register(email)
	if role != "" && role != "user" {
		e.expect(e.do("PATCH", "/v1/admin/users/"+id+"/role", e.admin, map[string]string{"role": role}), http.StatusOK)
	}
	return id, e.login(email, "password-123")
}

func (e *testEnv) createInvoice(token, customerID string, unitCents int64) string {
	e.t.Helper()
	r := e.expect(e.do("POST", "/v1/invoices", token, map[string]any{
		"customer_id": customerID, "currency": "EUR", "tax_rate_bps": 2000,
		"lines": []map[string]any{{"description": "Pro seats", "quantity": 2, "unit_cents": unitCents}},
	}), http.StatusCreated)
	return r.body["id"].(string)
}

func errCode(r response) string {
	m, _ := r.body["error"].(map[string]any)
	s, _ := m["code"].(string)
	return s
}

func TestHealthAndUnknownRoute(t *testing.T) {
	e := newTestEnv(t)
	e.expect(e.do("GET", "/healthz", "", nil), http.StatusOK)
	r := e.expect(e.do("GET", "/v1/nope", "", nil), http.StatusNotFound)
	if errCode(r) != "route_not_found" {
		t.Fatalf("body = %s", r.raw)
	}
}

func TestRegisterLoginAndProfile(t *testing.T) {
	e := newTestEnv(t)
	id, tok := e.user("ada@example.com", "")

	me := e.expect(e.do("GET", "/v1/me", tok, nil), http.StatusOK)
	if me.body["id"] != id || me.body["role"] != "user" {
		t.Fatalf("me = %s", me.raw)
	}
	if strings.Contains(me.raw, "password") {
		t.Fatalf("password hash leaked: %s", me.raw)
	}
	upd := e.expect(e.do("PATCH", "/v1/me", tok, map[string]string{"phone": "+447700900123"}), http.StatusOK)
	if upd.body["phone"] != "+447700900123" {
		t.Fatalf("update = %s", upd.raw)
	}
	if len(e.email.Sent()) == 0 || !strings.Contains(e.email.Sent()[0].Subject, "Welcome") {
		t.Fatalf("welcome email not sent: %+v", e.email.Sent())
	}

	r := e.expect(e.do("POST", "/v1/auth/login", "", map[string]string{"email": "ada@example.com", "password": "wrong-password"}), http.StatusUnauthorized)
	if errCode(r) != "invalid_credentials" {
		t.Fatalf("body = %s", r.raw)
	}
	e.expect(e.do("POST", "/v1/auth/register", "", map[string]string{"email": "ADA@example.com", "name": "Ada", "password": "password-123"}), http.StatusConflict)
	e.expect(e.do("GET", "/v1/me", "", nil), http.StatusUnauthorized)
}

func TestRegisterValidation(t *testing.T) {
	e := newTestEnv(t)
	tests := []struct {
		name   string
		body   string
		status int
		field  string
	}{
		{"bad email", `{"email":"nope","name":"x","password":"password-123"}`, 422, "email"},
		{"short password", `{"email":"a@example.com","name":"x","password":"short"}`, 422, "password"},
		{"missing name", `{"email":"a@example.com","password":"password-123"}`, 422, "name"},
		{"bad phone", `{"email":"a@example.com","name":"x","password":"password-123","phone":"12"}`, 422, "phone"},
		{"unknown field", `{"email":"a@example.com","admin":true}`, 400, ""},
		{"malformed", `{"email":`, 400, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := http.Post(e.srv.URL+"/v1/auth/register", "application/json", strings.NewReader(tt.body))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			var body struct {
				Error struct {
					Fields map[string]string `json:"fields"`
				} `json:"error"`
			}
			_ = json.NewDecoder(res.Body).Decode(&body)
			if res.StatusCode != tt.status {
				t.Fatalf("status = %d, want %d", res.StatusCode, tt.status)
			}
			if tt.field != "" && body.Error.Fields[tt.field] == "" {
				t.Fatalf("fields = %v, want %q", body.Error.Fields, tt.field)
			}
		})
	}
}

func TestInvoiceLifecycle(t *testing.T) {
	e := newTestEnv(t)
	custID, custTok := e.user("customer@example.com", "")
	_, billTok := e.user("billing@example.com", "billing_admin")

	invID := e.createInvoice(billTok, custID, 5000)
	inv := e.expect(e.do("GET", "/v1/invoices/"+invID, custTok, nil), http.StatusOK)
	if inv.body["status"] != "draft" || inv.body["total_cents"] != float64(12000) || inv.body["number"] != "INV-000001" {
		t.Fatalf("invoice = %s", inv.raw)
	}

	e.expect(e.do("POST", "/v1/invoices/"+invID+"/payments", billTok, map[string]any{"amount_cents": 100, "method": "card"}), http.StatusConflict)

	issued := e.expect(e.do("POST", "/v1/invoices/"+invID+"/issue", billTok, nil), http.StatusOK)
	if issued.body["status"] != "open" || issued.body["due_at"] != "2026-04-01T09:00:00Z" {
		t.Fatalf("issued = %s", issued.raw)
	}
	e.expect(e.do("POST", "/v1/invoices/"+invID+"/issue", billTok, nil), http.StatusConflict)

	over := e.expect(e.do("POST", "/v1/invoices/"+invID+"/payments", billTok, map[string]any{"amount_cents": 12001, "method": "card"}), http.StatusUnprocessableEntity)
	if errCode(over) != "amount_exceeds_outstanding" {
		t.Fatalf("over = %s", over.raw)
	}
	e.expect(e.do("POST", "/v1/invoices/"+invID+"/payments", billTok, map[string]any{"amount_cents": 2000, "method": "bank_transfer"}), http.StatusCreated)
	e.clock.Advance(2 * time.Hour)
	e.expect(e.do("POST", "/v1/invoices/"+invID+"/payments", billTok, map[string]any{"amount_cents": 10000, "method": "card"}), http.StatusCreated)

	paid := e.expect(e.do("GET", "/v1/invoices/"+invID, custTok, nil), http.StatusOK)
	if paid.body["status"] != "paid" || paid.body["paid_cents"] != float64(12000) || paid.body["paid_at"] != "2026-03-02T11:00:00Z" {
		t.Fatalf("paid = %s", paid.raw)
	}
	pays := e.expect(e.do("GET", "/v1/invoices/"+invID+"/payments", custTok, nil), http.StatusOK)
	if items := pays.body["items"].([]any); len(items) != 2 {
		t.Fatalf("payments = %s", pays.raw)
	}
	e.expect(e.do("POST", "/v1/invoices/"+invID+"/void", billTok, nil), http.StatusConflict)

	var subjects []string
	for _, m := range e.email.Sent() {
		if m.To == "customer@example.com" {
			subjects = append(subjects, m.Subject)
		}
	}
	want := []string{"Welcome to Meridian, customer", "Invoice INV-000001 is ready", "Payment received for invoice INV-000001", "Payment received for invoice INV-000001"}
	if fmt.Sprint(subjects) != fmt.Sprint(want) {
		t.Fatalf("emails = %q", subjects)
	}

	audit := e.expect(e.do("GET", "/v1/admin/audit?target_id="+invID, e.admin, nil), http.StatusOK)
	if audit.body["total"] != float64(4) {
		t.Fatalf("audit = %s", audit.raw)
	}
}

func TestInvoiceAuthorization(t *testing.T) {
	e := newTestEnv(t)
	custID, custTok := e.user("customer@example.com", "")
	_, otherTok := e.user("other@example.com", "")
	_, billTok := e.user("billing@example.com", "billing_admin")
	invID := e.createInvoice(billTok, custID, 1000)

	tests := []struct {
		name   string
		method string
		path   string
		token  string
		body   any
		status int
	}{
		{"anonymous get", "GET", "/v1/invoices/" + invID, "", nil, 401},
		{"stranger get", "GET", "/v1/invoices/" + invID, otherTok, nil, 404},
		{"stranger issue", "POST", "/v1/invoices/" + invID + "/issue", otherTok, nil, 404},
		{"owner issue", "POST", "/v1/invoices/" + invID + "/issue", custTok, nil, 403},
		{"owner void", "POST", "/v1/invoices/" + invID + "/void", custTok, nil, 403},
		{"stranger payments", "GET", "/v1/invoices/" + invID + "/payments", otherTok, nil, 404},
		{"customer creates invoice", "POST", "/v1/invoices", custTok, map[string]any{"customer_id": custID}, 403},
		{"missing invoice", "GET", "/v1/invoices/inv_missing", billTok, nil, 404},
		{"admin can read", "GET", "/v1/invoices/" + invID, e.admin, nil, 200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e.expect(e.do(tt.method, tt.path, tt.token, tt.body), tt.status)
		})
	}

	list := e.expect(e.do("GET", "/v1/invoices?customer_id="+custID, otherTok, nil), http.StatusOK)
	if list.body["total"] != float64(0) {
		t.Fatalf("stranger listing leaked invoices: %s", list.raw)
	}
	list = e.expect(e.do("GET", "/v1/invoices", custTok, nil), http.StatusOK)
	if list.body["total"] != float64(1) {
		t.Fatalf("owner listing = %s", list.raw)
	}
}

func TestCreateInvoiceValidation(t *testing.T) {
	e := newTestEnv(t)
	custID, _ := e.user("customer@example.com", "")
	_, billTok := e.user("billing@example.com", "billing_admin")
	r := e.expect(e.do("POST", "/v1/invoices", billTok, map[string]any{
		"customer_id": "usr_missing", "currency": "JPY", "lines": []map[string]any{{"description": "", "quantity": 0, "unit_cents": 1}},
	}), http.StatusUnprocessableEntity)
	fields := r.body["error"].(map[string]any)["fields"].(map[string]any)
	for _, f := range []string{"currency", "lines[0].description", "lines[0].quantity"} {
		if fields[f] == nil {
			t.Errorf("missing field error %q in %s", f, r.raw)
		}
	}
	r = e.expect(e.do("POST", "/v1/invoices", billTok, map[string]any{
		"customer_id": "usr_missing", "currency": "EUR", "lines": []map[string]any{{"description": "x", "quantity": 1, "unit_cents": 1}},
	}), http.StatusUnprocessableEntity)
	if !strings.Contains(r.raw, "customer_id") {
		t.Fatalf("body = %s", r.raw)
	}
	_ = custID
}

func TestSubscriptions(t *testing.T) {
	e := newTestEnv(t)
	e.expect(e.do("POST", "/v1/admin/plans", e.admin, map[string]any{
		"code": "pro", "name": "Pro", "price_cents": 4900, "currency": "EUR", "interval": "month",
	}), http.StatusCreated)
	plans := e.expect(e.do("GET", "/v1/plans", "", nil), http.StatusOK)
	if len(plans.body["items"].([]any)) != 1 {
		t.Fatalf("plans = %s", plans.raw)
	}

	_, tok := e.user("sub@example.com", "")
	r := e.expect(e.do("POST", "/v1/subscriptions", tok, map[string]string{"plan_code": "pro"}), http.StatusCreated)
	inv := r.body["invoice"].(map[string]any)
	if inv["status"] != "open" || inv["total_cents"] != float64(4900) {
		t.Fatalf("subscription invoice = %s", r.raw)
	}
	subID := r.body["subscription"].(map[string]any)["id"].(string)
	e.expect(e.do("POST", "/v1/subscriptions", tok, map[string]string{"plan_code": "pro"}), http.StatusConflict)
	e.expect(e.do("POST", "/v1/subscriptions", tok, map[string]string{"plan_code": "enterprise"}), http.StatusUnprocessableEntity)

	_, otherTok := e.user("other@example.com", "")
	e.expect(e.do("POST", "/v1/subscriptions/"+subID+"/cancel", otherTok, nil), http.StatusNotFound)
	e.expect(e.do("POST", "/v1/subscriptions/"+subID+"/cancel", tok, nil), http.StatusOK)
	e.expect(e.do("POST", "/v1/subscriptions/"+subID+"/cancel", tok, nil), http.StatusConflict)
}

func TestAdminEndpoints(t *testing.T) {
	e := newTestEnv(t)
	id, tok := e.user("ada@example.com", "")
	e.expect(e.do("GET", "/v1/admin/users", tok, nil), http.StatusForbidden)
	users := e.expect(e.do("GET", "/v1/admin/users?limit=1", e.admin, nil), http.StatusOK)
	if users.body["total"] != float64(2) || users.body["next_offset"] != float64(1) {
		t.Fatalf("users = %s", users.raw)
	}
	e.expect(e.do("PATCH", "/v1/admin/users/"+id+"/role", e.admin, map[string]string{"role": "root"}), http.StatusUnprocessableEntity)
	e.expect(e.do("PATCH", "/v1/admin/users/usr_missing/role", e.admin, map[string]string{"role": "admin"}), http.StatusNotFound)

	e.expect(e.do("GET", "/v1/users/"+id, tok, nil), http.StatusOK)
	e.expect(e.do("GET", "/v1/users/"+id, e.admin, nil), http.StatusOK)
	adminID := e.expect(e.do("GET", "/v1/me", e.admin, nil), http.StatusOK).body["id"].(string)
	e.expect(e.do("GET", "/v1/users/"+adminID, tok, nil), http.StatusNotFound)

	e.expect(e.do("PUT", "/v1/admin/flags/new_dashboard", e.admin, map[string]any{"enabled": true, "allow_users": []string{id}}), http.StatusOK)
	e.expect(e.do("PUT", "/v1/admin/flags/Bad-Key", e.admin, map[string]any{"enabled": true}), http.StatusUnprocessableEntity)
	f := e.expect(e.do("GET", "/v1/flags/new_dashboard", tok, nil), http.StatusOK)
	if f.body["enabled"] != true {
		t.Fatalf("flag = %s", f.raw)
	}
	f = e.expect(e.do("GET", "/v1/flags/new_dashboard", e.admin, nil), http.StatusOK)
	if f.body["enabled"] != false {
		t.Fatalf("flag for admin = %s", f.raw)
	}
	audit := e.expect(e.do("GET", "/v1/admin/audit?action=feature_flag.saved", e.admin, nil), http.StatusOK)
	if audit.body["total"] != float64(1) {
		t.Fatalf("audit = %s", audit.raw)
	}
}

func TestExpiredToken(t *testing.T) {
	e := newTestEnv(t)
	_, tok := e.user("ada@example.com", "")
	e.clock.Advance(13 * time.Hour)
	r := e.expect(e.do("GET", "/v1/me", tok, nil), http.StatusUnauthorized)
	if errCode(r) != "token_expired" {
		t.Fatalf("body = %s", r.raw)
	}
}

func TestRateLimit(t *testing.T) {
	e := newTestEnv(t, func(c *app.Config) { c.RateLimitPerMinute = 60; c.RateLimitBurst = 3 })
	// newTestEnv already used one request for the admin login.
	for range 2 {
		e.expect(e.do("GET", "/healthz", "", nil), http.StatusOK)
	}
	e.expect(e.do("GET", "/healthz", "", nil), http.StatusTooManyRequests)
	e.clock.Advance(time.Second)
	e.expect(e.do("GET", "/healthz", "", nil), http.StatusOK)
}

func TestConfigFromEnv(t *testing.T) {
	env := map[string]string{"TOKEN_SECRET": "x", "TOKEN_TTL": "1h", "RATE_LIMIT_PER_MINUTE": "0", "TRUST_PROXY": "true"}
	cfg, err := app.ConfigFromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TokenTTL != time.Hour || cfg.RateLimitPerMinute != 0 || !cfg.TrustProxy {
		t.Fatalf("cfg = %+v", cfg)
	}
	if _, err := app.ConfigFromEnv(func(string) string { return "" }); err != app.ErrMissingSecret {
		t.Fatalf("err = %v", err)
	}
	env["TOKEN_TTL"] = "soon"
	if _, err := app.ConfigFromEnv(func(k string) string { return env[k] }); err == nil {
		t.Fatal("bad ttl accepted")
	}
}
