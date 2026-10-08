# ADR-0001: Modular monolith

Status: Accepted (2021-03)

## Context

The 2019 monolith mixed HTTP handling, pricing and persistence in the same
files. Splitting into services was considered too expensive for a team of
six.

## Decision

Keep one deployable codebase but split it into packages with explicit
public entry points (`src/index.ts`). Packages may only import each other's
public entry points, never internal files.

## Consequences

- Cross-package refactors stay cheap.
- We need discipline (and review) to keep package boundaries clean.
