// Package pagination implements offset pagination for list endpoints.
package pagination

import (
	"fmt"
	"net/url"
	"strconv"
)

const (
	DefaultLimit = 20
	MaxLimit     = 100
)

// Params are the parsed pagination query parameters.
type Params struct {
	Limit  int
	Offset int
}

// Page is a window of results.
type Page[T any] struct {
	Items      []T  `json:"items"`
	Total      int  `json:"total"`
	Limit      int  `json:"limit"`
	Offset     int  `json:"offset"`
	NextOffset *int `json:"next_offset,omitempty"`
}

// FromQuery parses ?limit= and ?offset=.
func FromQuery(q url.Values) (Params, error) {
	p := Params{Limit: DefaultLimit}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return Params{}, fmt.Errorf("limit must be a positive integer")
		}
		if n > MaxLimit {
			n = MaxLimit
		}
		p.Limit = n
	}
	if v := q.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return Params{}, fmt.Errorf("offset must be a non-negative integer")
		}
		p.Offset = n
	}
	return p, nil
}

// Slice returns the page of items selected by p.
func Slice[T any](items []T, p Params) Page[T] {
	if p.Limit <= 0 {
		p.Limit = DefaultLimit
	}
	total := len(items)
	start := min(p.Offset, total)
	end := min(start+p.Limit, total)
	page := Page[T]{Items: make([]T, 0, end-start), Total: total, Limit: p.Limit, Offset: p.Offset}
	page.Items = append(page.Items, items[start:end]...)
	if end < total {
		next := end
		page.NextOffset = &next
	}
	return page
}
