CREATE TABLE IF NOT EXISTS admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(64) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role varchar(20) NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_key varchar(64) NOT NULL UNIQUE,
  name varchar(128) NOT NULL,
  description text NOT NULL DEFAULT '',
  api_key_hash char(64) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  config_key varchar(128) NOT NULL,
  environment varchar(32) NOT NULL DEFAULT 'production',
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(game_id, environment, config_key)
);

CREATE TABLE IF NOT EXISTS game_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  openid varchar(191),
  external_user_id varchar(191),
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (openid IS NOT NULL OR external_user_id IS NOT NULL),
  UNIQUE(game_id, openid),
  UNIQUE(game_id, external_user_id)
);

CREATE TABLE IF NOT EXISTS user_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
  slot varchar(64) NOT NULL DEFAULT 'default',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(game_id, user_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_configs_game ON game_configs(game_id, environment);
CREATE INDEX IF NOT EXISTS idx_users_openid ON game_users(game_id, openid) WHERE openid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_external ON game_users(game_id, external_user_id) WHERE external_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_archives_user ON user_archives(game_id, user_id);
