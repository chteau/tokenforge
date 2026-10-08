package clock

import (
	"testing"
	"time"
)

func TestFake(t *testing.T) {
	start := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	f := NewFake(start)
	if !f.Now().Equal(start) {
		t.Fatalf("Now = %v", f.Now())
	}
	f.Advance(90 * time.Minute)
	if want := start.Add(90 * time.Minute); !f.Now().Equal(want) {
		t.Fatalf("after Advance Now = %v, want %v", f.Now(), want)
	}
	f.Set(start)
	if !f.Now().Equal(start) {
		t.Fatalf("after Set Now = %v", f.Now())
	}
}

func TestRealIsUTC(t *testing.T) {
	if loc := (Real{}).Now().Location(); loc != time.UTC {
		t.Fatalf("location = %v", loc)
	}
}
