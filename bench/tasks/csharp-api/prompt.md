# Build the Bramble Library loans API

This repository is almost empty (a README and a `.gitignore`). Please build a small HTTP API for a lending library — books, members and loans with due dates and overdue fines — in **C# on .NET 8** using **ASP.NET Core minimal APIs**. Other teams will run their clients and integration tests against it, so paths, status codes, headers and JSON bodies must match the contract below exactly.

## Project layout and constraints

- Solution file `LibraryApi.sln` at the repository root that includes every project, so `dotnet build` and `dotnet test` work from the root.
- The web app project is **`src/LibraryApi/LibraryApi.csproj`** (`Microsoft.NET.Sdk.Web`, `net8.0`, assembly name `LibraryApi`). It must build with `dotnet publish src/LibraryApi/LibraryApi.csproj -c Release -o out` and run with `dotnet out/LibraryApi.dll ...`.
- **No third-party NuGet packages in the app**: only the .NET 8 SDK and the shared ASP.NET Core framework.
- Enable nullable reference types. The build must produce **no compiler warnings**, and the code must be clean under `dotnet format --verify-no-changes`.
- Add automated tests in a test project under `tests/` (e.g. `tests/LibraryApi.Tests/`). xUnit and `Microsoft.AspNetCore.Mvc.Testing` may be used in the test project. `dotnet test` must pass.
- Data lives in memory only (loaded from the seed file at startup, never written back). The store must be safe for concurrent requests.
- Organise the code however you like, but keep the HTTP endpoint definitions separate from the domain rules and the storage.
- All "current time" decisions (loan dates, due dates, overdue status, fines, `/health`) must go through an injectable clock so that the time can be fixed from configuration (see `--now`).
- Create `data/seed.json` with the sample seed shown below.

## Running

```
dotnet out/LibraryApi.dll --urls http://127.0.0.1:5005 [--seed PATH] [--now INSTANT]
```

- `--urls` (standard ASP.NET Core option) sets the listen address.
- Seed file: `--seed PATH`, otherwise the `LIBRARY_SEED` environment variable, otherwise `data/seed.json` relative to the current directory. If the seed file is missing or is not valid JSON, the process must exit with a **non-zero** status instead of serving.
- Clock: `--now INSTANT`, otherwise the `LIBRARY_NOW` environment variable (an ISO-8601 UTC instant such as `2026-03-10T09:00:00Z`). When set, the clock is **frozen** at that instant for the life of the process. When not set, the real current UTC time is used.
- API key: the `LIBRARY_API_KEY` environment variable; if unset or empty, the key is `dev-key`.
- Command-line options win over environment variables.

## Seed file

```json
{
  "books": [
    {"id": 1, "isbn": "9780000000011", "title": "The Silent Orchard", "author": "Mara Quill", "year": 2011, "copies": 2},
    {"id": 2, "isbn": "9780000000028", "title": "Rivers of Bronze", "author": "Tomas Ewe", "year": 1998, "copies": 1},
    {"id": 3, "isbn": "9780000000035", "title": "Small Lanterns", "author": "Ines Varga", "year": 2019, "copies": 3}
  ],
  "members": [
    {"id": 1, "name": "Ada Brook", "email": "ada@example.org"},
    {"id": 2, "name": "Ben Hollis", "email": "ben@example.org"}
  ],
  "loans": [
    {"id": 1, "bookId": 1, "memberId": 1, "loanedAt": "2026-02-01T10:00:00Z", "dueAt": "2026-02-15T10:00:00Z", "returnedAt": "2026-02-18T16:30:00Z"},
    {"id": 2, "bookId": 2, "memberId": 2, "loanedAt": "2026-02-20T09:00:00Z", "dueAt": "2026-03-06T09:00:00Z", "returnedAt": null}
  ]
}
```

Seed records are trusted and loaded as-is with their ids (any of the three arrays may be empty). New records get id `max(existing ids of that kind, 0) + 1`, then increase by one per creation; ids are never reused.

## General rules

- JSON property names are **camelCase**. Successful responses with a body use `Content-Type: application/json`.
- Timestamps are ISO-8601 UTC strings, e.g. `"2026-03-10T09:00:00Z"`.
- **Errors are RFC 7807 Problem Details** with `Content-Type: application/problem+json` and at least `type` (string), `title` (string) and `status` (the HTTP status code as an integer):
  - `400` validation failures: `title` is `"One or more validation errors occurred."` and an `errors` object maps each failing field / query parameter name (camelCase, exactly as in the request) to an array of one or more message strings. List **every** failing field, and only failing fields.
  - `400` for a request body that is missing, not valid JSON, not a JSON object, or has a field of the wrong JSON type (e.g. `"year": "2001"`): Problem Details with `status` 400 (`errors` optional).
  - `401`: `title` `"Unauthorized"`.
  - `404`: `title` `"Not Found"` and a non-empty `detail` string (e.g. `"book 42 not found"`).
  - `409`: `title` `"Conflict"` and a non-empty `detail` string explaining the conflict.
- A path id that is not a positive integer or matches no record gives `404`.
- A JSON body field that is missing is treated like its zero value (`""`/`null` for strings, `0` for numbers) and validated accordingly. Unknown body fields are ignored.

## Authentication

Every `POST` and `DELETE` route requires the header `X-Api-Key: <key>` with the exact configured key. If it is missing or wrong, respond `401`. Authentication is checked **before anything else** (before reading the body, before looking up ids). `GET` routes never require the key.

## Representations

Book:

```json
{"id": 1, "isbn": "9780000000011", "title": "The Silent Orchard", "author": "Mara Quill", "year": 2011, "copies": 2, "availableCopies": 2}
```

`availableCopies` = `copies` minus the number of **unreturned** loans of that book.

Member:

```json
{"id": 1, "name": "Ada Brook", "email": "ada@example.org", "activeLoans": 0, "totalFinesCents": 75}
```

`activeLoans` = number of unreturned loans of the member; `totalFinesCents` = sum of `fineCents` over **all** of the member's loans (returned and unreturned).

Loan:

```json
{"id": 2, "bookId": 2, "memberId": 2, "loanedAt": "2026-02-20T09:00:00Z", "dueAt": "2026-03-06T09:00:00Z",
 "returnedAt": null, "status": "overdue", "daysOverdue": 4, "fineCents": 100}
```

- `end` is `returnedAt` for a returned loan, otherwise the clock's current time.
- `daysOverdue` = the number of calendar days (UTC dates) from the date of `dueAt` to the date of `end`, or `0` if that is negative. A loan that ends on its due date is not overdue.
- `fineCents` = `25 × daysOverdue`, capped at `1000`.
- `status` is `"returned"` if `returnedAt` is set, else `"overdue"` if `daysOverdue > 0`, else `"active"`.

## Paginated lists

List endpoints return `200` with:

```json
{"items": [ ... ], "page": 1, "pageSize": 10, "totalItems": 3, "totalPages": 1}
```

- `page`: integer `>= 1`, default `1`. `pageSize`: integer from `1` to `50`, default `10`.
- Filters apply before pagination; `totalItems` counts the filtered records; `totalPages` = `ceil(totalItems / pageSize)` (`0` when there are none). A page past the end gives `200` with `"items": []`.
- An empty query value (e.g. `?author=`) counts as not given; unknown query parameters are ignored.
- Any invalid query value gives the `400` validation problem with the parameter name as the `errors` key (e.g. `{"errors": {"pageSize": ["must be between 1 and 50"]}}`).

## Endpoints

### `GET /health`

`200` `{"status": "ok", "now": "<clock's current time>"}`.

### `GET /books`

Query parameters: `author` (case-insensitive substring match), `available` (`true`: only books with `availableCopies > 0`; `false`: only books with `availableCopies == 0`), `sort` (one of `id`, `title`, `year`, optionally prefixed with `-` for descending; default `id`), `page`, `pageSize`. Titles compare ordinally (byte-wise). Books equal on the sort key are always ordered by `id` ascending, whatever the direction.

### `GET /books/{id}`

`200` with the book, or `404`.

### `POST /books` (key)

Body: `{"isbn", "title", "author", "year", "copies"}`. `201` with the created book (`availableCopies` = `copies`) and header `Location: /books/{id}`.

| field    | rule                                     |
|----------|------------------------------------------|
| `isbn`   | exactly 13 ASCII digits                  |
| `title`  | not blank, at most 200 characters        |
| `author` | not blank, at most 100 characters        |
| `year`   | integer from 1450 to 2100                |
| `copies` | integer from 1 to 100                    |

Strings are stored as sent. If the body is valid but another book already has that `isbn`: `409`.

### `DELETE /books/{id}` (key)

`204` with an empty body. `404` if it does not exist; `409` if the book has unreturned loans. Returned loans of a deleted book stay visible under `/loans`.

### `GET /members/{id}`

`200` with the member, or `404`.

### `POST /members` (key)

Body: `{"name", "email"}`. `201` with the member and `Location: /members/{id}`. Rules: `name` not blank, at most 100 characters; `email` at most 254 characters, no whitespace, exactly one `@`, a non-empty part before it, and a part after it that contains a `.` that is neither its first nor its last character. An `email` already used by another member (compared case-insensitively): `409`.

### `GET /loans`

Query parameters: `memberId`, `bookId` (positive integers; exact match), `status` (`active`, `overdue` or `returned`; matches the loan's computed `status`), `page`, `pageSize`. Ordered by `id` ascending.

### `GET /loans/{id}`

`200` with the loan, or `404`.

### `POST /loans` (key)

Body: `{"bookId", "memberId"}`. Creates a loan with `loanedAt` = now and `dueAt` = now + 14 days (same time of day). `201` with the loan and `Location: /loans/{id}`. Checks, in this order:

1. `401` (key), then `400` for a malformed body, then `400` validation: `bookId` and `memberId` must be positive integers.
2. `404` if the member does not exist, then `404` if the book does not exist.
3. `409` if the member has any loan whose status is `overdue`.
4. `409` if the member already has 3 unreturned loans.
5. `409` if the book has no available copy.

### `POST /loans/{id}/return` (key)

No body. Sets `returnedAt` = now and returns `200` with the updated loan (its fine is fixed at that point). `404` if the loan does not exist; `409` if it was already returned.
