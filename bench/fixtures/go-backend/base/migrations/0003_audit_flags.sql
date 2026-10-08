-- Audit trail and feature flags.

CREATE TABLE audit_events (
    id          TEXT PRIMARY KEY,
    actor_id    TEXT NOT NULL,
    action      TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    metadata    JSONB NOT NULL DEFAULT '{}',
    occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX audit_events_target_idx ON audit_events (target_id, occurred_at);
CREATE INDEX audit_events_action_idx ON audit_events (action, occurred_at);

-- Feature flags are stored in a JSON file in single-node deployments
-- (FLAGS_FILE); this table is used once flags move to the database.
CREATE TABLE feature_flags (
    key             TEXT PRIMARY KEY,
    description     TEXT NOT NULL DEFAULT '',
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
    allow_users     TEXT[] NOT NULL DEFAULT '{}',
    updated_at      TIMESTAMPTZ NOT NULL
);
