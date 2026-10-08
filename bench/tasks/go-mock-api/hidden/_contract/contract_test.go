// Black-box HTTP contract tests. They only talk to the server binary named by API_BIN.
package contract

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const token = "s3cret-token"

const seedJSON = `{"books": [
 {"id": 1, "isbn": "9781000000001", "title": "Dune Road", "author": "Ada Byron", "genre": "fiction", "year": 1999, "price_cents": 1500},
 {"id": 2, "isbn": "9781000000002", "title": "Atlas of Ash", "author": "Ben Carter", "genre": "history", "year": 2005, "price_cents": 2500},
 {"id": 3, "isbn": "9781000000003", "title": "Cold Stars", "author": "Ada Lovelace", "genre": "science", "year": 1999, "price_cents": 900},
 {"id": 4, "isbn": "9781000000004", "title": "Bright Verses", "author": "Cara Diaz", "genre": "poetry", "year": 2010, "price_cents": 1200},
 {"id": 5, "isbn": "9781000000005", "title": "Echo Hall", "author": "ben ross", "genre": "fantasy", "year": 2005, "price_cents": 1500},
 {"id": 6, "isbn": "9781000000006", "title": "Frost Line", "author": "Dan Ek", "genre": "fiction", "year": 2020, "price_cents": 3000},
 {"id": 7, "isbn": "9781000000007", "title": "Glass Garden", "author": "Eve Fox", "genre": "fiction", "year": 1985, "price_cents": 700},
 {"id": 8, "isbn": "9781000000008", "title": "Hollow Crown", "author": "Ada Byron", "genre": "fantasy", "year": 2015, "price_cents": 2200},
 {"id": 9, "isbn": "9781000000009", "title": "Iron Psalms", "author": "Gus Hale", "genre": "poetry", "year": 1999, "price_cents": 1100},
 {"id": 10, "isbn": "9781000000010", "title": "Jade Atlas", "author": "Hana Ito", "genre": "history", "year": 2012, "price_cents": 1800},
 {"id": 11, "isbn": "9781000000011", "title": "Kite Theory", "author": "Ivo Jung", "genre": "science", "year": 2018, "price_cents": 1500},
 {"id": 15, "isbn": "9781000000015", "title": "Lamp and Ledger", "author": "Jo Kim", "genre": "history", "year": 1970, "price_cents": 2600}
]}`

var genresMsg = "must be one of fantasy, fiction, history, poetry, science"

// ---------- process helpers ----------

type server struct {
	t    *testing.T
	cmd  *exec.Cmd
	base string
	out  *bytes.Buffer
	done chan error
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func binary(t *testing.T) string {
	t.Helper()
	b := os.Getenv("API_BIN")
	if b == "" {
		t.Fatal("API_BIN not set")
	}
	return b
}

func writeSeed(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "seed.json")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func baseEnv(extra ...string) []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "PORT=") || strings.HasPrefix(kv, "API_TOKEN=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, extra...)
}

func launch(t *testing.T, args []string, env []string) *server {
	t.Helper()
	cmd := exec.Command(binary(t), args...)
	cmd.Dir = t.TempDir()
	cmd.Env = env
	out := &bytes.Buffer{}
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s := &server{t: t, cmd: cmd, out: out, done: make(chan error, 1)}
	go func() { s.done <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		select {
		case <-s.done:
		case <-time.After(3 * time.Second):
		}
	})
	return s
}

func (s *server) waitHealthy(base string) {
	s.t.Helper()
	s.base = base
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-s.done:
			s.done <- err
			s.t.Fatalf("server exited early: %v\n%s", err, s.out)
		default:
		}
		resp, err := http.Get(base + "/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	s.t.Fatalf("server not healthy at %s\n%s", base, s.out)
}

func start(t *testing.T) *server { return startWithSeed(t, seedJSON) }

func startWithSeed(t *testing.T, seed string) *server {
	t.Helper()
	port := freePort(t)
	s := launch(t, []string{"-addr", fmt.Sprintf("127.0.0.1:%d", port), "-seed", writeSeed(t, seed)},
		baseEnv("API_TOKEN="+token))
	s.waitHealthy(fmt.Sprintf("http://127.0.0.1:%d", port))
	return s
}

// ---------- HTTP helpers ----------

type reply struct {
	status int
	header http.Header
	raw    []byte
	body   any
}

func (s *server) do(method, path, body, tok string) reply {
	s.t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, s.base+path, r)
	if err != nil {
		s.t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if tok != "" {
		req.Header.Set("Authorization", tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	rep := reply{status: resp.StatusCode, header: resp.Header, raw: raw}
	if len(bytes.TrimSpace(raw)) > 0 {
		_ = json.Unmarshal(raw, &rep.body)
	}
	return rep
}

func (s *server) get(path string) reply { return s.do("GET", path, "", "") }

func bearer() string { return "Bearer " + token }

func parse(t *testing.T, js string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(js), &v); err != nil {
		t.Fatalf("bad expected json %q: %v", js, err)
	}
	return v
}

func expect(t *testing.T, r reply, status int, wantJSON string) {
	t.Helper()
	if r.status != status {
		t.Fatalf("status = %d, want %d; body %s", r.status, status, r.raw)
	}
	if ct := r.header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json; body %s", ct, r.raw)
	}
	if want := parse(t, wantJSON); !reflect.DeepEqual(r.body, want) {
		t.Fatalf("body = %s, want %s", r.raw, wantJSON)
	}
}

func expectStatus(t *testing.T, r reply, status int) {
	t.Helper()
	if r.status != status {
		t.Fatalf("status = %d, want %d; body %s", r.status, status, r.raw)
	}
}

type page struct {
	ids                             []int
	page, perPage, total, totalPage int
	nilData                         bool
}

func listPage(t *testing.T, s *server, path string) page {
	t.Helper()
	r := s.get(path)
	if r.status != 200 {
		t.Fatalf("GET %s: status %d body %s", path, r.status, r.raw)
	}
	if ct := r.header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q", ct)
	}
	var body struct {
		Data       []map[string]any `json:"data"`
		Pagination map[string]any   `json:"pagination"`
	}
	if err := json.Unmarshal(r.raw, &body); err != nil {
		t.Fatalf("GET %s: %v: %s", path, err, r.raw)
	}
	p := page{nilData: body.Data == nil, ids: []int{}}
	for _, b := range body.Data {
		id, _ := b["id"].(float64)
		p.ids = append(p.ids, int(id))
	}
	num := func(k string) int {
		v, ok := body.Pagination[k].(float64)
		if !ok {
			t.Fatalf("GET %s: pagination.%s missing: %s", path, k, r.raw)
		}
		return int(v)
	}
	p.page, p.perPage, p.total, p.totalPage = num("page"), num("per_page"), num("total"), num("total_pages")
	return p
}

func expectIDs(t *testing.T, s *server, path string, want ...int) page {
	t.Helper()
	p := listPage(t, s, path)
	if want == nil {
		want = []int{}
	}
	if !reflect.DeepEqual(p.ids, want) {
		t.Fatalf("GET %s: ids %v, want %v", path, p.ids, want)
	}
	return p
}

func expectMeta(t *testing.T, p page, pg, per, total, pages int) {
	t.Helper()
	if p.page != pg || p.perPage != per || p.total != total || p.totalPage != pages {
		t.Fatalf("pagination = %d/%d/%d/%d, want page=%d per_page=%d total=%d total_pages=%d",
			p.page, p.perPage, p.total, p.totalPage, pg, per, total, pages)
	}
}

const newBook = `{"isbn":"9782000000001","title":"New Moon Notes","author":"Kai Lund","genre":"science","year":2021,"price_cents":4200}`

func bookWithID(id int, js string) string {
	return `{"id":` + strconv.Itoa(id) + `,` + strings.TrimPrefix(js, "{")
}

const book1 = `{"id":1,"isbn":"9781000000001","title":"Dune Road","author":"Ada Byron","genre":"fiction","year":1999,"price_cents":1500}`

const book3 = `{"id":3,"isbn":"9781000000003","title":"Cold Stars","author":"Ada Lovelace","genre":"science","year":1999,"price_cents":900}`

const (
	notFoundBody = `{"error":{"code":"not_found","message":"book not found"}}`
	unauthBody   = `{"error":{"code":"unauthorized","message":"missing or invalid token"}}`
	badJSONBody  = `{"error":{"code":"invalid_json","message":"request body must be a valid JSON object"}}`
	conflictBody = `{"error":{"code":"conflict","message":"isbn already exists"}}`
)

func validationBody(fields string) string {
	return `{"error":{"code":"validation_failed","message":"validation failed","fields":` + fields + `}}`
}

// ---------- health ----------

func TestHealthOK(t *testing.T) {
	s := start(t)
	expect(t, s.get("/health"), 200, `{"status":"ok"}`)
}

// ---------- listing & pagination ----------

func TestListDefaultPage(t *testing.T) {
	s := start(t)
	p := expectIDs(t, s, "/books", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
	expectMeta(t, p, 1, 10, 12, 2)
}

func TestListSecondPage(t *testing.T) {
	s := start(t)
	p := expectIDs(t, s, "/books?page=2", 11, 15)
	expectMeta(t, p, 2, 10, 12, 2)
}

func TestListCustomPerPage(t *testing.T) {
	s := start(t)
	p := expectIDs(t, s, "/books?per_page=5&page=3", 11, 15)
	expectMeta(t, p, 3, 5, 12, 3)
	p = expectIDs(t, s, "/books?per_page=100", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15)
	expectMeta(t, p, 1, 100, 12, 1)
}

func TestListPastEndIsEmptyArray(t *testing.T) {
	s := start(t)
	p := expectIDs(t, s, "/books?page=7&per_page=4")
	if p.nilData {
		t.Fatal(`"data" must be an empty array, not null`)
	}
	expectMeta(t, p, 7, 4, 12, 3)
}

func TestListFullBookObjects(t *testing.T) {
	s := start(t)
	r := s.get("/books?genre=science&max_year=2000")
	expect(t, r, 200, `{"data":[`+book3+`],"pagination":{"page":1,"per_page":10,"total":1,"total_pages":1}}`)
}

// ---------- filtering ----------

func TestFilterGenre(t *testing.T) {
	s := start(t)
	expectMeta(t, expectIDs(t, s, "/books?genre=history", 2, 10, 15), 1, 10, 3, 1)
}

func TestFilterAuthorCaseInsensitive(t *testing.T) {
	s := start(t)
	expectIDs(t, s, "/books?author=BEN", 2, 5)
	expectIDs(t, s, "/books?author=ada%20b", 1, 8)
}

func TestFilterYearRange(t *testing.T) {
	s := start(t)
	expectIDs(t, s, "/books?min_year=1999&max_year=2005", 1, 2, 3, 5, 9)
	expectIDs(t, s, "/books?min_year=2015", 6, 8, 11)
	expectIDs(t, s, "/books?max_year=1985", 7, 15)
}

func TestFilterCombinedWithPagination(t *testing.T) {
	s := start(t)
	expectIDs(t, s, "/books?genre=fiction&min_year=1990", 1, 6)
	p := expectIDs(t, s, "/books?genre=history&per_page=2&page=2", 15)
	expectMeta(t, p, 2, 2, 3, 2)
}

func TestFilterNoMatches(t *testing.T) {
	s := start(t)
	p := expectIDs(t, s, "/books?genre=romance")
	if p.nilData {
		t.Fatal(`"data" must be an empty array, not null`)
	}
	expectMeta(t, p, 1, 10, 0, 0)
}

func TestFilterEmptyValueIgnored(t *testing.T) {
	s := start(t)
	expectMeta(t, listPage(t, s, "/books?genre=&author=&min_year="), 1, 10, 12, 2)
}

// ---------- sorting ----------

func TestSortTitleAsc(t *testing.T) {
	s := start(t)
	expectIDs(t, s, "/books?sort=title&per_page=100", 2, 4, 3, 1, 5, 6, 7, 8, 9, 10, 11, 15)
}

func TestSortTitleDesc(t *testing.T) {
	s := start(t)
	expectIDs(t, s, "/books?sort=title&order=desc&per_page=3", 15, 11, 10)
}

func TestSortPriceDescTieBreakByID(t *testing.T) {
	s := start(t)
	expectIDs(t, s, "/books?sort=price_cents&order=desc&per_page=100", 6, 15, 2, 8, 10, 1, 5, 11, 4, 9, 3, 7)
}

func TestSortYearAscTieBreakByID(t *testing.T) {
	s := start(t)
	expectIDs(t, s, "/books?sort=year&per_page=100", 15, 7, 1, 3, 9, 2, 5, 4, 10, 8, 11, 6)
}

func TestSortAuthorByteWise(t *testing.T) {
	s := start(t)
	expectIDs(t, s, "/books?sort=author&per_page=100", 1, 8, 3, 2, 4, 6, 7, 9, 10, 11, 15, 5)
}

func TestSortWithFilterAndPaging(t *testing.T) {
	s := start(t)
	p := expectIDs(t, s, "/books?genre=history&sort=year&order=desc&per_page=2", 10, 2)
	expectMeta(t, p, 1, 2, 3, 2)
}

// ---------- query validation ----------

func TestQueryInvalidParams(t *testing.T) {
	s := start(t)
	cases := map[string]string{
		"page=0": "page", "page=-2": "page", "page=abc": "page",
		"per_page=0": "per_page", "per_page=101": "per_page", "per_page=x": "per_page",
		"sort=price": "sort", "sort=ID": "sort", "order=up": "order",
		"min_year=old": "min_year", "max_year=1.5": "max_year",
	}
	for q, name := range cases {
		r := s.get("/books?" + q)
		t.Run(q, func(t *testing.T) {
			expect(t, r, 400, `{"error":{"code":"invalid_query","message":"invalid query parameter: `+name+`"}}`)
		})
	}
}

func TestQueryUnknownParamIgnored(t *testing.T) {
	s := start(t)
	expectMeta(t, listPage(t, s, "/books?color=blue&per_page=4"), 1, 4, 12, 3)
}

// ---------- get ----------

func TestGetByID(t *testing.T) {
	s := start(t)
	expect(t, s.get("/books/3"), 200, book3)
}

func TestGetUnknownID(t *testing.T) {
	s := start(t)
	expect(t, s.get("/books/12"), 404, notFoundBody)
	expect(t, s.get("/books/999"), 404, notFoundBody)
}

func TestGetNonNumericID(t *testing.T) {
	s := start(t)
	for _, id := range []string{"abc", "0", "-1", "1.5"} {
		expect(t, s.get("/books/"+id), 404, notFoundBody)
	}
}

// ---------- routing ----------

func TestRoutingMethodNotAllowed(t *testing.T) {
	s := start(t)
	expectStatus(t, s.do("PATCH", "/books/1", `{}`, bearer()), 405)
	expectStatus(t, s.do("DELETE", "/books", "", bearer()), 405)
}

// ---------- auth ----------

func TestAuthMissingToken(t *testing.T) {
	s := start(t)
	expect(t, s.do("POST", "/books", newBook, ""), 401, unauthBody)
	expect(t, s.do("PUT", "/books/1", newBook, ""), 401, unauthBody)
	expect(t, s.do("DELETE", "/books/1", "", ""), 401, unauthBody)
	expect(t, s.get("/books/1"), 200, book1)
	expectMeta(t, listPage(t, s, "/books"), 1, 10, 12, 2)
}

func TestAuthWrongOrMalformedToken(t *testing.T) {
	s := start(t)
	for _, h := range []string{"Bearer wrong", "Token " + token, token, "Bearer", "Bearer " + token + "x", "bearer" + token} {
		expect(t, s.do("POST", "/books", newBook, h), 401, unauthBody)
	}
}

func TestAuthCheckedBeforeLookupAndBody(t *testing.T) {
	s := start(t)
	expect(t, s.do("PUT", "/books/999", `{`, "Bearer nope"), 401, unauthBody)
	expect(t, s.do("DELETE", "/books/999", "", ""), 401, unauthBody)
	expect(t, s.do("POST", "/books", `not json`, ""), 401, unauthBody)
}

func TestAuthDefaultToken(t *testing.T) {
	port := freePort(t)
	srv := launch(t, []string{"-addr", fmt.Sprintf("127.0.0.1:%d", port), "-seed", writeSeed(t, seedJSON)}, baseEnv())
	srv.waitHealthy(fmt.Sprintf("http://127.0.0.1:%d", port))
	expectStatus(t, srv.do("POST", "/books", newBook, "Bearer "+token), 401)
	expectStatus(t, srv.do("POST", "/books", newBook, "Bearer dev-token"), 201)
}

// ---------- create ----------

func TestCreateBook(t *testing.T) {
	s := start(t)
	r := s.do("POST", "/books", newBook, bearer())
	expect(t, r, 201, bookWithID(16, newBook))
	if loc := r.header.Get("Location"); loc != "/books/16" {
		t.Fatalf("Location = %q, want /books/16", loc)
	}
	expect(t, s.get("/books/16"), 200, bookWithID(16, newBook))
	expectMeta(t, listPage(t, s, "/books"), 1, 10, 13, 2)
}

func TestCreateIgnoresUnknownFieldsAndID(t *testing.T) {
	s := start(t)
	body := `{"id":1,"extra":true,` + strings.TrimPrefix(newBook, "{")
	expect(t, s.do("POST", "/books", body, bearer()), 201, bookWithID(16, newBook))
	expect(t, s.get("/books/1"), 200, book1)
}

func TestCreateIDsNeverReused(t *testing.T) {
	s := start(t)
	b2 := strings.Replace(newBook, "9782000000001", "9782000000002", 1)
	b3 := strings.Replace(newBook, "9782000000001", "9782000000003", 1)
	expectStatus(t, s.do("POST", "/books", newBook, bearer()), 201)
	expect(t, s.do("POST", "/books", b2, bearer()), 201, bookWithID(17, b2))
	expectStatus(t, s.do("DELETE", "/books/17", "", bearer()), 204)
	expect(t, s.do("POST", "/books", b3, bearer()), 201, bookWithID(18, b3))
}

func TestCreateKeepsStringsVerbatim(t *testing.T) {
	s := start(t)
	body := `{"isbn":"9782000000009","title":"  Spaced Out ","author":"Zoë Ångström","genre":"poetry","year":1450,"price_cents":1}`
	expect(t, s.do("POST", "/books", body, bearer()), 201, bookWithID(16, body))
	long := strings.Repeat("é", 200)
	body = `{"isbn":"9782000000010","title":"` + long + `","author":"A","genre":"fantasy","year":2100,"price_cents":5}`
	expect(t, s.do("POST", "/books", body, bearer()), 201, bookWithID(17, body))
}

func TestCreateWithEmptySeed(t *testing.T) {
	s := startWithSeed(t, `{"books": []}`)
	p := expectIDs(t, s, "/books")
	expectMeta(t, p, 1, 10, 0, 0)
	expect(t, s.do("POST", "/books", newBook, bearer()), 201, bookWithID(1, newBook))
}

// ---------- body validation ----------

func TestValidationInvalidJSON(t *testing.T) {
	s := start(t)
	for _, body := range []string{"", "{", "[1,2]", `"book"`, "42", `{"year":"2001"}`, `{"price_cents":12.5}`, `{"title":7}`} {
		expect(t, s.do("POST", "/books", body, bearer()), 400, badJSONBody)
	}
	expect(t, s.do("PUT", "/books/1", `{"isbn":`, bearer()), 400, badJSONBody)
}

func TestValidationEmptyObject(t *testing.T) {
	s := start(t)
	expect(t, s.do("POST", "/books", `{}`, bearer()), 422, validationBody(`{"isbn":"is required","title":"is required",
		"author":"is required","genre":"`+genresMsg+`","year":"must be between 1450 and 2100","price_cents":"must be greater than 0"}`))
	expectMeta(t, listPage(t, s, "/books"), 1, 10, 12, 2)
}

func TestValidationSingleFieldRules(t *testing.T) {
	s := start(t)
	cases := []struct{ from, to, field, msg string }{
		{`"9782000000001"`, `"97820000000AB"`, "isbn", "must be 13 digits"},
		{`"9782000000001"`, `"978200000000"`, "isbn", "must be 13 digits"},
		{`"9782000000001"`, `"97820000000012"`, "isbn", "must be 13 digits"},
		{`"New Moon Notes"`, `"   "`, "title", "is required"},
		{`"New Moon Notes"`, `"` + strings.Repeat("x", 201) + `"`, "title", "must be at most 200 characters"},
		{`"Kai Lund"`, `" "`, "author", "is required"},
		{`"science"`, `"Science"`, "genre", genresMsg},
		{`2021`, `1449`, "year", "must be between 1450 and 2100"},
		{`2021`, `2101`, "year", "must be between 1450 and 2100"},
		{`4200`, `0`, "price_cents", "must be greater than 0"},
		{`4200`, `-5`, "price_cents", "must be greater than 0"},
	}
	for _, c := range cases {
		body := strings.Replace(newBook, c.from, c.to, 1)
		r := s.do("POST", "/books", body, bearer())
		t.Run(c.field+"="+c.to[:min(len(c.to), 16)], func(t *testing.T) {
			expect(t, r, 422, validationBody(`{"`+c.field+`":"`+c.msg+`"}`))
		})
	}
}

func TestValidationMultipleFields(t *testing.T) {
	s := start(t)
	body := `{"isbn":"123","title":"Ok","author":"","genre":"fiction","year":2000,"price_cents":0}`
	expect(t, s.do("POST", "/books", body, bearer()), 422,
		validationBody(`{"isbn":"must be 13 digits","author":"is required","price_cents":"must be greater than 0"}`))
}

func TestValidationOnUpdate(t *testing.T) {
	s := start(t)
	body := strings.Replace(newBook, `"year":2021`, `"year":99`, 1)
	expect(t, s.do("PUT", "/books/3", body, bearer()), 422, validationBody(`{"year":"must be between 1450 and 2100"}`))
	expect(t, s.get("/books/3"), 200, book3)
}

// ---------- conflicts ----------

func TestConflictCreateDuplicateISBN(t *testing.T) {
	s := start(t)
	body := strings.Replace(newBook, "9782000000001", "9781000000009", 1)
	expect(t, s.do("POST", "/books", body, bearer()), 409, conflictBody)
	expectMeta(t, listPage(t, s, "/books"), 1, 10, 12, 2)
	expectStatus(t, s.do("POST", "/books", newBook, bearer()), 201)
	expect(t, s.do("POST", "/books", newBook, bearer()), 409, conflictBody)
}

func TestConflictUpdateToOtherISBN(t *testing.T) {
	s := start(t)
	body := strings.Replace(newBook, "9782000000001", "9781000000001", 1)
	expect(t, s.do("PUT", "/books/3", body, bearer()), 409, conflictBody)
	expect(t, s.get("/books/3"), 200, book3)
}

func TestConflictUpdateKeepingOwnISBN(t *testing.T) {
	s := start(t)
	body := strings.Replace(newBook, "9782000000001", "9781000000003", 1)
	expect(t, s.do("PUT", "/books/3", body, bearer()), 200, bookWithID(3, body))
}

func TestConflictAfterValidation(t *testing.T) {
	s := start(t)
	body := `{"isbn":"9781000000001","title":"Dup","author":"X","genre":"fiction","year":3000,"price_cents":10}`
	expect(t, s.do("POST", "/books", body, bearer()), 422, validationBody(`{"year":"must be between 1450 and 2100"}`))
}

func TestConflictFreedByDelete(t *testing.T) {
	s := start(t)
	expectStatus(t, s.do("DELETE", "/books/9", "", bearer()), 204)
	body := strings.Replace(newBook, "9782000000001", "9781000000009", 1)
	expect(t, s.do("POST", "/books", body, bearer()), 201, bookWithID(16, body))
}

// ---------- update ----------

func TestUpdateReplacesBook(t *testing.T) {
	s := start(t)
	expect(t, s.do("PUT", "/books/10", newBook, bearer()), 200, bookWithID(10, newBook))
	expect(t, s.get("/books/10"), 200, bookWithID(10, newBook))
	expectIDs(t, s, "/books?genre=history", 2, 15)
	expectMeta(t, listPage(t, s, "/books"), 1, 10, 12, 2)
}

func TestUpdateIgnoresBodyID(t *testing.T) {
	s := start(t)
	body := `{"id":99,` + strings.TrimPrefix(newBook, "{")
	expect(t, s.do("PUT", "/books/4", body, bearer()), 200, bookWithID(4, newBook))
	expect(t, s.get("/books/99"), 404, notFoundBody)
}

func TestUpdateUnknownBook(t *testing.T) {
	s := start(t)
	expect(t, s.do("PUT", "/books/99", newBook, bearer()), 404, notFoundBody)
	expect(t, s.do("PUT", "/books/99", `{`, bearer()), 404, notFoundBody)
	expect(t, s.do("PUT", "/books/abc", newBook, bearer()), 404, notFoundBody)
	expect(t, s.get("/books/99"), 404, notFoundBody)
}

// ---------- delete ----------

func TestDeleteBook(t *testing.T) {
	s := start(t)
	r := s.do("DELETE", "/books/3", "", bearer())
	expectStatus(t, r, 204)
	if len(r.raw) != 0 {
		t.Fatalf("204 body must be empty, got %q", r.raw)
	}
	expect(t, s.get("/books/3"), 404, notFoundBody)
	p := expectIDs(t, s, "/books?genre=science", 11)
	expectMeta(t, p, 1, 10, 1, 1)
	expect(t, s.do("DELETE", "/books/3", "", bearer()), 404, notFoundBody)
}

func TestDeleteUnknownBook(t *testing.T) {
	s := start(t)
	expect(t, s.do("DELETE", "/books/12", "", bearer()), 404, notFoundBody)
	expect(t, s.do("DELETE", "/books/x", "", bearer()), 404, notFoundBody)
	expectMeta(t, listPage(t, s, "/books"), 1, 10, 12, 2)
}

// ---------- configuration ----------

func TestConfigPortEnv(t *testing.T) {
	port := freePort(t)
	srv := launch(t, []string{"-seed", writeSeed(t, seedJSON)}, baseEnv("PORT="+strconv.Itoa(port), "API_TOKEN="+token))
	srv.waitHealthy(fmt.Sprintf("http://127.0.0.1:%d", port))
	expectMeta(t, listPage(t, srv, "/books"), 1, 10, 12, 2)
}

func TestConfigAddrFlagWinsOverPort(t *testing.T) {
	envPort, flagPort := freePort(t), freePort(t)
	srv := launch(t, []string{"-addr", fmt.Sprintf("127.0.0.1:%d", flagPort), "-seed", writeSeed(t, seedJSON)},
		baseEnv("PORT="+strconv.Itoa(envPort)))
	srv.waitHealthy(fmt.Sprintf("http://127.0.0.1:%d", flagPort))
	if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", envPort), time.Second); err == nil {
		c.Close()
		t.Fatalf("server also listening on PORT %d", envPort)
	}
}

func expectExitFailure(t *testing.T, args []string) {
	t.Helper()
	srv := launch(t, args, baseEnv("API_TOKEN="+token))
	select {
	case err := <-srv.done:
		srv.done <- err
		if err == nil {
			t.Fatalf("exit status 0, want non-zero (args %v)", args)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("server kept running with args %v", args)
	}
}

func TestConfigMissingSeedExits(t *testing.T) {
	port := freePort(t)
	expectExitFailure(t, []string{"-addr", fmt.Sprintf("127.0.0.1:%d", port), "-seed", filepath.Join(t.TempDir(), "nope.json")})
}

func TestConfigInvalidSeedExits(t *testing.T) {
	port := freePort(t)
	expectExitFailure(t, []string{"-addr", fmt.Sprintf("127.0.0.1:%d", port), "-seed", writeSeed(t, `{"books": [`)})
}

// ---------- graceful shutdown ----------

func expectCleanExit(t *testing.T, sig syscall.Signal) {
	t.Helper()
	s := start(t)
	if err := s.cmd.Process.Signal(sig); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-s.done:
		s.done <- err
		if err != nil {
			t.Fatalf("after %v: %v, want exit status 0\n%s", sig, err, s.out)
		}
	case <-time.After(8 * time.Second):
		t.Fatalf("server did not exit within 8s of %v", sig)
	}
}

func TestShutdownOnSIGTERM(t *testing.T) { expectCleanExit(t, syscall.SIGTERM) }

func TestShutdownOnSIGINT(t *testing.T) { expectCleanExit(t, syscall.SIGINT) }

func TestShutdownWaitsForInFlightRequest(t *testing.T) {
	s := start(t)
	addr := strings.TrimPrefix(s.base, "http://")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// Send a request whose body is still arriving when the signal is sent.
	body := newBook
	head := fmt.Sprintf("POST /books HTTP/1.1\r\nHost: %s\r\nAuthorization: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", addr, bearer(), len(body))
	if _, err := conn.Write([]byte(head + body[:10])); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := s.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if _, err := conn.Write([]byte(body[10:])); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	resp, err := io.ReadAll(conn)
	if !strings.HasPrefix(string(resp), "HTTP/1.1 201") {
		t.Fatalf("in-flight request not completed: %v %q", err, resp)
	}
	select {
	case err := <-s.done:
		s.done <- err
		if err != nil {
			t.Fatalf("exit: %v\n%s", err, s.out)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("server did not exit after in-flight request finished")
	}
}
