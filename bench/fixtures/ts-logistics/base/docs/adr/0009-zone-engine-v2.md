# ADR-0009: Distance-based zone engine

Status: Accepted (2024-10), rollout in progress

## Context

Remote-area charging uses static postcode tables that drift from the real
network whenever partner carriers change coverage.

## Decision

Compute a remote band from hub distance and ferry legs
(`packages/rates/src/zones/zoneEngineV2.ts`) and charge 3.5% (near) or 5%
(far). The engine replaces the zone adjuster when the `zoneEngineV2` flag
is on.

## Rollout

1. Shadow mode in staging, compare against the district tables.
2. Enable in production for GB.
3. Delete the generated district tables.
