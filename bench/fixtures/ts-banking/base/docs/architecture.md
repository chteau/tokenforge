# Architecture

## Request flow

```
node:http ──> App.handle ──> App.dispatch
                              │  router.match(method, path)        server/http/router.ts
                              │  middleware chain                  server/http/middleware.ts
                              │    securityHeaders
                              │    errorBoundary   (DomainError -> HTTP, see error-map.ts)
                              │    authenticate    (Bearer token or qm_session cookie, route.auth)
                              │    persistAfterWrite (store.save() after successful writes)
                              │  parseBody (JSON or urlencoded)
                              └─> route handler                    server/routes/*.ts
                                     └─> service (packages/*)      business rules
                                            └─> repositories       server/repositories/memory/*
```

`createApp(deps)` (server/app.ts) builds the router from the route modules.
`createDeps(options)` (server/deps.ts) is the composition root: it creates the
repositories, registers them with the data store, builds the services and wires
domain events to the caches.

## Domain packages

Each package under `packages/` exposes a `create*Service(deps)` factory. A
service receives its collaborators explicitly (repositories, other services,
`clock`, `ids`, `events`). Packages declare the repository *interfaces* they
need in their `types.ts`; the in-memory implementations live in
`server/repositories/memory`.

- **Ledger** (`packages/transactions/src/ledger.ts`) is the only code that
  changes account balances. Every posting appends an immutable `LedgerEntry`
  with the resulting `balanceAfterMinor`.
- **Transfers** (`packages/transfers`) validate a request (`prepare`), enforce
  idempotency, the customer's daily limit (`limits.ts`) and available funds,
  post both ledger legs, move the transfer through its status machine
  (`status.ts`), emit `accountsChanged` and notify both parties.
- **Accounts** handle ownership checks: `getForActor` (read, staff allowed)
  and `requireOwned` (money movement, owner only). Both answer NOT_FOUND for
  accounts the caller may not see.

## Time

All services take a `Clock` (`packages/shared/src/clock.ts`). Tests use
`createManualClock`. Customer-facing calendar logic (daily limits, "this
month", statements) is evaluated in the customer's profile time zone
(`User.timezone`) through `packages/shared/src/dates.ts`.

## Caching

The dashboard's account summary is expensive (it walks the ledger), so
`DashboardService` reads it through `SummaryCache` (server/cache), a per-user
TTL cache (5 minutes by default, `config.cache.summaryTtlMs`). Services do not
know about the cache: they emit `accountsChanged` with the affected
`{ ownerId, accountId }` pairs, and `createDeps` subscribes the cache to that
event. Cache statistics are available from `deps.caches.summary.stats()` and
`GET /api/admin/cache`.

## Persistence

Repositories keep rows in `createTable` instances. When a data file is
configured, `createJsonFileStore` snapshots every *registered* table to one
JSON file after each successful non-GET request and restores them on boot.
A new repository must be registered in `createDeps` to be persisted.

## Web

Pages are rendered on the server by pure functions in `apps/web/views` using
the escaping `html` tagged template (`apps/web/html.ts`). Web routes live in
`server/routes/web-routes.ts`, use the session cookie, redirect to `/login`
when signed out and render an error page for DomainErrors. The transfer form
gets client-side validation from `apps/web/client/transfer-form.ts`, served
as `/static/transfer-form.js` with types stripped.
