-- Migration 0018: User organization membership

ALTER TABLE users ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);
