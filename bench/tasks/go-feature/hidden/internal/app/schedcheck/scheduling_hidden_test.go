package schedcheck

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
	_ "time/tzdata"

	"github.com/acme/meridian/internal/app"
	"github.com/acme/meridian/internal/clock"
	"github.com/acme/meridian/internal/notifications"
)

const (
	hAdminEmail = "ops-root@example.com"
	hAdminPass  = "ops-root-password"
	hUserPass   = "password-123"
)

var t0 = time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

type env struct {
	t     *testing.T
	srv   *httptest.Server
	clock *clock.Fake
	email *notifications.FakeEmailSender
	sms   *notifications.FakeSMSSender
	admin string
}

type resp struct {
	status int
	body   map[string]any
	raw    string
}

func newEnv(t *testing.T, start time.Time) *env {
	t.Helper()
	e := &env{t: t, clock: clock.NewFake(start), email: &notifications.FakeEmailSender{}, sms: &notifications.FakeSMSSender{}}
	a, err := app.New(app.Config{
		TokenSecret:            []byte("hidden-secret-hidden-secret-hidden-secret"),
		TokenTTL:               90 * 24 * time.Hour,
		Clock:                  e.clock,
		Email:                  e.email,
		SMS:                    e.sms,
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

func (e *env) req(method, path, token string, body any, headers map[string]string) resp {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	r, _ := http.NewRequest(method, e.srv.URL+path, rd)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := e.srv.Client().Do(r)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{status: res.StatusCode, raw: string(raw)}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

func (e *env) do(method, path, token string, body any) resp {
	e.t.Helper()
	return e.req(method, path, token, body, nil)
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
	return e.must(e.do("POST", "/v1/auth/login", "", map[string]string{"email": email, "password": pass}), 200).body["token"].(string)
}

func (e *env) newUser(email, phone string) (string, string) {
	e.t.Helper()
	in := map[string]string{"email": email, "name": strings.Split(email, "@")[0], "password": hUserPass}
	if phone != "" {
		in["phone"] = phone
	}
	id := e.must(e.do("POST", "/v1/auth/register", "", in), 201).body["id"].(string)
	return id, e.login(email, hUserPass)
}

func (e *env) setPrefs(tok, tz, start, end string) {
	e.t.Helper()
	body := map[string]any{"timezone": tz, "quiet_hours": nil}
	if start != "" {
		body["quiet_hours"] = map[string]string{"start": start, "end": end}
	}
	e.must(e.do("PUT", "/v1/me/notification-preferences", tok, body), 200)
}

func (e *env) schedule(tok, key string, body map[string]any) resp {
	e.t.Helper()
	var h map[string]string
	if key != "" {
		h = map[string]string{"Idempotency-Key": key}
	}
	return e.req("POST", "/v1/notifications", tok, body, h)
}

func emailBody(subject string, at time.Time) map[string]any {
	return map[string]any{"channel": "email", "subject": subject, "body": "Body of " + subject, "send_at": at.Format(time.RFC3339)}
}

// scheduleEmail schedules an e-mail and returns its id.
func (e *env) scheduleEmail(tok, subject string, at time.Time) string {
	e.t.Helper()
	return e.must(e.schedule(tok, "", emailBody(subject, at)), 201).body["id"].(string)
}

type counts struct{ sent, retried, failed, deferred int64 }

func (e *env) dispatch() counts {
	e.t.Helper()
	r := e.must(e.do("POST", "/v1/admin/notifications/dispatch", e.admin, nil), 200)
	return counts{num(r.body["sent"]), num(r.body["retried"]), num(r.body["failed"]), num(r.body["deferred"])}
}

func (e *env) get(tok, id string) map[string]any {
	e.t.Helper()
	return e.must(e.do("GET", "/v1/notifications/"+id, tok, nil), 200).body
}

func (e *env) emailsWithSubject(subject string) []notifications.Email {
	var out []notifications.Email
	for _, m := range e.email.Sent() {
		if m.Subject == subject {
			out = append(out, m)
		}
	}
	return out
}

func num(v any) int64 { f, _ := v.(float64); return int64(f) }

func code(r resp) string {
	m, _ := r.body["error"].(map[string]any)
	s, _ := m["code"].(string)
	return s
}

func fields(r resp) map[string]any {
	m, _ := r.body["error"].(map[string]any)
	f, _ := m["fields"].(map[string]any)
	return f
}

// ---------------- preferences ----------------

func TestSchedHiddenPrefsDefaults(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	r := e.must(e.do("GET", "/v1/me/notification-preferences", tok, nil), 200)
	if r.body["timezone"] != "UTC" || r.body["quiet_hours"] != nil {
		t.Fatalf("defaults = %s", r.raw)
	}
	e.must(e.do("GET", "/v1/me/notification-preferences", "", nil), 401)
}

func TestSchedHiddenPrefsRoundTrip(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	_, other := e.newUser("bob@example.com", "")
	r := e.must(e.do("PUT", "/v1/me/notification-preferences", tok, map[string]any{
		"timezone": "America/New_York", "quiet_hours": map[string]string{"start": "22:00", "end": "07:00"},
	}), 200)
	q, _ := r.body["quiet_hours"].(map[string]any)
	if r.body["timezone"] != "America/New_York" || q["start"] != "22:00" || q["end"] != "07:00" {
		t.Fatalf("put = %s", r.raw)
	}
	g := e.must(e.do("GET", "/v1/me/notification-preferences", tok, nil), 200)
	q, _ = g.body["quiet_hours"].(map[string]any)
	if g.body["timezone"] != "America/New_York" || q["start"] != "22:00" || q["end"] != "07:00" {
		t.Fatalf("get = %s", g.raw)
	}
	if o := e.must(e.do("GET", "/v1/me/notification-preferences", other, nil), 200); o.body["timezone"] != "UTC" {
		t.Fatalf("preferences leaked to another user: %s", o.raw)
	}
	e.must(e.do("PUT", "/v1/me/notification-preferences", tok, map[string]any{"timezone": "Asia/Tokyo", "quiet_hours": nil}), 200)
	g = e.must(e.do("GET", "/v1/me/notification-preferences", tok, nil), 200)
	if g.body["timezone"] != "Asia/Tokyo" || g.body["quiet_hours"] != nil {
		t.Fatalf("after clearing = %s", g.raw)
	}
}

func TestSchedHiddenPrefsValidation(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	qh := func(s, en string) map[string]string { return map[string]string{"start": s, "end": en} }
	tests := []struct {
		name  string
		body  map[string]any
		field string
	}{
		{"unknown zone", map[string]any{"timezone": "Mars/Olympus_Mons"}, "timezone"},
		{"empty zone", map[string]any{"timezone": ""}, "timezone"},
		{"hour out of range", map[string]any{"timezone": "UTC", "quiet_hours": qh("24:00", "07:00")}, "quiet_hours.start"},
		{"minute out of range", map[string]any{"timezone": "UTC", "quiet_hours": qh("22:00", "07:60")}, "quiet_hours.end"},
		{"not HH:MM", map[string]any{"timezone": "UTC", "quiet_hours": qh("22:00", "7am")}, "quiet_hours.end"},
		{"equal bounds", map[string]any{"timezone": "UTC", "quiet_hours": qh("07:00", "07:00")}, "quiet_hours"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := e.must(e.do("PUT", "/v1/me/notification-preferences", tok, tt.body), 422)
			if code(r) != "validation_failed" {
				t.Fatalf("code = %q; %s", code(r), r.raw)
			}
			ok := false
			for k := range fields(r) {
				if k == tt.field || (tt.field == "quiet_hours" && strings.HasPrefix(k, "quiet_hours")) {
					ok = true
				}
			}
			if !ok {
				t.Fatalf("fields = %v, want %q", fields(r), tt.field)
			}
		})
	}
	g := e.must(e.do("GET", "/v1/me/notification-preferences", tok, nil), 200)
	if g.body["timezone"] != "UTC" {
		t.Fatalf("invalid update was stored: %s", g.raw)
	}
}

// ---------------- scheduling ----------------

func TestSchedHiddenScheduleCreate(t *testing.T) {
	e := newEnv(t, t0)
	uid, tok := e.newUser("ada@example.com", "")
	r := e.must(e.schedule(tok, "", map[string]any{
		"channel": "email", "subject": "Renewal", "body": "Your plan renews tomorrow", "send_at": "2026-07-02T09:30:00+02:00",
	}), 201)
	b := r.body
	if id, _ := b["id"].(string); id == "" {
		t.Fatalf("missing id: %s", r.raw)
	}
	if b["user_id"] != uid || b["channel"] != "email" || b["subject"] != "Renewal" || b["body"] != "Your plan renews tomorrow" {
		t.Fatalf("fields = %s", r.raw)
	}
	if b["send_at"] != "2026-07-02T07:30:00Z" {
		t.Fatalf("send_at = %v, want UTC normalised 2026-07-02T07:30:00Z", b["send_at"])
	}
	if b["status"] != "pending" || num(b["attempts"]) != 0 || b["sent_at"] != nil {
		t.Fatalf("state = %s", r.raw)
	}
	if b["created_at"] != "2026-07-01T12:00:00Z" {
		t.Fatalf("created_at = %v", b["created_at"])
	}
	e.must(e.schedule("", "", emailBody("x", t0.Add(time.Hour))), 401)
}

func TestSchedHiddenScheduleValidation(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	at := t0.Add(time.Hour).Format(time.RFC3339)
	tests := []struct {
		name  string
		body  map[string]any
		field string
	}{
		{"unknown channel", map[string]any{"channel": "push", "subject": "s", "body": "b", "send_at": at}, "channel"},
		{"email without subject", map[string]any{"channel": "email", "body": "b", "send_at": at}, "subject"},
		{"empty body", map[string]any{"channel": "email", "subject": "s", "body": "", "send_at": at}, "body"},
		{"body too long", map[string]any{"channel": "email", "subject": "s", "body": strings.Repeat("b", 2001), "send_at": at}, "body"},
		{"subject too long", map[string]any{"channel": "email", "subject": strings.Repeat("s", 201), "body": "b", "send_at": at}, "subject"},
		{"malformed send_at", map[string]any{"channel": "email", "subject": "s", "body": "b", "send_at": "tomorrow"}, "send_at"},
		{"missing send_at", map[string]any{"channel": "email", "subject": "s", "body": "b"}, "send_at"},
		{"send_at in the past", map[string]any{"channel": "email", "subject": "s", "body": "b", "send_at": t0.Add(-time.Second).Format(time.RFC3339)}, "send_at"},
		{"send_at too far ahead", map[string]any{"channel": "email", "subject": "s", "body": "b", "send_at": t0.Add(30*24*time.Hour + time.Second).Format(time.RFC3339)}, "send_at"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := e.must(e.schedule(tok, "", tt.body), 422)
			if _, ok := fields(r)[tt.field]; !ok || code(r) != "validation_failed" {
				t.Fatalf("want validation_failed on %q, got %s", tt.field, r.raw)
			}
		})
	}
	// Boundaries are inclusive.
	e.must(e.schedule(tok, "", emailBody("now", t0)), 201)
	e.must(e.schedule(tok, "", emailBody("max", t0.Add(30*24*time.Hour))), 201)
}

func TestSchedHiddenScheduleSMSRequiresPhone(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	sms := map[string]any{"channel": "sms", "body": "Your code is ready", "send_at": t0.Add(time.Hour).Format(time.RFC3339)}
	r := e.must(e.schedule(tok, "", sms), 422)
	if _, ok := fields(r)["channel"]; !ok {
		t.Fatalf("want field error on channel: %s", r.raw)
	}
	e.must(e.do("PATCH", "/v1/me", tok, map[string]string{"phone": "+447700900123"}), 200)
	e.must(e.schedule(tok, "", sms), 201)
}

func TestSchedHiddenScheduleGetOwnerOnly(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	_, other := e.newUser("bob@example.com", "")
	id := e.scheduleEmail(tok, "Mine", t0.Add(time.Hour))
	if got := e.get(tok, id); got["id"] != id || got["subject"] != "Mine" {
		t.Fatalf("get = %v", got)
	}
	r := e.must(e.do("GET", "/v1/notifications/"+id, other, nil), 404)
	if code(r) != "notification_not_found" {
		t.Fatalf("stranger: %s", r.raw)
	}
	r = e.must(e.do("GET", "/v1/notifications/ntf_0000000000000000", tok, nil), 404)
	if code(r) != "notification_not_found" {
		t.Fatalf("unknown: %s", r.raw)
	}
	e.must(e.do("GET", "/v1/notifications/"+id, "", nil), 401)
}

// ---------------- idempotency ----------------

func TestSchedHiddenIdemReplay(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	body := emailBody("Once", t0.Add(time.Hour))
	first := e.must(e.schedule(tok, "key-1", body), 201)
	again := e.must(e.schedule(tok, "key-1", body), 200)
	if again.body["id"] != first.body["id"] {
		t.Fatalf("replay returned a different notification: %s vs %s", again.raw, first.raw)
	}
	// Same instant written with another offset is the same request.
	shifted := emailBody("Once", t0.Add(time.Hour).In(time.FixedZone("UTC+2", 2*3600)))
	if r := e.must(e.schedule(tok, "key-1", shifted), 200); r.body["id"] != first.body["id"] {
		t.Fatalf("offset replay = %s", r.raw)
	}
	// A replay after send_at has passed still returns the stored notification.
	e.clock.Advance(2 * time.Hour)
	if r := e.must(e.schedule(tok, "key-1", body), 200); r.body["id"] != first.body["id"] {
		t.Fatalf("late replay = %s", r.raw)
	}
	e.dispatch()
	if n := len(e.emailsWithSubject("Once")); n != 1 {
		t.Fatalf("delivered %d times, want 1", n)
	}
}

func TestSchedHiddenIdemConflict(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	e.must(e.schedule(tok, "key-1", emailBody("Original", t0.Add(time.Hour))), 201)
	for name, body := range map[string]map[string]any{
		"different subject": emailBody("Changed", t0.Add(time.Hour)),
		"different time":    emailBody("Original", t0.Add(2*time.Hour)),
	} {
		r := e.must(e.schedule(tok, "key-1", body), 409)
		if code(r) != "idempotency_key_reused" {
			t.Fatalf("%s: %s", name, r.raw)
		}
	}
}

func TestSchedHiddenIdemPerUser(t *testing.T) {
	e := newEnv(t, t0)
	_, a := e.newUser("ada@example.com", "")
	_, b := e.newUser("bob@example.com", "")
	body := emailBody("Shared key", t0.Add(time.Hour))
	ra := e.must(e.schedule(a, "same-key", body), 201)
	rb := e.must(e.schedule(b, "same-key", body), 201)
	if ra.body["id"] == rb.body["id"] {
		t.Fatal("idempotency keys must be scoped per user")
	}
}

func TestSchedHiddenIdemRejectedRequestNotStored(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	bad := emailBody("Late", t0.Add(-time.Hour))
	e.must(e.schedule(tok, "key-2", bad), 422)
	e.must(e.schedule(tok, "key-2", emailBody("Fixed", t0.Add(time.Hour))), 201)
	// Requests without a key are never deduplicated.
	e.must(e.schedule(tok, "", emailBody("Twice", t0.Add(time.Hour))), 201)
	e.must(e.schedule(tok, "", emailBody("Twice", t0.Add(time.Hour))), 201)
}

func TestSchedHiddenIdemConcurrent(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	body, _ := json.Marshal(emailBody("Race", t0.Add(time.Hour)))
	var mu sync.Mutex
	statuses := map[int]int{}
	ids := map[string]bool{}
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, _ := http.NewRequest("POST", e.srv.URL+"/v1/notifications", bytes.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer "+tok)
			r.Header.Set("Idempotency-Key", "race-key")
			res, err := e.srv.Client().Do(r)
			if err != nil {
				return
			}
			defer res.Body.Close()
			var out map[string]any
			_ = json.NewDecoder(res.Body).Decode(&out)
			mu.Lock()
			defer mu.Unlock()
			statuses[res.StatusCode]++
			if id, ok := out["id"].(string); ok {
				ids[id] = true
			}
		}()
	}
	wg.Wait()
	if statuses[201] != 1 || statuses[200] != 11 || len(ids) != 1 {
		t.Fatalf("statuses = %v, distinct ids = %d", statuses, len(ids))
	}
}

// ---------------- dispatch ----------------

func TestSchedHiddenDispatchDue(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	id := e.scheduleEmail(tok, "Later", t0.Add(10*time.Minute))
	if c := e.dispatch(); c != (counts{}) {
		t.Fatalf("before send_at: %+v", c)
	}
	if len(e.emailsWithSubject("Later")) != 0 {
		t.Fatal("sent before send_at")
	}
	e.clock.Advance(10 * time.Minute)
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("at send_at: %+v", c)
	}
	msgs := e.emailsWithSubject("Later")
	if len(msgs) != 1 || msgs[0].To != "ada@example.com" || msgs[0].Body != "Body of Later" {
		t.Fatalf("emails = %+v", msgs)
	}
	n := e.get(tok, id)
	if n["status"] != "sent" || num(n["attempts"]) != 1 || n["sent_at"] != "2026-07-01T12:10:00Z" {
		t.Fatalf("after send = %v", n)
	}
	e.clock.Advance(time.Hour)
	if c := e.dispatch(); c != (counts{}) {
		t.Fatalf("second pass: %+v", c)
	}
	if len(e.emailsWithSubject("Later")) != 1 {
		t.Fatal("sent twice")
	}
}

func TestSchedHiddenDispatchAdminOnly(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	_, btok := e.newUser("billing@example.com", "")
	bid := e.must(e.do("GET", "/v1/me", btok, nil), 200).body["id"].(string)
	e.must(e.do("PATCH", "/v1/admin/users/"+bid+"/role", e.admin, map[string]string{"role": "billing_admin"}), 200)
	btok = e.login("billing@example.com", hUserPass)
	e.scheduleEmail(tok, "Guarded", t0)
	e.must(e.do("POST", "/v1/admin/notifications/dispatch", "", nil), 401)
	e.must(e.do("POST", "/v1/admin/notifications/dispatch", tok, nil), 403)
	e.must(e.do("POST", "/v1/admin/notifications/dispatch", btok, nil), 403)
	if len(e.emailsWithSubject("Guarded")) != 0 {
		t.Fatal("unauthorised dispatch delivered notifications")
	}
}

func TestSchedHiddenDispatchSMS(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "+14155550123")
	r := e.must(e.schedule(tok, "", map[string]any{"channel": "sms", "body": "Invoice due today", "send_at": t0.Format(time.RFC3339)}), 201)
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("dispatch = %+v", c)
	}
	sent := e.sms.Sent()
	if len(sent) != 1 || sent[0].To != "+14155550123" || sent[0].Body != "Invoice due today" {
		t.Fatalf("sms = %+v", sent)
	}
	if n := e.get(tok, r.body["id"].(string)); n["status"] != "sent" {
		t.Fatalf("status = %v", n["status"])
	}
}

func TestSchedHiddenDispatchConcurrentPasses(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	for _, s := range []string{"P1", "P2", "P3"} {
		e.scheduleEmail(tok, s, t0)
	}
	var mu sync.Mutex
	var totalSent int64
	var wg sync.WaitGroup
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, _ := http.NewRequest("POST", e.srv.URL+"/v1/admin/notifications/dispatch", nil)
			r.Header.Set("Authorization", "Bearer "+e.admin)
			res, err := e.srv.Client().Do(r)
			if err != nil {
				return
			}
			defer res.Body.Close()
			var out map[string]any
			_ = json.NewDecoder(res.Body).Decode(&out)
			mu.Lock()
			totalSent += num(out["sent"])
			mu.Unlock()
		}()
	}
	wg.Wait()
	for _, s := range []string{"P1", "P2", "P3"} {
		if n := len(e.emailsWithSubject(s)); n != 1 {
			t.Fatalf("%s delivered %d times", s, n)
		}
	}
	if totalSent != 3 {
		t.Fatalf("sum of sent counters = %d, want 3", totalSent)
	}
}

func TestSchedHiddenDispatchCountsAndOrder(t *testing.T) {
	e := newEnv(t, t0)
	_, a := e.newUser("ada@example.com", "")
	_, b := e.newUser("bob@example.com", "")
	e.setPrefs(b, "UTC", "11:00", "13:00")   // 12:00 UTC is quiet for bob
	first := e.scheduleEmail(a, "First", t0) // earliest send_at: the injected failure hits it
	e.clock.Advance(time.Minute)
	second := e.scheduleEmail(a, "Second", t0.Add(time.Minute))
	e.scheduleEmail(b, "Quiet", t0.Add(time.Minute))
	e.email.FailNext(1)
	if c := e.dispatch(); c != (counts{sent: 1, retried: 1, deferred: 1}) {
		t.Fatalf("dispatch = %+v", c)
	}
	if n := e.get(a, first); n["status"] != "pending" || num(n["attempts"]) != 1 {
		t.Fatalf("first = %v", n)
	}
	if n := e.get(a, second); n["status"] != "sent" {
		t.Fatalf("second = %v", n)
	}
}

// ---------------- quiet hours ----------------

func TestSchedHiddenQuietDeferredUntilWindowEnds(t *testing.T) {
	start := time.Date(2026, 7, 1, 2, 0, 0, 0, time.UTC)
	e := newEnv(t, start)
	_, tok := e.newUser("ada@example.com", "")
	e.setPrefs(tok, "America/New_York", "22:00", "07:00")
	id := e.scheduleEmail(tok, "Night", time.Date(2026, 7, 1, 3, 0, 0, 0, time.UTC)) // 23:00 EDT
	e.clock.Set(time.Date(2026, 7, 1, 3, 0, 0, 0, time.UTC))
	if c := e.dispatch(); c != (counts{deferred: 1}) {
		t.Fatalf("23:00 local: %+v", c)
	}
	e.clock.Set(time.Date(2026, 7, 1, 10, 59, 0, 0, time.UTC)) // 06:59 EDT
	if c := e.dispatch(); c != (counts{deferred: 1}) {
		t.Fatalf("06:59 local: %+v", c)
	}
	if n := e.get(tok, id); n["status"] != "pending" || num(n["attempts"]) != 0 {
		t.Fatalf("deferral must not count as an attempt: %v", n)
	}
	e.clock.Set(time.Date(2026, 7, 1, 11, 0, 0, 0, time.UTC)) // 07:00 EDT
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("07:00 local: %+v", c)
	}
	if n := e.get(tok, id); n["sent_at"] != "2026-07-01T11:00:00Z" {
		t.Fatalf("sent_at = %v", n["sent_at"])
	}
}

func TestSchedHiddenQuietDaytimeWindowHalfHourZone(t *testing.T) {
	start := time.Date(2026, 7, 1, 6, 0, 0, 0, time.UTC)
	e := newEnv(t, start)
	_, tok := e.newUser("ada@example.com", "")
	e.setPrefs(tok, "Asia/Kolkata", "12:00", "14:00") // UTC+05:30
	e.scheduleEmail(tok, "Lunch", start)
	e.clock.Set(time.Date(2026, 7, 1, 6, 29, 0, 0, time.UTC)) // 11:59 IST
	// 11:59 is before the window: delivered immediately.
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("11:59 local: %+v", c)
	}
	e.scheduleEmail(tok, "Lunch2", e.clock.Now())
	e.clock.Set(time.Date(2026, 7, 1, 7, 0, 0, 0, time.UTC)) // 12:30 IST
	if c := e.dispatch(); c != (counts{deferred: 1}) {
		t.Fatalf("12:30 local: %+v", c)
	}
	e.clock.Set(time.Date(2026, 7, 1, 8, 30, 0, 0, time.UTC)) // 14:00 IST
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("14:00 local: %+v", c)
	}
}

func TestSchedHiddenQuietDaylightSavingTransition(t *testing.T) {
	// Europe/Berlin switches from CET (+1) to CEST (+2) on 2026-03-29.
	start := time.Date(2026, 3, 29, 0, 0, 0, 0, time.UTC)
	e := newEnv(t, start)
	_, tok := e.newUser("ada@example.com", "")
	e.setPrefs(tok, "Europe/Berlin", "22:00", "07:00")
	e.scheduleEmail(tok, "Spring", start)
	e.clock.Set(time.Date(2026, 3, 29, 4, 59, 0, 0, time.UTC)) // 06:59 CEST
	if c := e.dispatch(); c != (counts{deferred: 1}) {
		t.Fatalf("06:59 CEST: %+v", c)
	}
	e.clock.Set(time.Date(2026, 3, 29, 5, 0, 0, 0, time.UTC)) // 07:00 CEST (06:00 if the offset were fixed)
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("07:00 CEST: %+v", c)
	}
}

func TestSchedHiddenQuietPreferencesReadAtDispatch(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	e.scheduleEmail(tok, "Changed mind", t0)
	e.setPrefs(tok, "Asia/Tokyo", "20:00", "09:00") // 12:00 UTC = 21:00 JST
	if c := e.dispatch(); c != (counts{deferred: 1}) {
		t.Fatalf("with quiet hours: %+v", c)
	}
	e.setPrefs(tok, "Asia/Tokyo", "", "")
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("after clearing quiet hours: %+v", c)
	}
}

func TestSchedHiddenQuietDefaultIsNeverQuiet(t *testing.T) {
	start := time.Date(2026, 7, 1, 3, 0, 0, 0, time.UTC)
	e := newEnv(t, start)
	_, tok := e.newUser("ada@example.com", "")
	e.scheduleEmail(tok, "Night owl", start)
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("dispatch = %+v", c)
	}
}

// ---------------- retries ----------------

func TestSchedHiddenRetryBackoffOneMinute(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	id := e.scheduleEmail(tok, "Flaky", t0)
	e.email.FailNext(1)
	if c := e.dispatch(); c != (counts{retried: 1}) {
		t.Fatalf("first attempt: %+v", c)
	}
	if n := e.get(tok, id); n["status"] != "pending" || num(n["attempts"]) != 1 {
		t.Fatalf("after failure = %v", n)
	}
	e.clock.Advance(59 * time.Second)
	if c := e.dispatch(); c != (counts{}) {
		t.Fatalf("retried too early: %+v", c)
	}
	e.clock.Advance(time.Second)
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("retry: %+v", c)
	}
	if n := e.get(tok, id); n["status"] != "sent" || num(n["attempts"]) != 2 {
		t.Fatalf("after retry = %v", n)
	}
}

func TestSchedHiddenRetrySecondBackoffTwoMinutes(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	id := e.scheduleEmail(tok, "Flaky", t0)
	e.email.FailNext(2)
	e.dispatch()
	e.clock.Advance(time.Minute)
	if c := e.dispatch(); c != (counts{retried: 1}) {
		t.Fatalf("second attempt: %+v", c)
	}
	e.clock.Advance(2*time.Minute - time.Second)
	if c := e.dispatch(); c != (counts{}) {
		t.Fatalf("third attempt too early: %+v", c)
	}
	e.clock.Advance(time.Second)
	if c := e.dispatch(); c != (counts{sent: 1}) {
		t.Fatalf("third attempt: %+v", c)
	}
	if n := e.get(tok, id); num(n["attempts"]) != 3 || n["status"] != "sent" {
		t.Fatalf("final = %v", n)
	}
}

func TestSchedHiddenRetryGivesUpAfterThreeAttempts(t *testing.T) {
	e := newEnv(t, t0)
	_, tok := e.newUser("ada@example.com", "")
	id := e.scheduleEmail(tok, "Doomed", t0)
	e.email.FailNext(10)
	e.dispatch()
	e.clock.Advance(time.Minute)
	e.dispatch()
	e.clock.Advance(2 * time.Minute)
	if c := e.dispatch(); c != (counts{failed: 1}) {
		t.Fatalf("third failure: %+v", c)
	}
	if n := e.get(tok, id); n["status"] != "failed" || num(n["attempts"]) != 3 || n["sent_at"] != nil {
		t.Fatalf("final = %v", n)
	}
	e.email.FailNext(0)
	e.clock.Advance(time.Hour)
	if c := e.dispatch(); c != (counts{}) {
		t.Fatalf("failed notification retried: %+v", c)
	}
	if len(e.emailsWithSubject("Doomed")) != 0 {
		t.Fatal("failed notification delivered")
	}
}
