# New service: `boxoffice`

Build **`boxoffice`**, a small JSON HTTP API for selling event tickets: events with a fixed capacity, temporary seat holds that expire, purchases made from a hold, partial refunds, and idempotent retries. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **PHP 8.5**, standard library and bundled extensions only (PDO with `pdo_sqlite`, `json`). No Composer, no third-party packages, nothing downloaded. Write your own small autoloader (`spl_autoload_register`).
- The server is started from the repository root with PHP's built-in web server and a front controller:

  ```
  BOXOFFICE_DB=/path/to/file.sqlite php -S 127.0.0.1:8080 -t public public/index.php
  ```

  Every request goes through `public/index.php`. Keep it thin (bootstrap and dispatch only); the code lives in classes under `src/`, split by responsibility (for example HTTP request/response and routing, validation, storage, ticketing logic, idempotency). Every file under `src/` starts with `declare(strict_types=1);`. All SQL goes through PDO prepared statements with bound parameters (never interpolate values into SQL).
- Data is stored in the SQLite file named by the environment variable `BOXOFFICE_DB` (default `var/boxoffice.sqlite`, creating `var/` if needed). The file and the schema are created automatically on first use; data survives server restarts.
- The code must run without PHP warnings, notices or deprecations under `error_reporting=E_ALL`.
- Write your own tests: `php tests/run.php` from the repository root must run them and exit 0 when they all pass (non-zero otherwise). PHPUnit is not available, so write a tiny runner. Tests may call your classes directly and/or start the built-in server.
- Update the README with how to run the server and the tests.

## Time

Every request may carry a header `X-Clock: <timestamp>`. When present, that instant is "now" for the whole request; otherwise the real current time is used. Timestamps everywhere (requests, responses, `X-Clock`) use exactly the UTC format `YYYY-MM-DDTHH:MM:SSZ` (for example `2026-05-01T19:30:00Z`) and must be a real calendar date and time. A malformed `X-Clock` is a `400 invalid_clock` error.

## Responses and errors

- Every response body is JSON with `Content-Type: application/json` (no trailing HTML, no PHP output).
- Errors: `{"error": {"code": "<code>", "message": "<human readable>"}}`. Validation errors (422) add `"fields": {"<field>": "<message>", ...}` with one entry per invalid field (all invalid fields, not only the first).
- Request bodies must be a JSON object; anything else (invalid JSON, an array, a scalar, an empty body where a body is required) is `400 invalid_json`. Unknown fields are ignored. Types are strict: an integer field accepts only a JSON integer (not `"5"`, `5.0`, or `true`).
- An unknown path is `404 not_found`. A known path with an unsupported method is `405 method_not_allowed` with an `Allow` header listing the supported methods (for example `Allow: GET, POST`). Path ids are positive decimal integers; any other id segment (`/events/abc`, `/events/0`) is `404 not_found`. A trailing query string is ignored when routing.

## Resources

**Event**: `{"id", "name", "venue", "starts_at", "capacity", "price_cents", "available", "held", "sold"}`. `held` is the total quantity of active (unexpired, unreleased, unpurchased) holds at "now", `sold` is tickets purchased minus tickets refunded, and `available = capacity - held - sold`.

**Hold**: `{"id", "event_id", "quantity", "status", "expires_at", "created_at"}` with `status` one of `active`, `expired`, `released`, `purchased`, computed at "now": a hold that was never released or purchased is `active` while `now < expires_at` and `expired` from `expires_at` on.

**Purchase**: `{"id", "event_id", "hold_id", "email", "quantity", "amount_cents", "refunded_quantity", "refunded_cents", "status", "created_at", "refunds"}`. `amount_cents = quantity * price_cents` (price at purchase time). `status` is `paid` (nothing refunded), `partially_refunded`, or `refunded` (every ticket refunded). `refunds` is the list of refund objects, oldest first.

**Refund**: `{"id", "purchase_id", "quantity", "amount_cents", "created_at"}` with `amount_cents = quantity * (purchase amount_cents / purchase quantity)`.

Ids are integers assigned 1, 2, 3, ... per resource type.

## Endpoints

| method and path | success | body |
|---|---|---|
| `POST /events` | 201, the event | `name`, `venue`, `starts_at`, `capacity`, `price_cents` |
| `GET /events` | 200, `{"events": [...]}` | ordered by `starts_at`, then `id` |
| `GET /events/{id}` | 200, the event | |
| `POST /events/{id}/holds` | 201, the hold | `quantity`, optional `ttl_seconds` |
| `GET /holds/{id}` | 200, the hold | |
| `DELETE /holds/{id}` | 200, the hold with status `released` | |
| `POST /purchases` | 201, the purchase | `hold_id`, `email` |
| `GET /purchases/{id}` | 200, the purchase | |
| `POST /purchases/{id}/refunds` | 201, the refund | optional `quantity` |

`GET /events?upcoming=1` returns only events whose `starts_at` is after "now".

**Validation (422 `validation_failed`):**

- `name`, `venue`: strings, 1 to 200 characters after trimming surrounding whitespace (the trimmed value is stored).
- `starts_at`: a timestamp in the format above. `capacity`: integer 1 to 100000. `price_cents`: integer 0 to 1000000.
- `quantity` (holds): integer 1 to 10. `ttl_seconds`: integer 60 to 3600, default 600; the hold's `expires_at = now + ttl_seconds`.
- `hold_id`: positive integer. `email`: a string of at most 254 characters of the form `local@domain` where neither part is empty or contains whitespace or `@`, and the domain contains a `.` that is neither its first nor its last character.
- refund `quantity`: integer >= 1; when omitted, all remaining (unrefunded) tickets are refunded. The refund body may also be empty (same as `{}`).

A missing required field is reported in `fields` like any other invalid field.

**Business rules (checked after validation, in this order):**

- Holds: unknown event `404 event_not_found`; `now >= starts_at` → `409 event_closed`; `quantity > available` → `409 insufficient_seats`.
- `DELETE /holds/{id}`: unknown `404 hold_not_found`; a hold that is not `active` → `409 hold_not_active`.
- Purchases: unknown hold `404 hold_not_found`; `expired` hold → `409 hold_expired`; `released` or `purchased` hold → `409 hold_not_active`. A successful purchase turns the hold into `purchased`; the tickets move from `held` to `sold`.
- Refunds: unknown purchase `404 purchase_not_found`; event started (`now >= starts_at`) → `409 event_closed`; nothing left to refund → `409 already_refunded`; `quantity` greater than the remaining tickets → `409 refund_exceeds_purchase`. Refunded tickets become available again.

## Idempotency

`POST /events`, `POST /purchases` and `POST /purchases/{id}/refunds` accept an optional `Idempotency-Key` header (1 to 255 printable ASCII characters, `0x21`–`0x7E`; anything else is `400 invalid_idempotency_key`).

- The first request with a given key is processed normally and its response (status code and body) is stored, whatever the status, except `5xx`.
- A later request with the same key, the same method and path, and the same body (compared as decoded JSON, so key order and whitespace do not matter) does nothing and returns the stored status and body unchanged, with an extra header `Idempotent-Replayed: true`. It must not create anything, even if "now" or the state has changed since.
- The same key with a different path or a different body is `422 idempotency_key_reused` (nothing is stored for that request).
- Keys are global (shared by all endpoints) and persist across restarts. Requests without the header are never deduplicated.
