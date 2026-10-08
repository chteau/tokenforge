# Architecture

Meridian is a single Go binary exposing a JSON REST API for accounts,
subscriptions and invoicing. It uses only the standard library.

```
cmd/server            process entry point: env config, HTTP server, graceful shutdown
internal/app          wiring: builds repositories, services and the router (app.New)
internal/handlers     HTTP layer (routes in router.go, one handler struct per area)
internal/middleware   request ID, logging, panic recovery, rate limiting, authentication
internal/services     business logic and authorization
internal/repositories persistence interfaces + in-memory / JSON-file implementations
internal/{auth,billing,users,audit,flags,notifications}  domain packages
internal/apperr       classified errors returned by services
internal/validation   field validation helpers
internal/clock        injectable clock
pkg/{httpx,pagination,ids}  small reusable helpers
migrations            intended SQL schema
```

## Request flow

1. `handlers.NewRouter` registers every route on a `http.ServeMux` using Go
   1.22 method patterns (`"POST /v1/invoices/{id}/issue"`) and wraps the mux
   with `RequestID → Logging → Recover → RateLimit`.
2. Routes that need a logged-in caller are wrapped with
   `middleware.Authenticate` (via the `protected` helper). Endpoints that only
   staff may call at all additionally use `middleware.RequireRole` (via the
   `staff` helper).
3. A handler decodes the body with `responder.decode`, calls **one** service
   method passing `principal(r)`, and writes the result with
   `httpx.WriteJSON`, or calls `responder.fail(w, r, err)` on error.
4. Services validate input (`internal/validation`), enforce authorization and
   call repositories. They return `*apperr.Error` for every expected failure.
5. `responder.fail` maps error kinds to status codes. Unclassified errors are
   logged and returned as an opaque 500.

Handlers never talk to repositories directly, and services never see
`*http.Request`.

## Errors

| apperr kind    | HTTP | example code                 |
|----------------|------|------------------------------|
| `Invalid`      | 422  | `validation_failed` (+ `fields`) |
| `Unauthorized` | 401  | `invalid_credentials`        |
| `Forbidden`    | 403  | `insufficient_role`          |
| `NotFound`     | 404  | `invoice_not_found`          |
| `Conflict`     | 409  | `invoice_not_open`           |

Malformed JSON bodies are rejected by the handler layer with 400
`invalid_body`. All error responses share the envelope
`{"error": {"code", "message", "fields"?, "request_id"}}`.

## Authorization

Roles are hierarchical: `admin` ⊇ `billing_admin` ⊇ `user`
(`auth.Role.Satisfies`).

For a single resource (e.g. an invoice) services first check visibility,
then permission:

* a caller who may not **see** the resource gets **404**, identical to a
  missing ID, so resource IDs cannot be probed;
* a caller who can see it but may not perform the action gets **403**.

`BillingService.loadInvoiceFor` implements the visibility rule for invoices
(the customer and billing admins can see an invoice).

## Persistence

Repositories return values (never pointers into storage) and expose
`Update(ctx, id, fn)` for read-modify-write. `fn` runs under the repository
lock, so invariants such as "paid never exceeds total" are checked inside
`fn` and are safe under concurrent requests. Returning an error from `fn`
aborts the update.

## Time

Never call `time.Now()` outside `internal/clock`. Every component that needs
the time receives a `clock.Clock`; tests use `clock.Fake`.

## Money

Amounts are `int64` minor units (`*_cents`). Percentages are basis points
(`tax_rate_bps`, 2000 = 20 %). `billing.ApplyBasisPoints` rounds half away
from zero.
