ALTER TABLE config_revisions
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

ALTER TABLE config_revisions
  ADD COLUMN IF NOT EXISTS scheduled_by uuid REFERENCES admins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_config_revisions_scheduled
  ON config_revisions(scheduled_at) WHERE status='draft' AND scheduled_at IS NOT NULL;
