package notifications

import (
	"bytes"
	"fmt"
	"strings"
	"text/template"
)

// Template names.
const (
	TemplateWelcome         = "welcome"
	TemplateInvoiceIssued   = "invoice_issued"
	TemplatePaymentReceived = "payment_received"
	TemplateInvoiceVoided   = "invoice_voided"
)

// Each template's first line is the subject; the rest is the body.
var builtin = map[string]string{
	TemplateWelcome: `Welcome to Meridian, {{.Name}}
Hi {{.Name}},

Your account has been created. You can sign in with {{.Email}}.
`,
	TemplateInvoiceIssued: `Invoice {{.Number}} is ready
Hi {{.Name}},

Invoice {{.Number}} for {{.Total}} has been issued and is due on {{.DueDate}}.
`,
	TemplatePaymentReceived: `Payment received for invoice {{.Number}}
Hi {{.Name}},

We received {{.Amount}} for invoice {{.Number}}. Outstanding balance: {{.Outstanding}}.
`,
	TemplateInvoiceVoided: `Invoice {{.Number}} was voided
Hi {{.Name}},

Invoice {{.Number}} has been voided. No payment is required.
`,
}

// Templates renders named message templates.
type Templates struct {
	set map[string]*template.Template
}

// NewTemplates parses the built-in templates.
func NewTemplates() (*Templates, error) {
	t := &Templates{set: map[string]*template.Template{}}
	for name, src := range builtin {
		tpl, err := template.New(name).Option("missingkey=error").Parse(src)
		if err != nil {
			return nil, fmt.Errorf("parse template %s: %w", name, err)
		}
		t.set[name] = tpl
	}
	return t, nil
}

// Render executes the named template and splits subject from body.
func (t *Templates) Render(name string, data any) (subject, body string, err error) {
	tpl, ok := t.set[name]
	if !ok {
		return "", "", fmt.Errorf("unknown template %q", name)
	}
	var buf bytes.Buffer
	if err := tpl.Execute(&buf, data); err != nil {
		return "", "", fmt.Errorf("render %s: %w", name, err)
	}
	subject, body, _ = strings.Cut(buf.String(), "\n")
	return strings.TrimSpace(subject), strings.TrimLeft(body, "\n"), nil
}
