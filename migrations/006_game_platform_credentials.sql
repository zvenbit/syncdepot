CREATE TABLE IF NOT EXISTS game_platform_credentials (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  provider varchar(64) NOT NULL,
  app_id varchar(191) NOT NULL,
  secret_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(game_id,provider)
);
