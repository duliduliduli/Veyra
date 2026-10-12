SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Empty on upgrade: publishing requires a separate, explicit owner action.
CREATE TABLE strategy_publications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id),
    project_version_id  uuid NOT NULL,
    content_hash        text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
    entrypoint          text NOT NULL,
    title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    description         text NOT NULL CHECK (length(description) <= 4000),
    idempotency_key     text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
    published_by        uuid NOT NULL REFERENCES users(id),
    published_at        timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz CHECK (revoked_at >= published_at),
    FOREIGN KEY (project_version_id, org_id) REFERENCES project_versions(id, org_id),
    UNIQUE (org_id, idempotency_key)
);
CREATE INDEX strategy_publications_discovery_idx
    ON strategy_publications(published_at DESC, id DESC) WHERE revoked_at IS NULL;
CREATE INDEX strategy_publications_version_idx ON strategy_publications(project_version_id);

CREATE FUNCTION protect_strategy_publication() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'publication identity is permanent; revoke it instead';
    END IF;
    IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
        OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'publication is immutable except for one irreversible revocation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER strategy_publications_immutable BEFORE UPDATE OR DELETE ON strategy_publications
    FOR EACH ROW EXECUTE FUNCTION protect_strategy_publication();
