package pagination

import (
	"net/url"
	"testing"
)

func TestFromQuery(t *testing.T) {
	tests := []struct {
		query   string
		want    Params
		wantErr bool
	}{
		{query: "", want: Params{Limit: DefaultLimit}},
		{query: "limit=5&offset=10", want: Params{Limit: 5, Offset: 10}},
		{query: "limit=1000", want: Params{Limit: MaxLimit}},
		{query: "limit=0", wantErr: true},
		{query: "limit=abc", wantErr: true},
		{query: "offset=-1", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			q, _ := url.ParseQuery(tt.query)
			got, err := FromQuery(q)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestSlice(t *testing.T) {
	items := []int{1, 2, 3, 4, 5}
	tests := []struct {
		name      string
		p         Params
		wantItems int
		wantNext  int
	}{
		{name: "first page", p: Params{Limit: 2}, wantItems: 2, wantNext: 2},
		{name: "last partial page", p: Params{Limit: 2, Offset: 4}, wantItems: 1, wantNext: -1},
		{name: "exact end", p: Params{Limit: 5}, wantItems: 5, wantNext: -1},
		{name: "past the end", p: Params{Limit: 2, Offset: 9}, wantItems: 0, wantNext: -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page := Slice(items, tt.p)
			if len(page.Items) != tt.wantItems {
				t.Fatalf("items = %v", page.Items)
			}
			if page.Total != 5 {
				t.Fatalf("total = %d", page.Total)
			}
			switch {
			case tt.wantNext < 0 && page.NextOffset != nil:
				t.Fatalf("unexpected next offset %d", *page.NextOffset)
			case tt.wantNext >= 0 && (page.NextOffset == nil || *page.NextOffset != tt.wantNext):
				t.Fatalf("next offset = %v, want %d", page.NextOffset, tt.wantNext)
			}
		})
	}
}
