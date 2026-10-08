-- Plans, subscriptions, invoices and payments.
-- All money columns are BIGINT minor units (cents) in the row's currency.

CREATE TABLE plans (
    id          TEXT PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
    currency    CHAR(3) NOT NULL,
    interval    TEXT NOT NULL CHECK (interval IN ('month', 'year')),
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE subscriptions (
    id                 TEXT PRIMARY KEY,
    customer_id        TEXT NOT NULL REFERENCES users (id),
    plan_id            TEXT NOT NULL REFERENCES plans (id),
    status             TEXT NOT NULL CHECK (status IN ('active', 'canceled')),
    started_at         TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,
    canceled_at        TIMESTAMPTZ
);

CREATE INDEX subscriptions_customer_idx ON subscriptions (customer_id);

CREATE TABLE invoices (
    id             TEXT PRIMARY KEY,
    number         TEXT NOT NULL UNIQUE,            -- INV-000001
    customer_id    TEXT NOT NULL REFERENCES users (id),
    status         TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void')),
    currency       CHAR(3) NOT NULL,
    tax_rate_bps   BIGINT NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
    subtotal_cents BIGINT NOT NULL,
    tax_cents      BIGINT NOT NULL,
    total_cents    BIGINT NOT NULL,
    paid_cents     BIGINT NOT NULL DEFAULT 0 CHECK (paid_cents >= 0 AND paid_cents <= total_cents),
    due_in_days    INTEGER NOT NULL DEFAULT 30,
    issued_at      TIMESTAMPTZ,
    due_at         TIMESTAMPTZ,
    paid_at        TIMESTAMPTZ,
    voided_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX invoices_customer_created_idx ON invoices (customer_id, created_at DESC);
CREATE INDEX invoices_status_idx ON invoices (status) WHERE status IN ('draft', 'open');

CREATE TABLE invoice_lines (
    invoice_id   TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    description  TEXT NOT NULL,
    quantity     BIGINT NOT NULL CHECK (quantity > 0),
    unit_cents   BIGINT NOT NULL CHECK (unit_cents >= 0),
    amount_cents BIGINT NOT NULL,
    PRIMARY KEY (invoice_id, position)
);

CREATE TABLE payments (
    id           TEXT PRIMARY KEY,
    invoice_id   TEXT NOT NULL REFERENCES invoices (id),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    method       TEXT NOT NULL CHECK (method IN ('card', 'bank_transfer', 'cash')),
    reference    TEXT,
    recorded_by  TEXT NOT NULL REFERENCES users (id),
    received_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX payments_invoice_idx ON payments (invoice_id);
