# Conventions

## TypeScript

- Node runs `.ts` files directly, so only *erasable* syntax is allowed: no
  `enum`, `namespace`, parameter properties or decorators. Use union types and
  `as const` objects instead.
- Relative imports always include the `.ts` extension. Use `import type` for
  type-only imports (`verbatimModuleSyntax` is on).
- Node built-ins are typed by `types/node-shim.d.ts`. If you need an API that
  is not declared there, add the declaration to the shim.
- `npm run typecheck` must stay clean.

## Money and time

- Money is an integer number of minor units plus a `Currency`. Parse user
  input with `parseAmount`, display with `formatMoney` / `formatDecimal`.
- Never call `new Date()` or `Date.now()` in services; use `deps.clock.now()`.
- Calendar dates are `YYYY-MM-DD` strings in the customer's time zone; use the
  helpers in `packages/shared/src/dates.ts` (`localDateString`,
  `zonedDateTimeToInstant`, `startOfLocalDay`, ...).

## Errors

- Services throw `DomainError(code, message, details?)`. Validation failures
  use `validationError([{ field, message }])`.
- The HTTP status comes from `server/http/error-map.ts`; add new codes there.
- API error body: `{ "error": { "code", "message", "details"?, "requestId" } }`.
- Resources the caller may not see are reported as `NOT_FOUND`, not
  `FORBIDDEN`, so their existence is not leaked.

## Routes

- One module per area in `server/routes`, exporting `xxxRoutes(): Route[]`,
  registered in `server/app.ts`.
- Use `api(...)` / `web(...)` from `routes/helpers.ts` with the route's auth
  requirement (`"public"`, `"user"` or a list of roles).
- Validate input at the boundary with `parseOrThrow(schema, ...)` from
  `packages/shared/src/validation.ts`; query strings via `queryToObject`.
- Handlers are thin: validate, call a service with `ctx.actor`, present the
  result with `routes/presenters.ts`.

## Repositories

- Declare the interface in the owning package's `types.ts`, implement it in
  `server/repositories/memory/` on top of `createTable`, add it to
  `Repositories` and register it with the store in `server/deps.ts`.

## Tests

- `node:test` + `node:assert/strict`. Unit tests in `tests/unit`, HTTP-level
  tests in `tests/api` using `setup()` from `tests/support/harness.ts`
  (seed data, manual clock at 2026-10-07T16:00Z, `login(username)`).
- Every behaviour change comes with tests.
