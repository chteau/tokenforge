package flags

import (
	"fmt"
	"testing"
)

func TestEnabledFor(t *testing.T) {
	tests := []struct {
		name string
		flag Flag
		user string
		want bool
	}{
		{"disabled", Flag{Key: "k", Enabled: false, RolloutPercent: 100}, "u", false},
		{"full rollout", Flag{Key: "k", Enabled: true, RolloutPercent: 100}, "u", true},
		{"zero rollout", Flag{Key: "k", Enabled: true}, "u", false},
		{"allow list wins", Flag{Key: "k", Enabled: true, AllowUsers: []string{"u"}}, "u", true},
		{"allow list needs enabled", Flag{Key: "k", AllowUsers: []string{"u"}}, "u", false},
	}
	for _, tt := range tests {
		if got := tt.flag.EnabledFor(tt.user); got != tt.want {
			t.Errorf("%s: got %v", tt.name, got)
		}
	}
}

func TestRolloutIsRoughlyProportional(t *testing.T) {
	f := Flag{Key: "new_dashboard", Enabled: true, RolloutPercent: 30}
	on := 0
	for i := range 2000 {
		if f.EnabledFor(fmt.Sprintf("usr_%d", i)) {
			on++
		}
	}
	if on < 450 || on > 750 {
		t.Fatalf("enabled for %d of 2000 users", on)
	}
	if f.EnabledFor("usr_42") != f.EnabledFor("usr_42") {
		t.Fatal("bucketing must be deterministic")
	}
}
