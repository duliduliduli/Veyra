-- Veyra control-plane schema v1 (spec §16). All timestamps UTC. Money = BIGINT nano-USD.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_subject  text NOT NULL UNIQUE,
    email         text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    org_id      uuid NOT NULL REFERENCES organizations(id),
    user_id     uuid NOT NULL REFERENCES users(id),
    role        text NOT NULL CHECK (role IN ('owner','researcher','billing_admin','viewer')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE projects (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES organizations(id),
    name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    created_by  uuid NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name),
    UNIQUE (id, org_id)
);

-- Immutable code snapshots. Files live in object storage; the hash pins them.
CREATE TABLE project_versions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL,
    project_id    uuid NOT NULL,
    version_no    integer NOT NULL CHECK (version_no > 0),
    content_hash  text NOT NULL,
    entrypoint    text NOT NULL,
    object_key    text NOT NULL,
    created_by    uuid NOT NULL REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, org_id) REFERENCES projects(id, org_id),
    UNIQUE (project_id, version_no),
    UNIQUE (id, org_id)
);

-- ---------------------------------------------------------------- ledger (§15.4)
CREATE TABLE ledger_accounts (
    id            bigserial PRIMARY KEY,
    code          text NOT NULL UNIQUE,
    org_id        uuid REFERENCES organizations(id),
    kind          text NOT NULL CHECK (kind IN ('asset','liability','revenue','expense')),
    nonnegative   boolean NOT NULL DEFAULT false,
    -- Cached normal-side balance, updated in the same transaction as journal_lines and
    -- verified by reconciliation. The CHECK is what makes concurrent overspend impossible.
    balance_nano  bigint NOT NULL DEFAULT 0,
    CONSTRAINT balance_nonnegative CHECK (NOT nonnegative OR balance_nano >= 0)
);

CREATE TABLE journal_entries (
    id               bigserial PRIMARY KEY,
    org_id           uuid REFERENCES organizations(id),
    kind             text NOT NULL,
    idempotency_key  text NOT NULL UNIQUE,
    reference        jsonb NOT NULL DEFAULT '{}',
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- Signed amounts: debit positive, credit negative. Each entry sums to zero.
CREATE TABLE journal_lines (
    id          bigserial PRIMARY KEY,
    entry_id    bigint NOT NULL REFERENCES journal_entries(id),
    account_id  bigint NOT NULL REFERENCES ledger_accounts(id),
    amount_nano bigint NOT NULL CHECK (amount_nano <> 0)
);
CREATE INDEX journal_lines_account_idx ON journal_lines(account_id);
CREATE INDEX journal_lines_entry_idx ON journal_lines(entry_id);

CREATE FUNCTION journal_entry_balances() RETURNS trigger AS $$
DECLARE s numeric;
BEGIN
    SELECT COALESCE(sum(amount_nano), 0) INTO s FROM journal_lines WHERE entry_id = NEW.entry_id;
    IF s <> 0 THEN
        RAISE EXCEPTION 'journal entry % does not balance (sum %)', NEW.entry_id, s;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
    AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION journal_entry_balances();

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- payments
CREATE TABLE payments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations(id),
    provider      text NOT NULL,
    provider_ref  text NOT NULL,
    amount_nano   bigint NOT NULL CHECK (amount_nano > 0),
    status        text NOT NULL CHECK (status IN ('pending','succeeded','failed')),
    created_by    uuid NOT NULL REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    confirmed_at  timestamptz,
    UNIQUE (provider, provider_ref)
);

CREATE TABLE inbox_dedup (
    provider     text NOT NULL,
    event_id     text NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, event_id)
);

-- ---------------------------------------------------------------- quotes & jobs (§10, §15.3)
CREATE TABLE quotes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id),
    project_version_id  uuid NOT NULL,
    request             jsonb NOT NULL,
    input_hash          text NOT NULL,
    rate_version        text NOT NULL,
    estimate            jsonb NOT NULL,
    customer_max_nano   bigint NOT NULL CHECK (customer_max_nano > 0),
    expires_at          timestamptz NOT NULL,
    created_by          uuid NOT NULL REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_version_id, org_id) REFERENCES project_versions(id, org_id)
);

CREATE TABLE authorizations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES organizations(id),
    quote_id       uuid NOT NULL UNIQUE REFERENCES quotes(id),
    input_hash     text NOT NULL,
    reserved_nano  bigint NOT NULL CHECK (reserved_nano > 0),
    status         text NOT NULL CHECK (status IN ('reserved','settled')),
    approved_by    uuid NOT NULL REFERENCES users(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    settled_at     timestamptz
);

CREATE TABLE jobs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id),
    project_version_id  uuid NOT NULL,
    authorization_id    uuid NOT NULL UNIQUE REFERENCES authorizations(id),
    idempotency_key     text NOT NULL,
    config              jsonb NOT NULL,
    state               text NOT NULL CHECK (state IN (
                            'queued','running','finalizing','stopping','settled')),
    outcome             text CHECK (outcome IN ('completed','incomplete','cancelled','failed')),
    version             integer NOT NULL DEFAULT 1,
    fence_token         bigint NOT NULL DEFAULT 0,
    cancel_requested    boolean NOT NULL DEFAULT false,
    progress            jsonb NOT NULL DEFAULT '{}',
    error               text,
    receipt             jsonb,
    created_by          uuid NOT NULL REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    settled_at          timestamptz,
    UNIQUE (org_id, idempotency_key),
    FOREIGN KEY (project_version_id, org_id) REFERENCES project_versions(id, org_id),
    CHECK ((state = 'settled') = (settled_at IS NOT NULL)),
    CHECK (state <> 'settled' OR outcome IS NOT NULL)
);
CREATE INDEX jobs_queued_idx ON jobs(created_at) WHERE state = 'queued';

CREATE TABLE job_attempts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id            uuid NOT NULL REFERENCES jobs(id),
    attempt_no        integer NOT NULL,
    fence_token       bigint NOT NULL,
    worker_id         text NOT NULL,
    started_at        timestamptz NOT NULL DEFAULT now(),
    heartbeat_at      timestamptz NOT NULL DEFAULT now(),
    lease_expires_at  timestamptz NOT NULL,
    ended_at          timestamptz,
    end_reason        text,
    billed_seconds    integer,
    UNIQUE (job_id, attempt_no)
);

CREATE TABLE usage_events (
    id                  bigserial PRIMARY KEY,
    org_id              uuid NOT NULL REFERENCES organizations(id),
    job_id              uuid NOT NULL REFERENCES jobs(id),
    supplier_event_key  text NOT NULL UNIQUE,   -- charged at most once (§15.4)
    supplier            text NOT NULL,
    meter               text NOT NULL,
    units               numeric NOT NULL,
    unit                text NOT NULL,
    supplier_cost_nano  bigint NOT NULL CHECK (supplier_cost_nano >= 0),
    rate_version        text NOT NULL,
    detail              jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES organizations(id),
    job_id         uuid NOT NULL UNIQUE REFERENCES jobs(id),
    outcome        text NOT NULL,
    result_digest  text NOT NULL,
    metrics        jsonb NOT NULL,
    artifacts      jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- operations (§17)
CREATE TABLE outbox (
    id                bigserial PRIMARY KEY,
    event_id          uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    schema_version    integer NOT NULL DEFAULT 1,
    event_type        text NOT NULL,
    org_id            uuid,
    resource_id       uuid,
    resource_version  integer,
    correlation_id    text,
    payload           jsonb NOT NULL DEFAULT '{}',
    occurred_at       timestamptz NOT NULL DEFAULT now(),
    delivered_at      timestamptz
);
CREATE INDEX outbox_undelivered_idx ON outbox(id) WHERE delivered_at IS NULL;

CREATE TABLE audit_events (
    id          bigserial PRIMARY KEY,
    org_id      uuid,
    actor_id    uuid,
    action      text NOT NULL,
    resource    text,
    detail      jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
