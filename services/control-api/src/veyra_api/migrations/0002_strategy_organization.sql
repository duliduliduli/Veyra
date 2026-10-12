-- Fail and roll back rather than hold up an active database indefinitely.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Add private strategy organization without changing existing names or code snapshots.
ALTER TABLE projects
    ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
    ADD COLUMN folder text CHECK (length(folder) BETWEEN 1 AND 80),
    ADD COLUMN visibility text NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
    ADD COLUMN updated_at timestamptz;

UPDATE projects p SET updated_at = GREATEST(p.created_at, COALESCE(
    (SELECT max(v.created_at) FROM project_versions v WHERE v.project_id = p.id), p.created_at));

ALTER TABLE projects ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE projects ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX projects_updated_idx ON projects(org_id, updated_at DESC, id DESC);
CREATE INDEX jobs_org_created_idx ON jobs(org_id, created_at DESC, id DESC);
CREATE INDEX jobs_org_project_version_idx ON jobs(org_id, project_version_id);
