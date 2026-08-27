type Security = 'public' | 'admin' | 'game' | 'user';

const security = (kind: Security) => kind === 'public' ? []
  : kind === 'admin' ? [{ adminToken: [] }]
  : kind === 'game' ? [{ gameId: [], gameApiKey: [] }]
  : [{ userToken: [] }];

const operation = (summary: string, kind: Security = 'admin') => ({
  summary,
  security: security(kind),
  responses: {
    200: { description: '请求成功' },
    400: { description: '请求参数错误' },
    401: { description: '未认证' },
    403: { description: '权限不足' },
    409: { description: '数据冲突' },
  },
});

const paths = {
  '/health': { get: operation('健康检查', 'public') },
  '/api/admin/login': { post: operation('管理员登录', 'public') },
  '/api/admin/logout': { post: operation('管理员退出', 'public') },
  '/api/admin/admins': { get: operation('管理员列表'), post: operation('创建管理员') },
  '/api/admin/admins/{id}': { patch: operation('更新管理员') },
  '/api/admin/audit-logs': { get: operation('全局审计日志') },
  '/api/admin/games': { get: operation('可访问游戏列表'), post: operation('创建游戏') },
  '/api/admin/games/{id}': { patch: operation('更新游戏'), delete: operation('删除游戏') },
  '/api/admin/games/{id}/keys': { get: operation('游戏密钥列表'), post: operation('创建游戏密钥') },
  '/api/admin/games/{id}/members': { get: operation('游戏成员列表') },
  '/api/admin/games/{id}/members/{adminId}': { put: operation('设置游戏成员角色'), delete: operation('移除游戏成员') },
  '/api/admin/keys/{id}': { patch: operation('更新游戏密钥') },
  '/api/admin/games/{id}/rotate-key': { post: operation('轮换游戏密钥') },
  '/api/admin/games/{id}/configs': { get: operation('游戏配置列表'), post: operation('创建游戏配置') },
  '/api/admin/excel/convert': { post: operation('解析 Excel 配置') },
  '/api/admin/configs/{id}': { put: operation('直接发布配置'), delete: operation('删除配置') },
  '/api/admin/configs/{id}/drafts': { post: operation('创建配置草稿') },
  '/api/admin/configs/{id}/history': { get: operation('配置历史') },
  '/api/admin/configs/{id}/schema': { put: operation('设置配置 JSON Schema') },
  '/api/admin/configs/{id}/diff': { get: operation('对比发布版本') },
  '/api/admin/configs/{id}/publish': { post: operation('发布配置草稿') },
  '/api/admin/configs/{id}/rollback': { post: operation('回滚配置') },
  '/api/admin/games/{id}/configs/export': { get: operation('导出游戏配置') },
  '/api/admin/games/{id}/configs/import': { post: operation('批量导入游戏配置') },
  '/api/admin/games/{id}/users': { get: operation('游戏用户列表') },
  '/api/admin/users/{id}/archives': { get: operation('用户存档列表') },
  '/api/admin/archives/{id}/history': { get: operation('存档历史') },
  '/api/admin/archives/{id}': { put: operation('管理员更新存档'), delete: operation('管理员删除存档') },
  '/api/admin/archives/{id}/restore': { post: operation('恢复存档历史版本') },
  '/api/admin/games/{id}/audit-logs': { get: operation('游戏审计日志') },
  '/api/admin/games/{id}/metrics': { get: operation('游戏请求指标') },
  '/api/admin/games/{id}/alerts': { get: operation('游戏告警') },
  '/api/admin/games/{id}/event-definitions': { get: operation('运营打点定义列表'), post: operation('创建运营打点定义') },
  '/api/admin/event-definitions/{id}': { patch: operation('更新或启停运营打点定义'), delete: operation('删除无历史数据的打点定义') },
  '/api/admin/games/{id}/analytics': { get: operation('运营打点汇总') },
  '/api/client/configs': { get: operation('获取全部游戏配置', 'game') },
  '/api/client/configs/{key}': { get: operation('获取单项游戏配置', 'game') },
  '/api/client/users/resolve': { post: operation('可信服务解析用户', 'game') },
  '/api/client/session': { post: operation('使用平台凭证创建用户会话', 'public') },
  '/api/client/events': { post: operation('可信服务批量上报运营打点', 'game') },
  '/api/client/me/events': { post: operation('当前用户批量上报运营打点', 'user') },
  '/api/client/me/archives/{slot}': {
    get: operation('读取当前用户存档', 'user'),
    put: operation('保存当前用户存档', 'user'),
    delete: operation('删除当前用户存档', 'user'),
  },
  '/api/client/users/{userId}/archives/{slot}': {
    get: operation('可信服务读取用户存档', 'game'),
    put: operation('可信服务保存用户存档', 'game'),
  },
} as const;

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: '游戏数据中心 API',
    version: '2.2.0',
    description: '多游戏配置、平台身份、云存档与运营打点接口。所有管理与数据路由均列入此文档。',
  },
  servers: [{ url: '/', description: '当前服务' }],
  components: {
    securitySchemes: {
      adminToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      gameId: { type: 'apiKey', in: 'header', name: 'X-Game-Id' },
      gameApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      userToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' }, current: {} }, required: ['error'] },
      Archive: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, slot: { type: 'string' }, data: {},
          version: { type: 'integer' }, updated_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths,
} as const;
