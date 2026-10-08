// Package ids generates opaque, prefixed identifiers such as "inv_3f9a0c1b2d4e5f60".
package ids

import (
	"crypto/rand"
	"encoding/hex"
)

// New returns a random identifier with the given prefix.
func New(prefix string) string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("ids: crypto/rand failed: " + err.Error())
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}
