import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('项目卡片直达概览，项目子页提供返回入口和运营数据页', async () => {
  const html = await fs.readFile('public/index.html', 'utf8');

  assert.match(html, /id="backButton"[^>]+onclick="showGames\(\)"/);
  assert.match(html, /<article class="project-card"[^>]+onclick="showProject\('\$\{g\.id\}'\)"/);
  assert.match(html, /function showAnalytics\(id/);
  assert.match(html, /运营数据/);
  assert.match(html, /function openEventDefinition\(definition/);
  assert.match(html, /function updateEventDefinition\(/);
  assert.match(html, /function toggleEventDefinition\(/);
  assert.match(html, /function deleteEventDefinition\(/);
  assert.doesNotMatch(html, /video_ad_click|video_ad_play_success|视频播放成功率/);
});
