CREATE INDEX IF NOT EXISTS idx_game_events_user
  ON game_events(user_id) WHERE user_id IS NOT NULL;
