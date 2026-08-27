CREATE TABLE IF NOT EXISTS game_event_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  event_key varchar(96) NOT NULL,
  name varchar(128) NOT NULL,
  category varchar(64) NOT NULL DEFAULT 'custom',
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(game_id,event_key)
);

CREATE TABLE IF NOT EXISTS game_events (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  event_key varchar(96) NOT NULL,
  user_id uuid REFERENCES game_users(id) ON DELETE SET NULL,
  session_id varchar(191),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key varchar(191),
  CHECK(user_id IS NOT NULL OR session_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_game_events_time ON game_events(game_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_events_key_time ON game_events(game_id,event_key,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_events_user ON game_events(game_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_events_idempotency
  ON game_events(game_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

INSERT INTO game_event_definitions(game_id,event_key,name,category,description)
SELECT id,'video_ad_click','激励视频点击','video_ad','玩家点击激励视频入口' FROM games
ON CONFLICT(game_id,event_key) DO NOTHING;

INSERT INTO game_event_definitions(game_id,event_key,name,category,description)
SELECT id,'video_ad_play_success','激励视频播放成功','video_ad','激励视频成功开始播放' FROM games
ON CONFLICT(game_id,event_key) DO NOTHING;
