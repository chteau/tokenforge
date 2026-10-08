package handlers

import (
	"net/http"

	"github.com/acme/meridian/internal/services"
	"github.com/acme/meridian/pkg/httpx"
)

type planHandler struct {
	responder
	plans *services.PlanService
}

func (h *planHandler) list(w http.ResponseWriter, r *http.Request) {
	plans, err := h.plans.ListPlans(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"items": plans})
}

func (h *planHandler) create(w http.ResponseWriter, r *http.Request) {
	var in services.CreatePlanInput
	if !h.decode(w, r, &in) {
		return
	}
	plan, err := h.plans.CreatePlan(r.Context(), principal(r), in)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, plan)
}

type subscribeRequest struct {
	PlanCode string `json:"plan_code"`
}

func (h *planHandler) subscribe(w http.ResponseWriter, r *http.Request) {
	var in subscribeRequest
	if !h.decode(w, r, &in) {
		return
	}
	res, err := h.plans.Subscribe(r.Context(), principal(r), in.PlanCode)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, res)
}

func (h *planHandler) listSubscriptions(w http.ResponseWriter, r *http.Request) {
	subs, err := h.plans.ListSubscriptions(r.Context(), principal(r))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"items": subs})
}

func (h *planHandler) cancel(w http.ResponseWriter, r *http.Request) {
	sub, err := h.plans.CancelSubscription(r.Context(), principal(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, sub)
}
