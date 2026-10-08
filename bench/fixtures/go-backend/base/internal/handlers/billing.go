package handlers

import (
	"net/http"

	"github.com/acme/meridian/internal/services"
	"github.com/acme/meridian/pkg/httpx"
)

type billingHandler struct {
	responder
	billing *services.BillingService
}

func (h *billingHandler) create(w http.ResponseWriter, r *http.Request) {
	var in services.CreateInvoiceInput
	if !h.decode(w, r, &in) {
		return
	}
	inv, err := h.billing.CreateInvoice(r.Context(), principal(r), in)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, inv)
}

func (h *billingHandler) list(w http.ResponseWriter, r *http.Request) {
	page, ok := h.page(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	in := services.ListInvoicesInput{CustomerID: q.Get("customer_id"), Status: q.Get("status")}
	res, err := h.billing.ListInvoices(r.Context(), principal(r), in, page)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

func (h *billingHandler) get(w http.ResponseWriter, r *http.Request) {
	inv, err := h.billing.GetInvoice(r.Context(), principal(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, inv)
}

func (h *billingHandler) issue(w http.ResponseWriter, r *http.Request) {
	inv, err := h.billing.IssueInvoice(r.Context(), principal(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, inv)
}

func (h *billingHandler) void(w http.ResponseWriter, r *http.Request) {
	inv, err := h.billing.VoidInvoice(r.Context(), principal(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, inv)
}

func (h *billingHandler) recordPayment(w http.ResponseWriter, r *http.Request) {
	var in services.RecordPaymentInput
	if !h.decode(w, r, &in) {
		return
	}
	pay, err := h.billing.RecordPayment(r.Context(), principal(r), r.PathValue("id"), in)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, pay)
}

func (h *billingHandler) listPayments(w http.ResponseWriter, r *http.Request) {
	list, err := h.billing.ListPayments(r.Context(), principal(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"items": list})
}
