# Filter and export account activity

Customers want to find specific transactions on their account activity and download them for their accounting software. Add filtering to the account activity API and page, plus a CSV export.

## 1. Filters on `GET /api/accounts/:accountId/transactions`

Add these optional query parameters. They can be combined (all given conditions must match) and work together with the existing `limit`/`offset` paging:

| Parameter | Meaning |
| --- | --- |
| `from`, `to` | Calendar dates `YYYY-MM-DD`, both **inclusive**. An entry's date is the calendar date of its `postedAt` **in the signed-in user's profile time zone** (the `timezone` of `GET /api/me`). |
| `type` | `credit` or `debit`. |
| `minAmount`, `maxAmount` | Decimal amounts in the account's currency, e.g. `10`, `12.5`, `1450.00`, both **inclusive**, compared with the entry's (unsigned) amount. |
| `q` | Case-insensitive substring search over the entry's description, counterparty and reference. Surrounding whitespace is ignored. At most 100 characters. |

- Paging is applied **after** filtering: `total` is the number of matching entries and `items` is the requested page of them, still newest first.
- Empty parameters (`?q=`) are treated as absent. Unknown parameters are ignored.
- Invalid values are rejected with HTTP 400 and the usual error body `{ "error": { "code": "VALIDATION_ERROR", "message": ..., "details": [{ "field": ..., "message": ... }] } }`, where `field` is the name of the offending parameter. This covers: impossible or malformed dates, an unknown `type`, amounts that are not non-negative decimals or have more decimal places than the account currency allows (e.g. `1.234` for USD, `10.5` for JPY), and a `q` longer than 100 characters. If `from` is after `to`, report field `to`; if `minAmount` is greater than `maxAmount`, report field `maxAmount`.
- Authorization is unchanged: whoever may list an account's transactions today may filter them; customers get 404 for accounts they do not own.

## 2. CSV export: `GET /api/accounts/:accountId/transactions.csv`

- Same authentication, authorization and filter parameters (and the same 400 JSON validation errors) as the list endpoint. `limit`/`offset` do not apply: the export contains **every** matching entry, newest first (same order as the list).
- Response: status 200, `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<account number>-transactions.csv"` (for example `QM-1000-0001-transactions.csv`).
- First line is exactly:
  `date,description,counterparty,reference,type,amount,currency,balance_after`
- One line per entry:
  - `date`: the entry's calendar date `YYYY-MM-DD` in the signed-in user's time zone (same rule as the filters).
  - `description`, `counterparty`, `reference`: the text; an empty field when the value is null.
  - `type`: `credit` or `debit`.
  - `amount`: signed decimal with the currency's number of decimal places and no thousands separators or currency symbol; debits are negative, credits have no sign (`-12.50`, `3150.00`, `-98000` for JPY).
  - `currency`: ISO code.
  - `balance_after`: the balance after the entry, formatted like `amount`.
- Spreadsheet formula protection: if a `description`, `counterparty` or `reference` value starts with `=`, `+`, `-` or `@`, prefix it with a single quote `'`. Never alter `amount` or `balance_after`.
- Quoting (applied after the formula protection): a field is wrapped in double quotes only if it contains a comma, a double quote, a CR or a LF; double quotes inside it are doubled. Other fields are not quoted.
- Every line, including the last one, ends with CRLF (`\r\n`). With no matching entries the body is just the header line plus CRLF. No byte order mark.

Example line: `2026-08-27,"Dinner at ""The Anchor"", Pier 9",The Anchor,,debit,-38.40,USD,5675.32`

## 3. Account activity page `/accounts/:accountId/transactions`

- Accepts the same filter query parameters (alongside the existing `limit`/`offset`) and lists only matching entries. The "Showing X–Y of N" line uses the filtered count.
- Shows a filter form submitted with `GET` to the same page, with fields named `from`, `to`, `type` (a select with an empty "all" option plus `credit` and `debit`), `minAmount`, `maxAmount` and `q`. Each field is pre-filled with the value currently in effect (the matching `type` option is `selected`). Values must be HTML-escaped.
- The pagination links (`rel="prev"` / `rel="next"`) keep the active filters.
- Shows an "Export CSV" link to `/api/accounts/<accountId>/transactions.csv` whose query string carries the active filters (only non-empty ones, without `limit`/`offset`).
- Invalid filter values make the page respond with status 400 (the existing error page is fine).

Follow the existing conventions of the codebase and add tests for the new behaviour.
