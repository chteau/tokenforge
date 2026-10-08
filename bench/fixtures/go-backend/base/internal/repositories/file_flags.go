package repositories

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/acme/meridian/internal/flags"
)

// FileFlags is a FlagRepository persisted as a JSON document on disk. The
// whole file is rewritten atomically (temp file + rename) on every change,
// which is fine for the handful of flags the service uses.
type FileFlags struct {
	mu    sync.RWMutex
	path  string
	flags map[string]flags.Flag
}

type flagFile struct {
	Flags []flags.Flag `json:"flags"`
}

// OpenFileFlags loads flags from path. A missing file is treated as empty and
// will be created on the first Put.
func OpenFileFlags(path string) (*FileFlags, error) {
	ff := &FileFlags{path: path, flags: map[string]flags.Flag{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return ff, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read flags file: %w", err)
	}
	var doc flagFile
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("parse flags file %s: %w", path, err)
	}
	for _, f := range doc.Flags {
		ff.flags[f.Key] = f
	}
	return ff, nil
}

func (f *FileFlags) Get(_ context.Context, key string) (flags.Flag, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	fl, ok := f.flags[key]
	if !ok {
		return flags.Flag{}, ErrNotFound
	}
	return fl, nil
}

func (f *FileFlags) Put(_ context.Context, fl flags.Flag) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	prev, existed := f.flags[fl.Key]
	f.flags[fl.Key] = fl
	if err := f.persistLocked(); err != nil {
		if existed {
			f.flags[fl.Key] = prev
		} else {
			delete(f.flags, fl.Key)
		}
		return err
	}
	return nil
}

func (f *FileFlags) List(_ context.Context) ([]flags.Flag, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.sortedLocked(), nil
}

func (f *FileFlags) sortedLocked() []flags.Flag {
	out := make([]flags.Flag, 0, len(f.flags))
	for _, fl := range f.flags {
		out = append(out, fl)
	}
	slices.SortFunc(out, func(a, b flags.Flag) int { return strings.Compare(a.Key, b.Key) })
	return out
}

func (f *FileFlags) persistLocked() error {
	data, err := json.MarshalIndent(flagFile{Flags: f.sortedLocked()}, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create flags dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".flags-*.json")
	if err != nil {
		return fmt.Errorf("create temp flags file: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return fmt.Errorf("write flags: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close flags: %w", err)
	}
	return os.Rename(tmp.Name(), f.path)
}

// MemoryFlags is an in-memory FlagRepository used when no flags file is configured.
type MemoryFlags struct {
	mu    sync.RWMutex
	flags map[string]flags.Flag
}

// NewMemoryFlags returns an empty repository.
func NewMemoryFlags() *MemoryFlags { return &MemoryFlags{flags: map[string]flags.Flag{}} }

func (m *MemoryFlags) Get(_ context.Context, key string) (flags.Flag, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	fl, ok := m.flags[key]
	if !ok {
		return flags.Flag{}, ErrNotFound
	}
	return fl, nil
}

func (m *MemoryFlags) Put(_ context.Context, fl flags.Flag) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.flags[fl.Key] = fl
	return nil
}

func (m *MemoryFlags) List(_ context.Context) ([]flags.Flag, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]flags.Flag, 0, len(m.flags))
	for _, fl := range m.flags {
		out = append(out, fl)
	}
	slices.SortFunc(out, func(a, b flags.Flag) int { return strings.Compare(a.Key, b.Key) })
	return out, nil
}
