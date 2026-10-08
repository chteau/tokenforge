# Scheduled transfers

Customers want to schedule an internal transfer for a future date (rent on the 1st, a payment to a friend next week). Implement scheduled transfers end to end: API, execution, web page and persistence.

## Scheduling: `POST /api/scheduled-transfers`

- Requires the `Idempotency-Key` header (same format rules as for `POST /api/transfers`; missing → 400).
- JSON body: `{ "fromAccountId", "toAccount", "amount", "memo"?, "scheduledDate" }`. `fromAccountId`, `toAccount` (destination account id or account number), `amount` and `memo` mean exactly what they mean for an immediate transfer, and are validated with the same rules and errors at scheduling time (unknown or not-owned source account → 404, unknown destination → 404, same account / bad amount → 400 `VALIDATION_ERROR`, currency mismatch → 422 `CURRENCY_MISMATCH`, inactive account → 422 `ACCOUNT_FROZEN`).
- `scheduledDate` is a calendar date `YYYY-MM-DD` in the customer's profile time zone (`timezone` of `GET /api/me`, taken at scheduling time). The transfer executes at **09:00 local time** on that date; this instant is stored as `executeAt` and does not change if the customer later changes their time zone.
- `scheduledDate` is rejected with 400 `VALIDATION_ERROR` and a `details` entry with `field: "scheduledDate"` when it is not a real date, when its `executeAt` is not strictly after the current time (so today is allowed only before 09:00 local), or when it is more than 365 days after today's local date (today + 365 days is still allowed).
- The daily limit and available funds are **not** checked when scheduling; they are checked at execution.
- Success: `201` with `{ "scheduledTransfer": <object> }`. Repeating the request with the same key and the same payload returns `200` with the original object (nothing new is created). The same key with a different payload returns `409` with code `IDEMPOTENCY_CONFLICT`. Keys are per customer.

The scheduled transfer object:

```json
{
  "id": "…",
  "fromAccountId": "acc_…",
  "toAccountId": "acc_…",
  "amountMinor": 2500,
  "amount": "25.00",
  "currency": "USD",
  "memo": "Rent",
  "scheduledDate": "2026-11-02",
  "timezone": "America/New_York",
  "executeAt": "2026-11-02T14:00:00.000Z",
  "status": "scheduled",
  "transferId": null,
  "failureReason": null,
  "createdAt": "…"
}
```

`status` is one of `scheduled`, `completed`, `failed`, `cancelled`.

## Reading and cancelling

- `GET /api/scheduled-transfers` → `{ "items": [...] }`: the caller's own scheduled transfers (all statuses), ordered by `executeAt` ascending.
- `GET /api/scheduled-transfers/:id` → `{ "scheduledTransfer": … }`; 404 if it does not exist or belongs to someone else.
- `DELETE /api/scheduled-transfers/:id` cancels it: `200` with the object in status `cancelled`. Only the owner may cancel (others get 404). Only a transfer still in status `scheduled` can be cancelled; otherwise respond `409` with code `INVALID_TRANSITION`.

## Execution

- `POST /api/admin/scheduled-transfers/run` (role `admin` only; other signed-in users get 403) executes every scheduled transfer whose status is `scheduled` and whose `executeAt` is at or before the current time of the application clock, in `executeAt` order, and responds `200` with `{ "processed": n, "completed": n, "failed": n }`. Transfers that are not due yet are left untouched.
- Each due transfer is executed exactly like an immediate transfer made by its owner at that moment: same ownership/status/currency checks, the owner's daily transfer limit for the local day of execution (earlier completed transfers that day, scheduled or not, count towards it), sufficient funds, ledger postings, balances, dashboard freshness and the usual "transfer sent/received" notifications. The resulting transfer appears in `GET /api/transfers` with `"channel": "scheduled"`.
- On success the scheduled transfer becomes `completed` and `transferId` is the id of the resulting transfer.
- If a business rule rejects it (for example insufficient funds, daily limit exceeded, a frozen account), it becomes `failed`, `failureReason` is the error code (e.g. `"INSUFFICIENT_FUNDS"`, `"DAILY_LIMIT_EXCEEDED"`), no money moves, and the owner gets an in-app notification with kind `scheduled_transfer_failed`. Other due transfers in the same run are still processed.
- Running the executor again must never execute a scheduled transfer twice.

## Web page

- `GET /transfers/scheduled` (signed in) lists the customer's scheduled transfers (date, amount, status) and contains a form `method="post" action="/transfers/scheduled"` with fields `fromAccountId`, `toAccount`, `amount`, `scheduledDate`, `memo` and a hidden `idempotencyKey`.
- `POST /transfers/scheduled` (form-encoded, same fields) creates the scheduled transfer and redirects with `303` to `/transfers/scheduled`. On a validation or business error it re-renders the page showing the error, with the HTTP status of that error (e.g. 400) and creates nothing.
- Each row still in status `scheduled` has a cancel form posting to `/transfers/scheduled/:id/cancel`, which cancels it and redirects with `303` to `/transfers/scheduled`.

## Persistence

Scheduled transfers must survive a restart when the app runs with a data file, like the other data.

Follow the existing architecture and conventions, and add tests.
