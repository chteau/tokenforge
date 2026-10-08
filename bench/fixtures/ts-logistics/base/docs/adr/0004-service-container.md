# ADR-0004: Service container instead of direct construction

Status: Accepted (2022-09)

## Context

Handlers constructed their dependencies directly (`new RateCalculator()`),
which made tests slow and environment switches painful.

## Decision

A minimal string-keyed container (`packages/core/src/di/container.ts`).
Each package registers its services under a namespaced key from a
`register<Package>(container, config)` function. Gateway and worker build
the container once at boot.

Keys are strings on purpose: configuration can refer to services by key
(for example pricing profiles listing adjusters), which lets us change
behaviour per environment or tenant without code changes.

## Consequences

- "Go to definition" does not work across a container lookup; search for the
  key instead.
- Registration order matters only for overrides.
