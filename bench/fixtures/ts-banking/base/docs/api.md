# API reference

All endpoints live under `/api` and speak JSON. Authenticate with
`Authorization: Bearer <token>` from `POST /api/auth/login` (web pages use the
`qm_session` cookie). Amounts are integer minor units (`*Minor`) plus a decimal
string (`amount`, `balance`) in the account currency.

## Auth & profile

| Method | Path | Notes |
| --- | --- | --- |
| POST | /api/auth/login | `{ username, password }` -> `{ token, expiresAt, user }` |
| POST | /api/auth/logout | 204 |
| GET | /api/me | current user |
| PATCH | /api/me | `{ displayName?, timezone?, emailNotifications? }` |
| POST | /api/me/password | `{ currentPassword, newPassword }`, revokes sessions |

## Accounts & activity

| Method | Path | Notes |
| --- | --- | --- |
| GET | /api/accounts | caller's open accounts |
| GET | /api/accounts/:accountId | owner or staff |
| PATCH | /api/accounts/:accountId | rename `{ name }` |
| GET | /api/accounts/:accountId/transactions | `?limit=1..200&offset=0..`, newest first, `{ items, total, limit, offset }` |
| GET | /api/transactions/:entryId | single ledger entry |
| GET | /api/accounts/:accountId/statements | available periods |
| GET | /api/accounts/:accountId/statements/:period | `YYYY-MM`, `?format=json|text` |
| GET | /api/dashboard | cached summary + recent activity |

## Transfers

| Method | Path | Notes |
| --- | --- | --- |
| POST | /api/transfers | header `Idempotency-Key` (8-64 chars), body `{ fromAccountId, toAccount, amount, memo? }`; 201 created, 200 replay, 409 key reused with another payload |
| POST | /api/transfers/preview | validates without moving money, returns `remainingTodayMinor` |
| GET | /api/transfers | caller's transfers, newest first |
| GET | /api/transfers/:transferId | |

Business errors: `INSUFFICIENT_FUNDS`, `DAILY_LIMIT_EXCEEDED`,
`CURRENCY_MISMATCH`, `ACCOUNT_FROZEN` (all 422).

## Cards, notifications, support

| Method | Path |
| --- | --- |
| GET | /api/cards |
| POST | /api/accounts/:accountId/cards |
| POST | /api/cards/:cardId/freeze, /unfreeze, /report-lost |
| PUT | /api/cards/:cardId/limit |
| GET | /api/notifications (`?unread=true`) |
| POST | /api/notifications/:id/read, /api/notifications/read-all |
| GET/POST | /api/support/tickets |
| GET | /api/support/tickets/:ticketId |
| POST | /api/support/tickets/:ticketId/messages, /close |

## Admin (role admin unless noted)

| Method | Path |
| --- | --- |
| POST | /api/admin/accounts |
| POST | /api/admin/accounts/:accountId/deposits, /freeze, /unfreeze |
| POST | /api/admin/transfers/:transferId/reverse |
| GET | /api/admin/users (admin, support) |
| GET | /api/admin/cache, POST /api/admin/cache/clear |
| POST | /api/admin/outbox/drain |
