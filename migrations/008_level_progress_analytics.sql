ALTER TABLE game_event_definitions
  ADD COLUMN IF NOT EXISTS analysis_type varchar(32) NOT NULL DEFAULT 'count';

ALTER TABLE game_event_definitions
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
