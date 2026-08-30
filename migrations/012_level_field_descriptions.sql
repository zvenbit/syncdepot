UPDATE game_event_definitions
SET settings = jsonb_set(
  settings,
  '{level_fields}',
  COALESCE((
    SELECT jsonb_agg(
      CASE
        WHEN jsonb_typeof(entry.value) = 'string' THEN jsonb_build_object(
          'field', entry.value #>> '{}',
          'description', entry.value #>> '{}'
        )
        ELSE entry.value
      END
      ORDER BY entry.ordinality
    )
    FROM jsonb_array_elements(settings->'level_fields') WITH ORDINALITY AS entry(value, ordinality)
  ), '[]'::jsonb)
)
WHERE analysis_type = 'level_progress'
  AND jsonb_typeof(settings->'level_fields') = 'array';
