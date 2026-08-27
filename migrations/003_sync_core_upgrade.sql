ALTER TABLE game_configs ADD COLUMN IF NOT EXISTS schema jsonb;

ALTER TABLE config_revisions ADD COLUMN IF NOT EXISTS release_version integer;
ALTER TABLE config_revisions ADD COLUMN IF NOT EXISTS schema jsonb;
UPDATE config_revisions SET release_version=version WHERE status IN ('published','superseded') AND release_version IS NULL;
UPDATE config_revisions r SET schema=c.schema FROM game_configs c WHERE c.id=r.config_id AND r.schema IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_release_version
  ON config_revisions(config_id,release_version) WHERE release_version IS NOT NULL;

ALTER TABLE idempotency_records ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours');
ALTER TABLE idempotency_records ALTER COLUMN response DROP NOT NULL;
ALTER TABLE idempotency_records ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'completed';
UPDATE idempotency_records SET status='completed' WHERE response IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_records(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS game_memberships (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  role varchar(20) NOT NULL CHECK(role IN ('viewer','editor','owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(game_id,admin_id)
);
CREATE INDEX IF NOT EXISTS idx_game_memberships_admin ON game_memberships(admin_id,game_id);

CREATE TABLE IF NOT EXISTS user_identities (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
  provider varchar(64) NOT NULL,
  subject varchar(191) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(game_id,provider,subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(game_id,user_id);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key varchar(255) PRIMARY KEY,
  count integer NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_expiry ON rate_limit_buckets(reset_at);
