package handlers

import (
	"net/http"

	"github.com/acme/meridian/internal/audit"
	"github.com/acme/meridian/internal/auth"
	"github.com/acme/meridian/internal/services"
	"github.com/acme/meridian/pkg/httpx"
)

type adminHandler struct {
	responder
	users *services.UserService
	audit *services.AuditService
	flags *services.FlagService
}

func (h *adminHandler) listUsers(w http.ResponseWriter, r *http.Request) {
	page, ok := h.page(w, r)
	if !ok {
		return
	}
	res, err := h.users.List(r.Context(), principal(r), page)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

type setRoleRequest struct {
	Role auth.Role `json:"role"`
}

func (h *adminHandler) setRole(w http.ResponseWriter, r *http.Request) {
	var in setRoleRequest
	if !h.decode(w, r, &in) {
		return
	}
	u, err := h.users.SetRole(r.Context(), principal(r), r.PathValue("id"), in.Role)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, u)
}

func (h *adminHandler) listAudit(w http.ResponseWriter, r *http.Request) {
	page, ok := h.page(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	f := audit.Filter{ActorID: q.Get("actor_id"), Action: q.Get("action"), TargetID: q.Get("target_id")}
	res, err := h.audit.List(r.Context(), principal(r), f, page)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

func (h *adminHandler) listFlags(w http.ResponseWriter, r *http.Request) {
	list, err := h.flags.List(r.Context(), principal(r))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (h *adminHandler) saveFlag(w http.ResponseWriter, r *http.Request) {
	var in services.SaveFlagInput
	if !h.decode(w, r, &in) {
		return
	}
	f, err := h.flags.Save(r.Context(), principal(r), r.PathValue("key"), in)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, f)
}

func (h *adminHandler) evaluateFlag(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, h.flags.Evaluate(r.Context(), principal(r), r.PathValue("key")))
}
