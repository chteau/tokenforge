# ADR-0007: Feature flags in config

Status: Accepted (2024-01)

Flags live under `features` in config and are read through
`isEnabled(config, flag)`. They are global per environment; tenants cannot
toggle them. A flag that is missing from config is off.

Flags must be removed within two releases of reaching 100%.
