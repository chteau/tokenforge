# New service: `shorty`

Build **`shorty`**, a small URL-shortener HTTP service in Java. It stores links in a JSON data file, redirects short codes to their target URLs, enforces validation and rate-limiting rules, and reports statistics. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Java 21**, JDK only: use the built-in `com.sun.net.httpserver` HTTP server and write the JSON parsing and encoding yourself. No third-party libraries, no Maven or Gradle, nothing downloaded.
- Put the code in a named package (not the default package), split into several classes in separate files (for example: JSON, storage, business rules, HTTP handling, entry point). All writes to the data file go through a single storage class.
- Provide two bash scripts at the repository root:
  - **`./build.sh`** compiles the code with `javac` and packages **`build/shorty.jar`**, runnable as `java -jar build/shorty.jar ...`.
  - **`./test.sh`** builds, then compiles and runs your own tests (a small self-written test runner with assertions is fine; there is no JUnit), and exits non-zero if any test fails.
- Your sources must compile without warnings under `javac -Xlint:all`.
- Update the README with a short build, run and API section.

## Running

```
java -jar build/shorty.jar --port PORT --data FILE [--base-url URL] [--rate-limit N]
```

- Listens on `127.0.0.1:PORT` (1–65535). Once it accepts connections it prints `listening on http://127.0.0.1:PORT` to stdout.
- `--data FILE`: the data file (see below). A missing file means no links yet; it is created on the first change, together with missing parent directories.
- `--base-url URL`: prefix of the returned `short_url` (default `http://localhost:PORT`; trailing `/` removed).
- `--rate-limit N`: the creation rate limit per client (default `30`, see below).
- A missing or invalid argument prints `error: ...` to stderr and exits with code 2. A data file that cannot be read or parsed prints `error: ...` to stderr and exits with code 1. The server runs until it is killed; it must handle requests concurrently and correctly.

## HTTP API

All responses except `302` and `204` have a JSON body and `Content-Type: application/json; charset=utf-8`. Errors are `{"error": "<message>"}` with the exact messages below. Requests and responses use UTF-8.

A **link object** has exactly these fields:

```json
{"code": "aZ3x9Qp", "url": "https://example.com/page", "short_url": "http://localhost:8080/aZ3x9Qp",
 "created_at": "2026-03-01T10:00:00Z", "expires_at": null, "hits": 0, "expired": false}
```

Timestamps are UTC in the form `YYYY-MM-DDTHH:MM:SSZ` (whole seconds, truncated). `expires_at` is `null` or a timestamp; a link is expired once the current time is at or after `expires_at`.

| method and path | success | notes |
|---|---|---|
| `GET /healthz` | `200 {"status":"ok"}` | |
| `POST /api/links` | `201` link object (or `200`, see de-duplication) | create a link |
| `GET /api/links?limit=N&offset=M` | `200 {"total": T, "links": [...]}` | list |
| `GET /api/links/<code>` | `200` link object | also for expired links (with `"expired": true`) |
| `DELETE /api/links/<code>` | `204`, empty body | |
| `GET /api/stats` | `200` stats object | |
| `GET /<code>` | `302` with `Location: <url>`, empty body | counts a hit |

An unknown code gives `404 {"error":"not found"}`, and so does any other path. A known path with the wrong method gives `405 {"error":"method not allowed"}`.

### Creating links: `POST /api/links`

The body is a JSON object: `{"url": "...", "code": "...", "ttl_seconds": N}`. Only `url` is required; unknown fields are ignored. Checks happen in this order, and the first failure is returned:

1. **Rate limit** (`429 {"error":"rate limit exceeded"}`): each client IP may make at most `N` (`--rate-limit`) `POST /api/links` requests in any sliding 60-second window. Every such request counts, valid or not, except those rejected with 429. A 429 response carries a `Retry-After` header: whole seconds (at least 1) until the oldest counted request leaves the window.
2. `Content-Type` must start with `application/json` (case-insensitive), else `415 {"error":"unsupported media type"}`.
3. A body larger than 8192 bytes: `413 {"error":"payload too large"}`.
4. The body must be valid JSON and an object, else `400 {"error":"invalid json"}`.
5. `url` must be a string of at most 2048 characters, start with `http://` or `https://` (scheme case-insensitive), followed by at least one character that is not `/`, `?`, `#` or whitespace, and contain no whitespace or control characters anywhere. Else `400 {"error":"invalid url"}`.
6. `code`, if present (and not `null`), must be a string matching `[A-Za-z0-9_-]{3,32}` and not be `api` or `healthz`. Else `400 {"error":"invalid code"}`.
7. `ttl_seconds`, if present (and not `null`), must be a JSON integer from 1 to 315360000. Else `400 {"error":"invalid ttl_seconds"}`. The link then expires at `created_at + ttl_seconds`.
8. A custom `code` that already exists (expired or not): `409 {"error":"code already exists"}`.

Without a custom code, the service generates a random 7-character code from `[A-Za-z0-9]` that is not taken yet. **De-duplication:** a request with neither `code` nor `ttl_seconds` whose `url` equals (exactly) the `url` of an existing link without expiry returns that existing link (the oldest one) with status `200` instead of creating a new one.

### Redirects: `GET /<code>`

Unknown code: `404`. Expired link: `410 {"error":"link expired"}` (not counted). Otherwise respond `302` with `Location` set to the link's `url` and add 1 to its `hits`. Concurrent requests must not lose hits.

### Listing: `GET /api/links`

Links in creation order. `limit` defaults to 50 and must be an integer from 1 to 100, else `400 {"error":"invalid limit"}`; `offset` defaults to 0 and must be a non-negative integer, else `400 {"error":"invalid offset"}`. `total` is the number of stored links (including expired ones).

### Statistics: `GET /api/stats`

```json
{"total_links": 3, "total_hits": 7, "top": [{"code": "abc", "url": "https://a", "hits": 5}, ...]}
```

`total_links` counts every stored link (including expired ones); `total_hits` is the sum of all hits. `top` holds at most 5 links with at least one hit, ordered by hits descending, then code ascending.

## Data file

The data file is a JSON document of this shape (the server must accept any valid JSON of this shape: any whitespace, any key order, unknown keys ignored; strings may use any JSON escape):

```json
{"links": [
  {"code": "abc", "url": "https://example.com", "created_at": "2026-03-01T10:00:00Z",
   "expires_at": null, "hits": 3}
]}
```

Links appear in creation order. After any request that changes data (create, delete, a counted redirect) the file reflects the change before the response is sent, and the file is replaced atomically (write a temporary file, then rename it over the data file), so it is never left half-written. Restarting the server with the same file must restore every link, its timestamps and its hit count.
