-- Accounts and authentication.
-- The service currently runs on in-memory repositories; these files document
-- the intended PostgreSQL schema and are applied by the ops tooling.

CREATE TABLE users (
    id            TEXT PRIMARY KEY,                 -- usr_<16 hex>
    email         TEXT NOT NULL,
    name          TEXT NOT NULL,
    phone         TEXT,                             -- E.164
    role          TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'billing_admin', 'admin')),
    disabled      BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash TEXT NOT NULL,                    -- pbkdf2-sha256$iter$salt$key
    created_at    TIMESTAMPTZ NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX users_email_key ON users (lower(email));
