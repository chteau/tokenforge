# Quillmoor Online Banking

Server-rendered online banking for **Quillmoor Bank**, a fictional retail bank.
The app exposes a JSON API under `/api` and HTML pages for customers. Nothing
here talks to real payment networks; all people, accounts and money are made up.

## Requirements

- Node.js 26+ (TypeScript runs through Node's built-in type stripping)
- `tsc` on your PATH for type checking

There are no npm dependencies. Do not add any.

## Commands

```sh
npm start            # http://127.0.0.1:8080, data in data/bank.json
npm test             # node --test (unit + API tests)
npm run typecheck    # tsc --noEmit -p .
```

Sign in with one of the demo users from `seed/seed-data.ts`, e.g.
`alice / alice-harbor-2026`.

## Layout

```
apps/web/            server-rendered views (pure functions) and the browser-side form helper
packages/shared      errors, Result, clock, ids, money, dates/time zones, validation, events
packages/auth        users, password hashing (scrypt), sessions, roles
packages/accounts    accounts and admin operations (deposits, freezing)
packages/transactions ledger (balance-changing postings) and transaction queries
packages/transfers   internal transfers: limits, idempotency, status machine
packages/notifications in-app notifications and the email outbox
packages/cards       debit cards
packages/statements  monthly statements
packages/support     support tickets
server/              HTTP app: router, middleware, routes, repositories, caches, composition root
seed/                demo data
tests/               node:test suites (tests/unit, tests/api) and the shared harness
docs/                architecture, API reference and conventions
```

See `docs/architecture.md` before making changes and `docs/conventions.md`
for the house rules.
