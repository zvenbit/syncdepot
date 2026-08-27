-- 移除 2.1 曾自动创建、但从未产生数据的示例事件。
-- 已经有历史数据的定义保留为普通项目事件，避免统计数据失去名称和分类。
DELETE FROM game_event_definitions d
WHERE d.event_key IN ('video_ad_click','video_ad_play_success')
  AND NOT EXISTS (
    SELECT 1 FROM game_events e
    WHERE e.game_id=d.game_id AND e.event_key=d.event_key
  );
