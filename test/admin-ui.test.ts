import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const adminScriptPaths = [
  'public/admin.css',
  'public/admin-theme.js',
  'public/admin-core.js',
  'public/admin-analytics.js',
  'public/admin-management.js',
];

async function adminSource(): Promise<string> {
  const [html, ...scripts] = await Promise.all([
    fs.readFile('public/index.html', 'utf8'),
    ...adminScriptPaths.map(file => fs.readFile(file, 'utf8')),
  ]);
  return [html, ...scripts].join('\n');
}

test('项目卡片直达概览，四个项目页都提供顶部切换标签', async () => {
  const html = await adminSource();

  assert.match(html, /id="backButton"[^>]+onclick="showGames\(\)"/);
  assert.match(html, /onclick="showGames\(this\)">项目总览<\/button>/);
  assert.match(html, /subtitle\.textContent='项目配置'/);
  assert.match(html, /primary\.textContent='\+ 新建项目'/);
  assert.match(html, /<h3>新建项目<\/h3>/);
  assert.match(html, /项目标识（接入端使用）/);
  assert.match(html, /<select id="gtype">\$\{projectTypeOptions\('game'\)\}<\/select>/);
  assert.match(html, /\{value:'game',label:'游戏'\}/);
  assert.match(html, /\{value:'app',label:'APP'\}/);
  assert.match(html, /\{value:'mini_program',label:'小程序'\}/);
  assert.match(html, /\{value:'website',label:'网站'\}/);
  assert.match(html, /\{value:'server',label:'服务端'\}/);
  assert.match(html, /\{value:'other',label:'其他'\}/);
  assert.match(html, /project_type:gtype\.value/);
  assert.match(html, /id="settingProjectType"/);
  assert.match(html, /project_type:settingProjectType\.value/);
  assert.match(html, /projectTypeLabel\(g\.project_type\)/);
  assert.doesNotMatch(html, /新建游戏|集中管理游戏配置/);
  assert.match(html, /<article class="project-card"[^>]+onclick="showProject\('\$\{g\.id\}'\)"/);
  assert.match(html, /function showAnalytics\(id/);
  assert.match(html, /运营数据/);
  assert.match(html, /function openEventDefinition\(definition/);
  assert.match(html, /function updateEventDefinition\(/);
  assert.match(html, /function toggleEventDefinition\(/);
  assert.match(html, /function deleteEventDefinition\(/);
  assert.match(html, /data-event-create-mode="data"[^>]*>通过数据<\/button>/);
  assert.match(html, /data-event-create-mode="single"[^>]*>单独添加<\/button>/);
  assert.match(html, /id="eventBatchJson"/);
  assert.match(html, /onclick="previewEventDefinitionsJson\(\)"/);
  assert.doesNotMatch(html, /fillVideoEventTemplate|填入 10 个视频打点模板/);
  assert.match(html, /id="eventBatchTableKey"/);
  assert.match(html, /id="eventBatchTableName"/);
  assert.match(html, /id="eventTableKey"/);
  assert.match(html, /id="eventTableName"/);
  assert.match(html, /id="eventTableField"/);
  assert.match(html, /id="eventTableOrder"/);
  assert.match(html, /function renderAnalyticsTables\(tables\)/);
  assert.match(html, /组合表格统计/);
  assert.match(html, /服务器仅按表格标识归组/);
  assert.match(html, /\/event-definitions\/batch/);
  assert.doesNotMatch(html, /VIDEO_EVENT_DEFINITION_TEMPLATE/);
  assert.match(html, /微信登录与玩家配置/);
  assert.match(html, /POST \/api\/client\/session/);
  assert.match(html, /GET \/api\/client\/me\/configs\?environment=production/);
  assert.match(html, /\/api\/admin\/games\/\$\{selected\.id\}\/wechat-credentials/);
  assert.match(html, /id="wechatAppSecret" type="password"/);
  assert.match(html, /AppSecret 加密存储，保存后不会再次显示/);
  assert.match(html, /测试玩家账号/);
  assert.match(html, /获取测试账号/);
  assert.match(html, /\/api\/admin\/games\/\$\{id\}\/test-accounts/);
  assert.match(html, /\/api\/client\/test-session/);
  assert.match(html, /startTestSession/);
  assert.match(html, /包含测试账号数据/);
  assert.match(html, /clearTestAccountData/);
  assert.match(html, /\/api\/admin\/test-accounts\/\$\{id\}\/data/);
  assert.match(html, /id="projectTabs" class="project-tabs"/);
  assert.match(html, /首次登录请修改密码/);
  assert.match(html, /\/api\/admin\/me\/password/);
  assert.match(html, /项目成员/);
  assert.match(html, /openEditProjectKey/);
  assert.match(html, /关卡结果与疑似卡关分析/);
  assert.match(html, /analytics\/level-results\?event_key=/);
  assert.match(html, /function addEventMode\(\)/);
  assert.match(html, /data-mode-id/);
  assert.match(html, /data-mode-name/);
  assert.match(html, /data-mode-reasons/);
  assert.match(html, /添加新玩法/);
  assert.match(html, /function parseEventMatchJson\(input\)/);
  assert.match(html, /function parseEventDefinitionsJson\(input\)/);
  assert.match(html, /提交时将全部成功或全部不创建/);
  assert.match(html, /疑似卡关失败次数/);
  assert.match(html, /function renderLevelResultAnalysis\(\)/);
  assert.match(html, /自定义属性分析/);
  assert.match(html, /analytics\/properties\?event_key=/);
  assert.match(html, /function addEventProperty\(\)/);
  assert.match(html, /data-property-key/);
  assert.match(html, /添加新字段/);
  assert.match(html, /function renderPropertyAnalysis\(\)/);
  assert.match(html, /最高玩到关卡分布/);
  assert.match(html, /最高通关关卡分布/);
  assert.match(html, /当前疑似卡关分布/);
  assert.match(html, /有结果玩家通关率/);
  assert.match(html, /结果失败比例/);
  assert.doesNotMatch(html, /level_progress|level_fields|最高进度快照/);
  assert.match(html, /批量发布草稿/);
  assert.match(html, /定时发布配置/);
  assert.match(html, /function renderProjectTabs\(active,id\)/);
  assert.match(html, /onclick="showProject\('\$\{id\}'\)"[^>]*>概览</);
  assert.match(html, /onclick="showAnalytics\('\$\{id\}'\)"[^>]*>运营</);
  assert.match(html, /onclick="showConfigs\('\$\{id\}'\)"[^>]*>配置</);
  assert.match(html, /onclick="showUsers\('\$\{id\}'\)"[^>]*>存档</);
  assert.match(html, /enterProjectPage\('overview',id\)/);
  assert.match(html, /enterProjectPage\('analytics',id\)/);
  assert.match(html, /enterProjectPage\('configs',id\)/);
  assert.match(html, /enterProjectPage\('archives',id\)/);
  assert.match(html, /<option value="production">production（生产环境）<\/option>/);
  assert.match(html, /<option value="staging">staging（预发布环境）<\/option>/);
  assert.match(html, /<option value="development">development（开发环境）<\/option>/);
  assert.doesNotMatch(html, /project-overview-actions/);
});

test('自定义属性分析可从 JSON 定义或上报样例匹配多个通用字段', async () => {
  const html = await adminSource();
  const parserStart = html.indexOf('function parseEventMatchJson(input)');
  const parserEnd = html.indexOf('\nfunction matchEventJson()', parserStart);
  const context: Record<string, unknown> = {
    definition: {
      event_key: 'player_snapshot',
      name: '玩家状态快照',
      analysis_type: 'property',
      settings: {
        fields: [
          { key: 'stats.power', description: '战力', type: 'number' },
          { key: 'chapter', description: '章节', type: 'dimension', limit: 30 },
        ],
      },
    },
    sample: {
      event_key: 'mini_program_state',
      analysis_type: 'property',
      properties: { score: 12, source: 'share' },
    },
  };
  vm.runInNewContext(
    `${html.slice(parserStart, parserEnd)}\nmatchedDefinition=parseEventMatchJson(definition);matchedSample=parseEventMatchJson(sample);`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify((context.matchedDefinition as { fields: unknown }).fields)), [
    { key: 'stats.power', description: '战力', type: 'number', limit: 20 },
    { key: 'chapter', description: '章节', type: 'dimension', limit: 30 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify((context.matchedSample as { fields: unknown }).fields)), [
    { key: 'score', description: 'score', type: 'number', limit: 20 },
    { key: 'source', description: 'source', type: 'dimension', limit: 20 },
  ]);
});

test('新增打点 JSON 匹配会合并多个玩法和失败原因', async () => {
  const html = await adminSource();
  const start = html.indexOf('function parseEventMatchJson(input)');
  const end = html.indexOf('\nfunction matchEventJson()', start);
  assert.ok(start >= 0 && end > start, '应提供可独立验证的 JSON 匹配函数');
  const context: Record<string, unknown> = {
    input: JSON.stringify({
      event_key: 'level_result',
      name: '关卡结果',
      category: 'level',
      analysis_type: 'level_result',
      settings: {
        suspected_stuck_failures: 4,
        modes: [
          { id: 'mode_a', display_name: '测试玩法 A', fail_reasons: ['test_failure_a'] },
        ],
      },
      events: [
        {
          event_key: 'level_result',
          properties: { mode_id: 'mode_a', level_id: 'mode-a-001', level_order: 1, result: 'fail', fail_reason: 'other_failure' },
        },
        {
          event_key: 'level_result',
          properties: { mode_id: 'mode_b', mode_name: '测试玩法 B', level_id: 'mode-b-001', level_order: 1, result: 'fail', fail_reason: 'test_failure_b' },
        },
      ],
    }),
  };
  vm.runInNewContext(`${html.slice(start, end)}\nmatched=parseEventMatchJson(input);`, context);
  const matched = JSON.parse(JSON.stringify(context.matched));

  assert.deepEqual(matched, {
    event_key: 'level_result',
    name: '关卡结果',
    category: 'level',
    description: '',
    analysis_type: 'level_result',
    suspected_stuck_failures: 4,
    modes: [
      { id: 'mode_a', display_name: '测试玩法 A', fail_reasons: ['test_failure_a', 'other_failure'] },
      { id: 'mode_b', display_name: '测试玩法 B', fail_reasons: ['test_failure_b'] },
    ],
  });
});

test('批量 JSON 会把同一 event_key 的上报样例合并为一个打点定义', async () => {
  const html = await adminSource();
  const parserStart = html.indexOf('function parseEventMatchJson(input)');
  const parserEnd = html.indexOf('\nfunction matchEventJson()', parserStart);
  const context: Record<string, unknown> = {
    input: JSON.stringify([
      {
        event_key: 'level_result',
        properties: {
          schema_version: 1, mode_id: 'mode_a', mode_name: '测试玩法 A', level_id: 'mode-a-001',
          level_order: 1, result: 'fail', fail_reason: 'test_failure_a',
        },
      },
      {
        event_key: 'level_result',
        properties: {
          schema_version: 1, mode_id: 'mode_b', mode_name: '测试玩法 B', level_id: 'mode-b-001',
          level_order: 1, result: 'fail', fail_reason: 'test_failure_b',
        },
      },
      { event_key: 'player_snapshot', properties: { power: 1200 } },
      { event_key: 'player_snapshot', properties: { chapter: 'chapter_2' } },
    ]),
  };
  vm.runInNewContext(`${html.slice(parserStart, parserEnd)}\nmatched=parseEventDefinitionsJson(input);`, context);
  const matched = JSON.parse(JSON.stringify(context.matched));

  assert.equal(matched.length, 2);
  assert.deepEqual(matched[0], {
    event_key: 'level_result', name: '关卡结果', category: 'level', description: '', analysis_type: 'level_result',
    settings: {
      suspected_stuck_failures: 3,
      modes: [
        { id: 'mode_a', display_name: '测试玩法 A', fail_reasons: ['test_failure_a'] },
        { id: 'mode_b', display_name: '测试玩法 B', fail_reasons: ['test_failure_b'] },
      ],
    },
  });
  assert.deepEqual(matched[1], {
    event_key: 'player_snapshot', name: 'player_snapshot', category: 'custom', description: '', analysis_type: 'property',
    settings: {
      fields: [
        { key: 'power', description: 'power', type: 'number', limit: 20 },
        { key: 'chapter', description: 'chapter', type: 'dimension', limit: 20 },
      ],
    },
  });
});

test('新增打点支持 JSON 数组解析预览且不内置业务模板', async () => {
  const html = await adminSource();
  const parserStart = html.indexOf('function parseEventMatchJson(input)');
  const parserEnd = html.indexOf('\nfunction matchEventJson()', parserStart);
  const parserContext: Record<string, unknown> = {
    input: JSON.stringify([
      { event_key: 'video_ad_click', name: '激励视频入口点击', category: 'rewarded_video', analysis_type: 'count' },
      { event_key: 'video_ad_show', name: '激励视频曝光', category: 'rewarded_video', analysis_type: 'count' },
    ]),
  };
  vm.runInNewContext(`${html.slice(parserStart, parserEnd)}\nmatched=parseEventDefinitionsJson(input);`, parserContext);
  assert.deepEqual(JSON.parse(JSON.stringify(parserContext.matched)), [
    {
      event_key: 'video_ad_click', name: '激励视频入口点击', category: 'rewarded_video',
      description: '', analysis_type: 'count', settings: {},
    },
    {
      event_key: 'video_ad_show', name: '激励视频曝光', category: 'rewarded_video',
      description: '', analysis_type: 'count', settings: {},
    },
  ]);

  assert.doesNotMatch(html, /VIDEO_EVENT_DEFINITION_TEMPLATE|fillVideoEventTemplate/);
});

test('批量与单条打点共用通用组合表格字段', async () => {
  const html = await adminSource();
  const parserStart = html.indexOf('function parseEventMatchJson(input)');
  const parserEnd = html.indexOf('\nfunction matchEventJson()', parserStart);
  const values: Record<string, { value: string }> = {
    eventBatchTableKey: { value: 'generic_events' },
    eventBatchTableName: { value: '通用事件统计' },
  };
  const context: Record<string, unknown> = {
    input: JSON.stringify([
      { event_key: 'generic_open', name: '打开入口', analysis_type: 'count' },
      {
        event_key: 'generic_finish', name: '完成流程', analysis_type: 'count',
        settings: { table: { key: 'old_group', name: '旧分组', field: '自定义完成字段', order: 5 } },
      },
    ]),
    document: { getElementById: (id: string) => values[id] || null },
  };
  vm.runInNewContext(
    `${html.slice(parserStart, parserEnd)}\nmatched=applyEventBatchTable(parseEventDefinitionsJson(input));`,
    context,
  );
  const matched = JSON.parse(JSON.stringify(context.matched));
  assert.deepEqual(matched.map((item: { settings: { table: unknown } }) => item.settings.table), [
    { key: 'generic_events', name: '通用事件统计', field: '打开入口', order: 10 },
    { key: 'generic_events', name: '通用事件统计', field: '自定义完成字段', order: 5 },
  ]);
});

test('设置菜单管理后台皮肤和当前账号密码', async () => {
  const html = await adminSource();
  const settingsIndex = html.indexOf('class="nav settings-nav"');
  const logoutIndex = html.indexOf('class="nav logout-nav"');

  assert.ok(settingsIndex >= 0, '侧栏应提供设置菜单');
  assert.ok(logoutIndex > settingsIndex, '设置菜单应位于退出登录上方');
  assert.doesNotMatch(html, /class="nav" onclick="openPasswordDialog\(false\)">修改密码/);
  assert.match(html, /data-theme="classic"/);
  assert.match(html, /game-data-center-theme/);
  assert.match(html, /data-theme-choice="classic"/);
  assert.match(html, /data-theme-choice="aurora"/);
  assert.match(html, /html\[data-theme="aurora"\]/);
  assert.match(html, /function showSettings\(el\)/);
  assert.match(html, /账号安全/);
  assert.match(html, /onclick="openPasswordDialog\(false\)">修改登录密码/);
});

test('配置列表可以查看单项配置的完整详情', async () => {
  const html = await adminSource();

  assert.match(html, /onclick="viewConfig\('\$\{x\.id\}'\)">查看<\/button>/);
  assert.match(html, /function viewConfig\(id\)/);
  assert.match(html, /JSON 内容/);
  assert.match(html, /JSON Schema/);
  assert.match(html, /配置说明/);
  assert.match(html, /configRows=rows/);
});

test('玩家存档列表可以确认删除存档并自动刷新', async () => {
  const html = await adminSource();

  assert.match(html, /onclick="deleteArchive\('\$\{x\.id\}'\)">删除<\/button>/);
  assert.match(html, /async function deleteArchive\(id\)/);
  assert.match(html, /api\('\/api\/admin\/archives\/'\+id,\{method:'DELETE'\}\)/);
  assert.match(html, /当前存档及全部历史版本将一并删除，删除后无法恢复/);
  assert.match(html, /selectedArchiveUserId=uid/);
  assert.match(html, /await showArchives\(selectedArchiveUserId\)/);
});

test('配置和玩家存档不会把完整 JSON 写入内联事件属性', async () => {
  const html = await adminSource();

  assert.doesNotMatch(html, /JSON\.stringify\(JSON\.stringify\(x\)\)/);
  assert.match(html, /onclick="editConfig\('\$\{x\.id\}'\)"/);
  assert.match(html, /onclick="editArchive\('\$\{x\.id\}'\)"/);
  assert.match(html, /configRows\.find\(item=>item\.id===id\)/);
  assert.match(html, /archiveRows\.find\(item=>item\.id===id\)/);
});

test('后台 HTML、样式和功能脚本按模块分离加载', async () => {
  const html = await fs.readFile('public/index.html', 'utf8');

  assert.match(html, /<link rel="stylesheet" href="\/admin\.css">/);
  assert.match(html, /<script src="\/admin-theme\.js"><\/script>/);
  assert.match(html, /<script src="\/admin-core\.js"><\/script>/);
  assert.match(html, /<script src="\/admin-analytics\.js"><\/script>/);
  assert.match(html, /<script src="\/admin-management\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>(?:.|\n)*?<\/script>/);
  assert.doesNotMatch(html, /<style>/);
});
