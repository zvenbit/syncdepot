ALTER TABLE games ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS game_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name varchar(128) NOT NULL,
  key_hash char(64) NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['config:read'],
  enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  last_used_at timestamptz,
  last_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO game_api_keys(game_id,name,key_hash,scopes)
SELECT id,'初始密钥',api_key_hash,ARRAY['config:read','user:resolve','archive:read','archive:write']
FROM games
ON CONFLICT(key_hash) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_api_keys_game ON game_api_keys(game_id,enabled);

CREATE TABLE IF NOT EXISTS config_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES game_configs(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  version integer NOT NULL,
  value jsonb NOT NULL,
  status varchar(20) NOT NULL CHECK(status IN ('draft','published','superseded')),
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE(config_id,version)
);

INSERT INTO config_revisions(config_id,game_id,version,value,status,note,published_at)
SELECT id,game_id,version,value,'published','初始版本',updated_at FROM game_configs
ON CONFLICT(config_id,version) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_config_revisions_config ON config_revisions(config_id,version DESC);

CREATE TABLE IF NOT EXISTS archive_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archive_id uuid NOT NULL REFERENCES user_archives(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
  slot varchar(64) NOT NULL,
  version integer NOT NULL,
  data jsonb NOT NULL,
  reason varchar(32) NOT NULL DEFAULT 'save',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(archive_id,version)
);

INSERT INTO archive_revisions(archive_id,game_id,user_id,slot,version,data,reason,created_at)
SELECT id,game_id,user_id,slot,version,data,'initial',updated_at FROM user_archives
ON CONFLICT(archive_id,version) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_archive_revisions_archive ON archive_revisions(archive_id,version DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(game_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  game_id uuid REFERENCES games(id) ON DELETE SET NULL,
  admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
  actor_type varchar(20) NOT NULL,
  actor_id varchar(191),
  action varchar(100) NOT NULL,
  resource_type varchar(64) NOT NULL,
  resource_id varchar(191),
  before_data jsonb,
  after_data jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_game_time ON audit_logs(game_id,created_at DESC);

CREATE TABLE IF NOT EXISTS api_metrics_daily (
  metric_date date NOT NULL DEFAULT CURRENT_DATE,
  game_id uuid REFERENCES games(id) ON DELETE CASCADE,
  route varchar(191) NOT NULL,
  requests bigint NOT NULL DEFAULT 0,
  errors bigint NOT NULL DEFAULT 0,
  total_duration_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(metric_date,game_id,route)
);

CREATE INDEX IF NOT EXISTS idx_metrics_game_date ON api_metrics_daily(game_id,metric_date DESC);
