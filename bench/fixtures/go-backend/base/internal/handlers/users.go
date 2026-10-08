package handlers

import (
	"net/http"

	"github.com/acme/meridian/internal/services"
	"github.com/acme/meridian/pkg/httpx"
)

type authHandler struct {
	responder
	auth  *services.AuthService
	users *services.UserService
}

func (h *authHandler) register(w http.ResponseWriter, r *http.Request) {
	var in services.RegisterInput
	if !h.decode(w, r, &in) {
		return
	}
	u, err := h.users.Register(r.Context(), in)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, u)
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (h *authHandler) login(w http.ResponseWriter, r *http.Request) {
	var in loginRequest
	if !h.decode(w, r, &in) {
		return
	}
	sess, err := h.auth.Login(r.Context(), in.Email, in.Password)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, sess)
}

type userHandler struct {
	responder
	users *services.UserService
}

func (h *userHandler) me(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	u, err := h.users.Get(r.Context(), p, p.UserID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, u)
}

func (h *userHandler) updateMe(w http.ResponseWriter, r *http.Request) {
	var in services.UpdateProfileInput
	if !h.decode(w, r, &in) {
		return
	}
	u, err := h.users.UpdateProfile(r.Context(), principal(r), in)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, u)
}

func (h *userHandler) get(w http.ResponseWriter, r *http.Request) {
	u, err := h.users.Get(r.Context(), principal(r), r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, u)
}
