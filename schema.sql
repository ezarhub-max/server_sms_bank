-- schema.sql
-- BlackTecch SMS Hub - PostgreSQL schema
-- Run once: psql "$DATABASE_URL" -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gives us gen_random_uuid()

-- ---------------------------------------------------------------------
-- groups: one per team/branch. Recipient numbers and the monthly
-- subscription are both tracked per group.
-- ---------------------------------------------------------------------
CREATE TABLE groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_name  VARCHAR(120) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- accounts: admin-provisioned logins. "status" is the admin's manual
-- override; subscription_expires_at drives automatic freezing when it
-- lapses (see cron/freezeExpired.js). Effective access = status='active'
-- AND subscription_expires_at > now() - enforced in middleware/auth.js,
-- not just here, so a lapsed subscription takes effect immediately even
-- before the nightly cron runs.
-- ---------------------------------------------------------------------
CREATE TABLE accounts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id                UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    username                VARCHAR(80) NOT NULL UNIQUE,
    password_hash           VARCHAR(200) NOT NULL,
    role                    VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    status                  VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'revoked')),
    subscription_expires_at TIMESTAMPTZ NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_accounts_group_id ON accounts(group_id);
CREATE INDEX idx_accounts_status_expiry ON accounts(status, subscription_expires_at); -- used by the freeze cron

-- ---------------------------------------------------------------------
-- group_recipients: the notification numbers for a group. The app's
-- PUT /api/group/:groupId/numbers replaces the whole set in one
-- transaction (delete-then-insert), matching the Flutter client's
-- "push the full list" behavior.
-- ---------------------------------------------------------------------
CREATE TABLE group_recipients (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    phone_number VARCHAR(20) NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (group_id, phone_number)
);

CREATE INDEX idx_group_recipients_group_id ON group_recipients(group_id);

-- ---------------------------------------------------------------------
-- payments: a manual log of "admin added N months" events, for your own
-- record-keeping (who paid, when, how much, how long it covers). This
-- is NOT a payment-gateway integration - you record the payment after
-- collecting it by whatever means, and the API just extends access.
-- ---------------------------------------------------------------------
CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    recorded_by     VARCHAR(80) NOT NULL,          -- admin identifier, e.g. "hq-admin" or "cli"
    months_added    INTEGER NOT NULL CHECK (months_added > 0),
    amount          DECIMAL(10, 2),                -- optional, for your own records
    note            VARCHAR(255),
    new_expires_at  TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_group_id ON payments(group_id, created_at DESC);

-- ---------------------------------------------------------------------
-- audit_logs: optional server-side mirror of each device's local audit
-- log (SQLite today). Not yet called by the Flutter/Kotlin client - see
-- README - but the endpoint is ready for when you want centralized
-- audit history instead of (or in addition to) per-device logs.
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    sender_bank     VARCHAR(50),
    message_body    TEXT,
    delivery_method VARCHAR(20) CHECK (delivery_method IN ('ONLINE_SOCKET', 'OFFLINE_SMS')),
    status          VARCHAR(20) CHECK (status IN ('SUCCESS', 'FAILED')),
    occurred_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_group_time ON audit_logs(group_id, occurred_at DESC);
