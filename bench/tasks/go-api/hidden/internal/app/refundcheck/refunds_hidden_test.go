package refundcheck

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/acme/meridian/internal/app"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/notifications"
)

const (
	hAdminEmail = "ops-root@example.com"
	hAdminPass  = "ops-root-password"
	hUserPass   = "password-123"
)

type env struct {
	t     *testing.T
	srv   *httptest.Server
	clock *clock.Fake
	email *notifications.FakeEmailSender
	admin string
}

type resp struct {
	status int
	body   map[string]any
	raw    string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{t: t, clock: clock.NewFake(time.Date(2026, 6, 10, 10, 0, 0, 0, time.UTC)), email: &notifications.FakeEmailSender{}}
	a, err := app.New(app.Config{
		TokenSecret:            []byte("hidden-secret-hidden-secret-hidden-secret"),
		Clock:                  e.clock,
		Email:                  e.email,
		SMS:                    &notifications.FakeSMSSender{},
		BootstrapAdminEmail:    hAdminEmail,
		BootstrapAdminPassword: hAdminPass,
	})
	if err != nil {
		t.Fatalf("app.New: %v", err)
	}
	e.srv = httptest.NewServer(a.Handler)
	t.Cleanup(e.srv.Close)
	e.admin = e.login(hAdminEmail, hAdminPass)
	return e
}

func (e *env) do(method, path, token string, body any) resp {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
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
	r := resp{status: res.StatusCode, raw: string(raw)}
	_ = json.Unmarshal(raw, &r.body)
	return r
}

func (e *env) must(r resp, status int) resp {
	e.t.Helper()
	if r.status != status {
		e.t.Fatalf("status = %d, want %d; body: %s", r.status, status, r.raw)
	}
	return r
}

func (e *env) login(email, pass string) string {
	e.t.Helper()
	r := e.must(e.do("POST", "/v1/auth/login", "", map[string]string{"email": email, "password": pass}), 200)
	return r.body["token"].(string)
}

func (e *env) newUser(email, role string) (string, string) {
	e.t.Helper()
	r := e.must(e.do("POST", "/v1/auth/register", "", map[string]string{"email": email, "name": strings.Split(email, "@")[0], "password": hUserPass}), 201)
	id := r.body["id"].(string)
	if role != "" {
		e.must(e.do("PATCH", "/v1/admin/users/"+id+"/role", e.admin, map[string]string{"role": role}), 200)
	}
	return id, e.login(email, hUserPass)
}

type world struct {
	*env
	custID, custTok string
	otherTok        string
	billTok         string
}

func newWorld(t *testing.T) *world {
	e := newEnv(t)
	w := &world{env: e}
	w.custID, w.custTok = e.newUser("customer@example.com", "")
	_, w.otherTok = e.newUser("stranger@example.com", "")
	_, w.billTok = e.newUser("billing@example.com", "billing_admin")
	return w
}

// invoice creates an invoice with a total of 12000 cents (2 x 5000 + 20% tax).
// stage: "draft", "open", "partial" (open, 5000 paid) or "paid".
func (w *world) invoice(stage string) (id, number string) {
	w.t.Helper()
	r := w.must(w.do("POST", "/v1/invoices", w.billTok, map[string]any{
		"customer_id": w.custID, "currency": "EUR", "tax_rate_bps": 2000,
		"lines": []map[string]any{{"description": "Team plan", "quantity": 2, "unit_cents": 5000}},
	}), 201)
	id, number = r.body["id"].(string), r.body["number"].(string)
	if stage == "draft" {
		return
	}
	w.must(w.do("POST", "/v1/invoices/"+id+"/issue", w.billTok, nil), 200)
	switch stage {
	case "partial":
		w.must(w.do("POST", "/v1/invoices/"+id+"/payments", w.billTok, map[string]any{"amount_cents": 5000, "method": "card"}), 201)
	case "paid":
		w.must(w.do("POST", "/v1/invoices/"+id+"/payments", w.billTok, map[string]any{"amount_cents": 7000, "method": "card"}), 201)
		w.must(w.do("POST", "/v1/invoices/"+id+"/payments", w.billTok, map[string]any{"amount_cents": 5000, "method": "bank_transfer"}), 201)
	}
	return
}

func (w *world) refund(token, id string, amount int64, reason string) resp {
	w.t.Helper()
	return w.do("POST", "/v1/invoices/"+id+"/refunds", token, map[string]any{"amount_cents": amount, "reason": reason})
}

func (w *world) getInvoice(id string) map[string]any {
	w.t.Helper()
	return w.must(w.do("GET", "/v1/invoices/"+id, w.billTok, nil), 200).body
}

func code(r resp) string {
	m, _ := r.body["error"].(map[string]any)
	s, _ := m["code"].(string)
	return s
}

func field(r resp, name string) bool {
	m, _ := r.body["error"].(map[string]any)
	f, _ := m["fields"].(map[string]any)
	_, ok := f[name]
	return ok
}

func num(v any) int64 {
	f, _ := v.(float64)
	return int64(f)
}

// ---- authentication / authorization ----

func TestRefundHiddenAuthUnauthenticated(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	r := w.refund("", id, 100, "test")
	if r.status != 401 {
		t.Fatalf("status = %d, want 401; body %s", r.status, r.raw)
	}
	if num(w.getInvoice(id)["refunded_cents"]) != 0 {
		t.Fatal("unauthenticated request changed the invoice")
	}
}

func TestRefundHiddenAuthOwnerForbidden(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	r := w.must(w.refund(w.custTok, id, 100, "please"), 403)
	if code(r) == "" {
		t.Fatalf("missing error envelope: %s", r.raw)
	}
	if num(w.getInvoice(id)["refunded_cents"]) != 0 {
		t.Fatal("forbidden request changed the invoice")
	}
}

func TestRefundHiddenAuthStrangerNotFound(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	r := w.must(w.refund(w.otherTok, id, 100, "please"), 404)
	if code(r) != "invoice_not_found" {
		t.Fatalf("code = %q, want invoice_not_found; body %s", code(r), r.raw)
	}
}

func TestRefundHiddenAuthUnknownInvoice(t *testing.T) {
	w := newWorld(t)
	r := w.must(w.refund(w.billTok, "inv_0000000000000000", 100, "x"), 404)
	if code(r) != "invoice_not_found" {
		t.Fatalf("code = %q, want invoice_not_found; body %s", code(r), r.raw)
	}
}

func TestRefundHiddenAuthAdminAllowed(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	w.must(w.refund(w.admin, id, 500, "admin goodwill"), 201)
}

// ---- successful refunds ----

func TestRefundHiddenCreateResponse(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	billID := w.must(w.do("GET", "/v1/me", w.billTok, nil), 200).body["id"].(string)
	w.clock.Advance(30 * time.Minute)
	r := w.must(w.refund(w.billTok, id, 2500, "Seat removed"), 201)
	rid, _ := r.body["id"].(string)
	if !strings.HasPrefix(rid, "ref_") {
		t.Errorf("id = %q, want ref_ prefix", rid)
	}
	if r.body["invoice_id"] != id {
		t.Errorf("invoice_id = %v", r.body["invoice_id"])
	}
	if num(r.body["amount_cents"]) != 2500 {
		t.Errorf("amount_cents = %v", r.body["amount_cents"])
	}
	if r.body["reason"] != "Seat removed" {
		t.Errorf("reason = %v", r.body["reason"])
	}
	if r.body["refunded_by"] != billID {
		t.Errorf("refunded_by = %v, want %s", r.body["refunded_by"], billID)
	}
	if r.body["created_at"] != "2026-06-10T10:30:00Z" {
		t.Errorf("created_at = %v, want clock time", r.body["created_at"])
	}
}

func TestRefundHiddenCreatePartialUpdatesInvoice(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	if v, ok := w.getInvoice(id)["refunded_cents"]; !ok || num(v) != 0 {
		t.Fatalf("refunded_cents before refund = %v (present=%v)", v, ok)
	}
	w.must(w.refund(w.billTok, id, 2500, "Seat removed"), 201)
	w.must(w.refund(w.billTok, id, 500, "Rounding"), 201)
	inv := w.getInvoice(id)
	if num(inv["refunded_cents"]) != 3000 || inv["status"] != "paid" || num(inv["paid_cents"]) != 12000 {
		t.Fatalf("invoice after partial refunds: status=%v paid=%v refunded=%v", inv["status"], inv["paid_cents"], inv["refunded_cents"])
	}
	cust := w.must(w.do("GET", "/v1/invoices/"+id, w.custTok, nil), 200)
	if num(cust.body["refunded_cents"]) != 3000 {
		t.Fatalf("customer view = %s", cust.raw)
	}
}

func TestRefundHiddenCreateFullRefundStatus(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	other, _ := w.invoice("paid")
	w.must(w.refund(w.billTok, id, 2000, "part"), 201)
	w.must(w.refund(w.billTok, id, 10000, "rest"), 201)
	inv := w.getInvoice(id)
	if inv["status"] != "refunded" || num(inv["refunded_cents"]) != 12000 {
		t.Fatalf("status=%v refunded=%v", inv["status"], inv["refunded_cents"])
	}
	list := w.must(w.do("GET", "/v1/invoices?status=refunded", w.billTok, nil), 200)
	items, _ := list.body["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != id {
		t.Fatalf("status=refunded listing = %s", list.raw)
	}
	if st := w.getInvoice(other)["status"]; st != "paid" {
		t.Fatalf("unrelated invoice status = %v", st)
	}
}

// ---- refund limits ----

func TestRefundHiddenLimitExceedsPaid(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	r := w.must(w.refund(w.billTok, id, 12001, "too much"), 422)
	if code(r) != "amount_exceeds_refundable" {
		t.Fatalf("code = %q; body %s", code(r), r.raw)
	}
	if num(w.getInvoice(id)["refunded_cents"]) != 0 {
		t.Fatal("rejected refund changed the invoice")
	}
	w.must(w.refund(w.billTok, id, 12000, "everything"), 201)
}

func TestRefundHiddenLimitRemainingAfterPartial(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	w.must(w.refund(w.billTok, id, 7000, "first"), 201)
	r := w.must(w.refund(w.billTok, id, 5001, "second"), 422)
	if code(r) != "amount_exceeds_refundable" {
		t.Fatalf("code = %q; body %s", code(r), r.raw)
	}
	w.must(w.refund(w.billTok, id, 5000, "second"), 201)
}

func TestRefundHiddenLimitConcurrent(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	var mu sync.Mutex
	created := 0
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, _ := json.Marshal(map[string]any{"amount_cents": 3000, "reason": "race"})
			req, _ := http.NewRequest("POST", w.srv.URL+"/v1/invoices/"+id+"/refunds", bytes.NewReader(b))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+w.billTok)
			res, err := w.srv.Client().Do(req)
			if err != nil {
				return
			}
			res.Body.Close()
			if res.StatusCode == 201 {
				mu.Lock()
				created++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	inv := w.getInvoice(id)
	if created != 4 || num(inv["refunded_cents"]) != 12000 {
		t.Fatalf("created %d refunds, refunded_cents=%v; want 4 and 12000", created, inv["refunded_cents"])
	}
}

// ---- input validation ----

func TestRefundHiddenValidationAmount(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	for _, amt := range []int64{0, -500} {
		r := w.must(w.refund(w.billTok, id, amt, "x"), 422)
		if !field(r, "amount_cents") {
			t.Fatalf("amount %d: missing amount_cents field error: %s", amt, r.raw)
		}
	}
}

func TestRefundHiddenValidationReason(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	for _, reason := range []string{"", "   ", strings.Repeat("r", 501)} {
		r := w.must(w.refund(w.billTok, id, 100, reason), 422)
		if !field(r, "reason") {
			t.Fatalf("reason len %d: missing reason field error: %s", len(reason), r.raw)
		}
	}
	w.must(w.refund(w.billTok, id, 100, strings.Repeat("r", 500)), 201)
}

// ---- invoice state ----

func TestRefundHiddenStateUnpaidInvoices(t *testing.T) {
	w := newWorld(t)
	for _, stage := range []string{"draft", "open", "partial"} {
		id, _ := w.invoice(stage)
		r := w.must(w.refund(w.billTok, id, 100, "x"), 409)
		if code(r) != "invoice_not_refundable" {
			t.Fatalf("%s: code = %q; body %s", stage, code(r), r.raw)
		}
	}
}

func TestRefundHiddenStateVoidAndRefunded(t *testing.T) {
	w := newWorld(t)
	voided, _ := w.invoice("open")
	w.must(w.do("POST", "/v1/invoices/"+voided+"/void", w.billTok, nil), 200)
	if r := w.must(w.refund(w.billTok, voided, 100, "x"), 409); code(r) != "invoice_not_refundable" {
		t.Fatalf("void: %s", r.raw)
	}
	id, _ := w.invoice("paid")
	w.must(w.refund(w.billTok, id, 12000, "all"), 201)
	if r := w.must(w.refund(w.billTok, id, 1, "again"), 409); code(r) != "invoice_not_refundable" {
		t.Fatalf("refunded: %s", r.raw)
	}
}

// ---- audit trail and notification ----

func TestRefundHiddenAuditEvent(t *testing.T) {
	w := newWorld(t)
	id, _ := w.invoice("paid")
	billID := w.must(w.do("GET", "/v1/me", w.billTok, nil), 200).body["id"].(string)
	ref := w.must(w.refund(w.billTok, id, 1500, "Duplicate charge"), 201)
	a := w.must(w.do("GET", "/v1/admin/audit?action=invoice.refunded", w.admin, nil), 200)
	items, _ := a.body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("audit = %s", a.raw)
	}
	ev := items[0].(map[string]any)
	meta, _ := ev["metadata"].(map[string]any)
	if ev["target_id"] != id || ev["actor_id"] != billID || meta["refund_id"] != ref.body["id"] || meta["amount_cents"] != "1500" {
		t.Fatalf("audit event = %v", ev)
	}
	w.must(w.refund(w.billTok, id, 999999, "too much"), 422)
	a = w.must(w.do("GET", "/v1/admin/audit?action=invoice.refunded", w.admin, nil), 200)
	if num(a.body["total"]) != 1 {
		t.Fatalf("failed refund was audited: %s", a.raw)
	}
}

func TestRefundHiddenNotifyCustomer(t *testing.T) {
	w := newWorld(t)
	id, number := w.invoice("paid")
	before := len(w.email.Sent())
	w.must(w.refund(w.billTok, id, 1500, "Duplicate charge"), 201)
	sent := w.email.Sent()[before:]
	var found bool
	for _, m := range sent {
		if m.To == "customer@example.com" && strings.Contains(m.Subject, "Refund") && strings.Contains(m.Subject, number) {
			found = true
			if !strings.Contains(m.Body, "€15.00") {
				t.Errorf("body does not mention the formatted amount: %q", m.Body)
			}
		}
	}
	if !found {
		t.Fatalf("no refund email to the customer; sent: %+v", sent)
	}
}
