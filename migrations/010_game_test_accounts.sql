CREATE TABLE IF NOT EXISTS game_test_accounts (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
  username varchar(64) NOT NULL,
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  token_version integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES admins(id) ON DELETE SET NULL,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_test_accounts_game_username
  ON game_test_accounts(game_id,lower(username));
CREATE INDEX IF NOT EXISTS idx_test_accounts_game
  ON game_test_accounts(game_id,created_at DESC);
