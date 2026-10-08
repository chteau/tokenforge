# Build the Shelfwise mock books API

This repository is almost empty: it has a `go.mod` (`module example.com/mockapi`, `go 1.26`), a README and a sample seed file at `data/seed.json`. Please build a small mock REST back-end for a bookstore catalogue in Go, as a single HTTP server, following the contract below exactly. Other teams will run their front-ends and integration tests against it, so status codes, headers and JSON bodies must match the contract to the letter.

Constraints:

- **Go standard library only.** There is no network access to download modules; do not add any `require` to `go.mod`.
- The main package must live at the **repository root**, so that `go build -o api .` produces the server binary.
- Use `net/http` with the Go 1.22+ `ServeMux` method patterns (e.g. `"GET /books/{id}"`) for routing.
- Data lives in memory only (no database, no writing back to disk). The store must be safe for concurrent requests.
- Organise the code however you like, but keep HTTP handling separate from the storage logic.
- Code must be `gofmt`-clean and pass `go vet ./...`. Please add tests (`go test ./...` must pass).

## Running the server

```
./api [-addr ADDR] [-seed PATH]
```

- `-addr`: listen address, e.g. `127.0.0.1:9000`. If the flag is not given and the `PORT` environment variable is set, listen on `:$PORT`. Otherwise listen on `:8080`. The flag wins over `PORT`.
- `-seed`: path to the seed JSON file (default `data/seed.json`). If the file cannot be read or is not valid JSON, the process must exit with a non-zero status (without serving).
- `API_TOKEN` environment variable: the bearer token required on write routes. If unset or empty, the token is `dev-token`.
- **Graceful shutdown:** on `SIGINT` or `SIGTERM` the server stops accepting connections, lets in-flight requests finish (allow up to 5 seconds), and the process exits with status **0**.

### Seed file format

```json
{
  "books": [
    {"id": 1, "isbn": "9780000000011", "title": "The Silent Orchard", "author": "Mara Quill",
     "genre": "fiction", "year": 2011, "price_cents": 1499}
  ]
}
```

Seed books are loaded as-is with their given ids (they are trusted; no validation needed). The `books` array may be empty. Newly created books get id `max(existing seed ids, 0) + 1`, then increasing by one per creation. Ids are never reused, even after a delete.

## Resource: book

Every book is returned as a JSON object with exactly these fields:

```json
{"id": 7, "isbn": "9780000000073", "title": "Example", "author": "Some One",
 "genre": "fiction", "year": 2020, "price_cents": 1250}
```

`id`, `year` and `price_cents` are JSON integers; the others are strings.

## General rules

- Every response that has a body has the header `Content-Type: application/json` (this includes error responses). `204` responses have an empty body.
- All errors use this shape (the `fields` member only appears on `422`):

  ```json
  {"error": {"code": "not_found", "message": "book not found"}}
  ```

- An `{id}` path segment that is not a positive base-10 integer, or that matches no book, gives `404` `{"error":{"code":"not_found","message":"book not found"}}`.
- A request with a method the path does not support (e.g. `PATCH /books/1`) gives `405`.

## Authentication (write routes only)

`POST /books`, `PUT /books/{id}` and `DELETE /books/{id}` require the header `Authorization: Bearer <token>` with the exact configured token. If the header is missing, malformed, or the token is wrong, respond `401` with:

```json
{"error": {"code": "unauthorized", "message": "missing or invalid token"}}
```

Authentication is checked **before** anything else (before the id lookup and before reading the body). Read routes (`GET`) never require a token.

## Endpoints

### `GET /health`

`200` `{"status": "ok"}`.

### `GET /books`

Lists books with filtering, sorting and pagination. Response `200`:

```json
{
  "data": [ {book}, ... ],
  "pagination": {"page": 1, "per_page": 10, "total": 5, "total_pages": 1}
}
```

Query parameters (all optional):

| param      | meaning                                                                                       | default |
|------------|-----------------------------------------------------------------------------------------------|---------|
| `genre`    | keep books whose genre equals the value exactly                                               |         |
| `author`   | keep books whose author contains the value, case-insensitively                                |         |
| `min_year` | keep books with `year >= min_year` (integer)                                                  |         |
| `max_year` | keep books with `year <= max_year` (integer)                                                  |         |
| `sort`     | one of `id`, `title`, `author`, `year`, `price_cents`                                         | `id`    |
| `order`    | `asc` or `desc`                                                                               | `asc`   |
| `page`     | integer `>= 1`                                                                                | `1`     |
| `per_page` | integer from `1` to `100`                                                                     | `10`    |

- Filters combine with AND and are applied before pagination. `total` is the number of books matching the filters; `total_pages` is `ceil(total / per_page)` (`0` when `total` is `0`).
- String sorting uses plain byte-wise comparison. Books that compare equal on the sort key are always ordered by `id` ascending, whatever the `order`.
- A page past the end returns `200` with `"data": []` (an empty array, never `null`) and the normal pagination object.
- An empty parameter value (e.g. `?genre=`) counts as not given.
- An invalid value for `min_year`, `max_year`, `sort`, `order`, `page` or `per_page` gives `400` with code `invalid_query` and the message `invalid query parameter: <name>`, e.g.

  ```json
  {"error": {"code": "invalid_query", "message": "invalid query parameter: per_page"}}
  ```

  Unknown query parameters are ignored.

### `GET /books/{id}`

`200` with the book, or `404` as described above.

### `POST /books` (auth)

Request body: a JSON object with `isbn`, `title`, `author`, `genre`, `year`, `price_cents`. Unknown fields (including `id`) are ignored. On success: `201`, the created book as the body, and header `Location: /books/<id>`.

### `PUT /books/{id}` (auth)

Replaces all fields of an existing book (same body and validation as `POST`; the id is kept). `200` with the updated book. Order of checks: auth (`401`), then the book must exist (`404`), then body (`400`/`422`/`409`).

### `DELETE /books/{id}` (auth)

`204` with an empty body; the book is gone afterwards (`GET` gives `404`, it no longer appears in lists).

## Request body validation (POST and PUT)

1. If the body is empty, is not valid JSON, is not a JSON object, or a known field has the wrong JSON type (e.g. `"year": "2001"`), respond `400`:

   ```json
   {"error": {"code": "invalid_json", "message": "request body must be a valid JSON object"}}
   ```

2. Otherwise check every field and respond `422` if any rule fails, listing **every** failing field (and only failing fields) under `fields`. A missing field is treated like its zero value (`""` or `0`).

   ```json
   {"error": {"code": "validation_failed", "message": "validation failed",
              "fields": {"title": "is required", "year": "must be between 1450 and 2100"}}}
   ```

   | field         | rule                                                                 | message when violated                                      |
   |---------------|----------------------------------------------------------------------|------------------------------------------------------------|
   | `isbn`        | not empty                                                            | `is required`                                              |
   | `isbn`        | exactly 13 ASCII digits (only checked when not empty)                | `must be 13 digits`                                        |
   | `title`       | not empty and not only whitespace                                    | `is required`                                              |
   | `title`       | at most 200 characters (Unicode code points)                         | `must be at most 200 characters`                           |
   | `author`      | not empty and not only whitespace                                    | `is required`                                              |
   | `genre`       | one of `fantasy`, `fiction`, `history`, `poetry`, `science`          | `must be one of fantasy, fiction, history, poetry, science` |
   | `year`        | between 1450 and 2100 inclusive                                      | `must be between 1450 and 2100`                            |
   | `price_cents` | greater than 0                                                       | `must be greater than 0`                                   |

   Strings are stored exactly as sent (no trimming).

3. If the body is valid but its `isbn` is already used by **another** book, respond `409`:

   ```json
   {"error": {"code": "conflict", "message": "isbn already exists"}}
   ```

   (A `PUT` that keeps a book's own isbn is not a conflict.)
