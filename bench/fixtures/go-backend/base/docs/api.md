# HTTP API

All endpoints accept and return JSON. Authenticated endpoints expect
`Authorization: Bearer <token>` obtained from `POST /v1/auth/login`.
Timestamps are RFC 3339 in UTC. List endpoints accept `limit` (default 20,
max 100) and `offset`, and return `{"items", "total", "limit", "offset", "next_offset"?}`.

## Auth & users

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /v1/auth/register | – | `{email, name, password, phone?}` → 201 user |
| POST | /v1/auth/login | – | `{email, password}` → 200 `{token, expires_at, user}` |
| GET | /v1/me | user | |
| PATCH | /v1/me | user | `{name?, phone?}` |
| GET | /v1/users/{id} | user | self or admin, otherwise 404 |
| GET | /v1/admin/users | admin | paginated |
| PATCH | /v1/admin/users/{id}/role | admin | `{role}` |

## Plans & subscriptions

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /v1/plans | – | active plans |
| POST | /v1/admin/plans | admin | `{code, name, price_cents, currency, interval}` |
| POST | /v1/subscriptions | user | `{plan_code}` → 201 `{subscription, invoice}` |
| GET | /v1/subscriptions | user | own subscriptions |
| POST | /v1/subscriptions/{id}/cancel | owner / billing_admin | |

## Invoices

Invoice statuses: `draft → open → paid`, and `draft|open → void` while unpaid.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /v1/invoices | billing_admin | `{customer_id, currency, tax_rate_bps?, due_in_days?, lines:[{description, quantity, unit_cents}]}` → 201 draft |
| GET | /v1/invoices | user | own invoices; billing admins see all, `?customer_id=&status=` |
| GET | /v1/invoices/{id} | owner / billing_admin | others get 404 |
| POST | /v1/invoices/{id}/issue | billing_admin | owner gets 403, others 404; 409 unless draft |
| POST | /v1/invoices/{id}/void | billing_admin | 409 if paid or partially paid |
| POST | /v1/invoices/{id}/payments | billing_admin | `{amount_cents, method, reference?}` → 201 payment; 409 unless open; 422 `amount_exceeds_outstanding` |
| GET | /v1/invoices/{id}/payments | owner / billing_admin | `{items}` |

## Feature flags & audit

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /v1/flags/{key} | user | `{key, enabled}` for the caller |
| GET | /v1/admin/flags | admin | |
| PUT | /v1/admin/flags/{key} | admin | `{enabled, rollout_percent, allow_users?, description?}` |
| GET | /v1/admin/audit | admin | `?actor_id=&action=&target_id=`, oldest first |
