// Package flags implements feature flags with percentage rollouts and
// per-user allow lists.
package flags

import (
	"hash/fnv"
	"slices"
	"time"
)

// Flag is a feature toggle.
type Flag struct {
	Key            string    `json:"key"`
	Description    string    `json:"description,omitempty"`
	Enabled        bool      `json:"enabled"`
	RolloutPercent int       `json:"rollout_percent"`
	AllowUsers     []string  `json:"allow_users,omitempty"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// EnabledFor reports whether the flag is on for userID. A disabled flag is
// off for everyone; allow-listed users always get an enabled flag; everyone
// else is bucketed deterministically by hashing the flag key and user ID.
func (f Flag) EnabledFor(userID string) bool {
	if !f.Enabled {
		return false
	}
	if slices.Contains(f.AllowUsers, userID) {
		return true
	}
	if f.RolloutPercent >= 100 {
		return true
	}
	if f.RolloutPercent <= 0 {
		return false
	}
	return Bucket(f.Key, userID) < f.RolloutPercent
}

// Bucket maps (key, userID) to [0, 100).
func Bucket(key, userID string) int {
	h := fnv.New32a()
	h.Write([]byte(key))
	h.Write([]byte{0})
	h.Write([]byte(userID))
	return int(h.Sum32() % 100)
}
