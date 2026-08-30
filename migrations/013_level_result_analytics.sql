CREATE TABLE IF NOT EXISTS level_result_events (
  event_id bigint PRIMARY KEY REFERENCES game_events(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  event_key varchar(96) NOT NULL,
  player_id uuid NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
  schema_version smallint NOT NULL,
  mode_id varchar(64) NOT NULL,
  level_id varchar(128) NOT NULL,
  level_order integer NOT NULL,
  result varchar(16) NOT NULL,
  fail_reason varchar(64),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_level_result_order CHECK(level_order >= 1),
  CONSTRAINT ck_level_result_value CHECK(result IN ('success','fail')),
  CONSTRAINT ck_level_result_fail_reason CHECK(result = 'fail' OR fail_reason IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_level_result_level
  ON level_result_events(game_id,event_key,mode_id,level_order,result);

CREATE INDEX IF NOT EXISTS idx_level_result_player
  ON level_result_events(game_id,event_key,player_id,mode_id,level_order);

CREATE INDEX IF NOT EXISTS idx_level_result_time
  ON level_result_events(game_id,event_key,occurred_at);

UPDATE game_event_definitions AS definition
SET analysis_type = 'level_result',
    settings = jsonb_build_object(
      'suspected_stuck_failures', 3,
      'collection_started_at', now(),
      'modes', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', CASE
              WHEN jsonb_typeof(entry.value) = 'string' THEN entry.value #>> '{}'
              ELSE entry.value->>'field'
            END,
            'display_name', CASE
              WHEN jsonb_typeof(entry.value) = 'string' THEN entry.value #>> '{}'
              ELSE COALESCE(NULLIF(entry.value->>'description',''),entry.value->>'field')
            END,
            'fail_reasons', '[]'::jsonb
          )
          ORDER BY entry.ordinality
        )
        FROM jsonb_array_elements(definition.settings->'level_fields') WITH ORDINALITY AS entry(value, ordinality)
      ), '[]'::jsonb)
    ),
    updated_at = now()
WHERE analysis_type = 'level_progress';
