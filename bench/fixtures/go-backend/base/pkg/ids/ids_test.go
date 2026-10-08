package ids

import (
	"strings"
	"testing"
)

func TestNew(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		id := New("usr")
		if !strings.HasPrefix(id, "usr_") || len(id) != len("usr_")+16 {
			t.Fatalf("bad id %q", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = true
	}
}
