package notifications

import (
	"context"
	"strings"
	"testing"
)

func TestRender(t *testing.T) {
	tpls, err := NewTemplates()
	if err != nil {
		t.Fatal(err)
	}
	subject, body, err := tpls.Render(TemplateInvoiceIssued, map[string]string{
		"Name": "Ada", "Number": "INV-000042", "Total": "€12.00", "DueDate": "2026-02-01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if subject != "Invoice INV-000042 is ready" {
		t.Fatalf("subject = %q", subject)
	}
	if !strings.Contains(body, "€12.00") || strings.HasPrefix(body, "\n") {
		t.Fatalf("body = %q", body)
	}
}

func TestRenderErrors(t *testing.T) {
	tpls, _ := NewTemplates()
	if _, _, err := tpls.Render("nope", nil); err == nil {
		t.Fatal("unknown template accepted")
	}
	if _, _, err := tpls.Render(TemplateWelcome, map[string]string{"Name": "x"}); err == nil {
		t.Fatal("missing key accepted")
	}
}

func TestFakeSenders(t *testing.T) {
	var e FakeEmailSender
	e.FailNext(1)
	if err := e.SendEmail(context.Background(), Email{To: "a@example.com"}); err == nil {
		t.Fatal("expected failure")
	}
	if err := e.SendEmail(context.Background(), Email{To: "a@example.com"}); err != nil {
		t.Fatal(err)
	}
	if len(e.Sent()) != 1 {
		t.Fatalf("sent = %d", len(e.Sent()))
	}

	var s FakeSMSSender
	_ = s.SendSMS(context.Background(), SMS{To: "+14155550123", Body: "hi"})
	if got := s.Sent(); len(got) != 1 || got[0].Body != "hi" {
		t.Fatalf("sms = %+v", got)
	}
}
