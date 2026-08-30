import { httpContracts, PROJECT_TYPES } from './http-contracts.js';

type Security = 'public' | 'admin' | 'game' | 'user';
type JsonSchema = Record<string, unknown>;
type Contract = {
  body?: JsonSchema;
  params?: {
    required?: readonly string[];
    properties?: Record<string, JsonSchema>;
  };
};
type Parameter = { name: string; in: 'path' | 'query' | 'header'; required: boolean; schema: JsonSchema; description?: string };
type OperationOptions = {
  contract?: Contract;
  parameters?: Parameter[];
  responseSchema?: JsonSchema;
};

const security = (kind: Security) => kind === 'public' ? []
  : kind === 'admin' ? [{ adminToken: [] }]
  : kind === 'game' ? [{ gameId: [], gameApiKey: [] }]
  : [{ userToken: [] }];

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const pathParameters = (contract?: Contract): Parameter[] => Object.entries(contract?.params?.properties || {})
  .map(([name, schema]) => ({
    name,
    in: 'path' as const,
    required: contract?.params?.required?.includes(name) ?? true,
    schema,
  }));

const queryParameter = (name: string, schema: JsonSchema, description?: string, required = false): Parameter => ({
  name, in: 'query', required, schema, ...(description ? { description } : {}),
});

const operation = (summary: string, kind: Security = 'admin', options: OperationOptions = {}) => {
  const parameters = [...pathParameters(options.contract), ...(options.parameters || [])];
  return {
    summary,
    security: security(kind),
    ...(parameters.length ? { parameters } : {}),
    ...(options.contract?.body ? {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: options.contract.body } },
      },
    } : {}),
    responses: {
      200: {
        description: '请求成功',
        content: { 'application/json': { schema: options.responseSchema || {} } },
      },
      400: errorResponse('请求参数错误'),
      401: errorResponse('未认证'),
      403: errorResponse('权限不足'),
      404: errorResponse('资源不存在'),
      409: errorResponse('数据冲突'),
      413: errorResponse('请求内容过大'),
      422: errorResponse('数据无法处理'),
      429: errorResponse('请求过于频繁'),
      500: errorResponse('服务器内部错误'),
    },
  };
};

const paths = {
  '/health': { get: operation('健康检查', 'public') },
  '/api/admin/login': { post: operation('管理员登录', 'public', { contract: httpContracts.login, responseSchema: { $ref: '#/components/schemas/AdminSession' } }) },
  '/api/admin/logout': { post: operation('管理员退出', 'public') },
  '/api/admin/me': { get: operation('当前管理员或项目成员账号') },
  '/api/admin/me/password': { put: operation('修改自己的登录密码', 'admin', { contract: httpContracts.changePassword }) },
  '/api/admin/admins': {
    get: operation('管理员列表', 'admin', { responseSchema: { type: 'array', items: { $ref: '#/components/schemas/AdminAccount' } } }),
    post: operation('创建管理员', 'admin', { contract: httpContracts.adminCreate, responseSchema: { $ref: '#/components/schemas/AdminAccount' } }),
  },
  '/api/admin/admins/{id}': { patch: operation('更新管理员', 'admin', { contract: httpContracts.adminUpdate, responseSchema: { $ref: '#/components/schemas/AdminAccount' } }) },
  '/api/admin/audit-logs': { get: operation('全局审计日志') },
  '/api/admin/games': {
    get: operation('可访问项目列表', 'admin', { responseSchema: { type: 'array', items: { $ref: '#/components/schemas/Project' } } }),
    post: operation('创建项目', 'admin', { contract: httpContracts.projectCreate, responseSchema: { $ref: '#/components/schemas/ProjectCreated' } }),
  },
  '/api/admin/games/{id}': {
    patch: operation('更新项目', 'admin', { contract: httpContracts.projectUpdate, responseSchema: { $ref: '#/components/schemas/Project' } }),
    delete: operation('删除项目', 'admin', {
      contract: httpContracts.gameIdParams,
      parameters: [queryParameter('confirm', { type: 'string', enum: ['DELETE'] }, '必须显式传 DELETE')],
    }),
  },
  '/api/admin/games/{id}/wechat-credentials': {
    get: operation('查看项目微信登录配置状态', 'admin', { contract: httpContracts.gameIdParams }),
    put: operation('保存项目微信登录凭证', 'admin', { contract: httpContracts.wechatCredential }),
    delete: operation('移除项目微信登录凭证', 'admin', { contract: httpContracts.gameIdParams }),
  },
  '/api/admin/games/{id}/keys': {
    get: operation('项目密钥列表', 'admin', { contract: httpContracts.gameIdParams }),
    post: operation('创建项目密钥', 'admin', { contract: httpContracts.apiKeyCreate }),
  },
  '/api/admin/games/{id}/members': { get: operation('游戏成员列表') },
  '/api/admin/games/{id}/members/{adminId}': {
    put: operation('设置项目成员角色', 'admin', { contract: httpContracts.projectMemberUpdate }),
    delete: operation('移除项目成员', 'admin', { contract: httpContracts.projectMemberParams }),
  },
  '/api/admin/games/{id}/test-accounts': {
    get: operation('项目测试玩家账号列表', 'admin', { contract: httpContracts.gameIdParams }),
    post: operation('生成项目测试玩家账号', 'admin', { contract: httpContracts.testAccountCreate }),
  },
  '/api/admin/test-accounts/{id}': { patch: operation('启用或停用测试玩家账号', 'admin', { contract: httpContracts.testAccountUpdate }) },
  '/api/admin/test-accounts/{id}/data': { delete: operation('清空测试玩家账号的存档、打点和关联幂等数据', 'admin', { contract: httpContracts.idParams }) },
  '/api/admin/test-accounts/{id}/reset-password': { post: operation('重置测试玩家账号密码', 'admin', { contract: httpContracts.idParams }) },
  '/api/admin/keys/{id}': { patch: operation('更新项目密钥', 'admin', { contract: httpContracts.apiKeyUpdate }) },
  '/api/admin/games/{id}/rotate-key': { post: operation('轮换游戏密钥') },
  '/api/admin/games/{id}/configs': { get: operation('游戏配置列表'), post: operation('创建游戏配置') },
  '/api/admin/games/{id}/config-drafts': { get: operation('项目待发布配置草稿') },
  '/api/admin/games/{id}/configs/publish-batch': { post: operation('事务批量发布配置草稿') },
  '/api/admin/excel/convert': { post: operation('解析 Excel 配置') },
  '/api/admin/configs/{id}': { put: operation('直接发布配置'), delete: operation('删除配置') },
  '/api/admin/configs/{id}/drafts': { post: operation('创建配置草稿') },
  '/api/admin/configs/{id}/history': { get: operation('配置历史') },
  '/api/admin/configs/{id}/schema': { put: operation('设置配置 JSON Schema') },
  '/api/admin/configs/{id}/diff': { get: operation('对比发布版本') },
  '/api/admin/configs/{id}/publish': { post: operation('发布配置草稿') },
  '/api/admin/configs/{id}/drafts/{revisionId}/schedule': {
    put: operation('设置草稿定时发布'),
    delete: operation('取消草稿定时发布'),
  },
  '/api/admin/configs/{id}/rollback': { post: operation('回滚配置') },
  '/api/admin/games/{id}/configs/export': { get: operation('导出游戏配置') },
  '/api/admin/games/{id}/configs/import': { post: operation('批量导入游戏配置') },
  '/api/admin/games/{id}/users': { get: operation('游戏用户列表') },
  '/api/admin/users/{id}/archives': { get: operation('用户存档列表', 'admin', { contract: httpContracts.idParams }) },
  '/api/admin/archives/{id}/history': { get: operation('存档历史', 'admin', { contract: httpContracts.idParams }) },
  '/api/admin/archives/{id}': {
    put: operation('管理员更新存档', 'admin', { contract: httpContracts.archiveAdminUpdate, responseSchema: { $ref: '#/components/schemas/Archive' } }),
    delete: operation('管理员删除存档', 'admin', { contract: httpContracts.idParams }),
  },
  '/api/admin/archives/{id}/restore': { post: operation('恢复存档历史版本', 'admin', { contract: httpContracts.archiveRestore, responseSchema: { $ref: '#/components/schemas/Archive' } }) },
  '/api/admin/games/{id}/audit-logs': { get: operation('游戏审计日志') },
  '/api/admin/games/{id}/metrics': { get: operation('游戏请求指标') },
  '/api/admin/games/{id}/alerts': { get: operation('游戏告警') },
  '/api/admin/games/{id}/event-definitions': { get: operation('运营打点定义列表'), post: operation('创建运营打点定义') },
  '/api/admin/games/{id}/event-definitions/batch': { post: operation('批量创建运营打点定义') },
  '/api/admin/event-definitions/{id}': { patch: operation('更新或启停运营打点定义'), delete: operation('删除无历史数据的打点定义') },
  '/api/admin/games/{id}/analytics': { get: operation('运营打点汇总', 'admin', {
    contract: httpContracts.gameIdParams,
    parameters: [
      queryParameter('days', { type: 'integer', minimum: 1, maximum: 90, default: 7 }),
      queryParameter('include_test', { type: 'boolean', default: false }, '是否包含测试账号数据'),
    ],
  }) },
  '/api/admin/games/{id}/analytics/level-results': { get: operation('按玩法查询关卡成功、失败、最高进度与疑似卡关分析', 'admin', {
    contract: httpContracts.gameIdParams,
    parameters: [
      queryParameter('event_key', { type: 'string', maxLength: 96 }, undefined, true),
      queryParameter('mode_id', { type: 'string', maxLength: 64 }, undefined, true),
      queryParameter('include_test', { type: 'boolean', default: false }),
    ],
  }) },
  '/api/admin/games/{id}/analytics/properties': { get: operation('按项目自定义字段查询通用属性分析', 'admin', {
    contract: httpContracts.gameIdParams,
    parameters: [
      queryParameter('event_key', { type: 'string', maxLength: 96 }, undefined, true),
      queryParameter('days', { type: 'integer', minimum: 1, maximum: 90, default: 7 }),
      queryParameter('include_test', { type: 'boolean', default: false }),
    ],
    responseSchema: { $ref: '#/components/schemas/PropertyAnalysis' },
  }) },
  '/api/client/configs': { get: operation('获取全部项目配置', 'game', { parameters: [queryParameter('environment', { $ref: '#/components/schemas/Environment' })] }) },
  '/api/client/configs/{key}': { get: operation('获取单项项目配置', 'game', { parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 128 } }, queryParameter('environment', { $ref: '#/components/schemas/Environment' })] }) },
  '/api/client/users/resolve': { post: operation('可信服务解析用户', 'game', { contract: httpContracts.resolveUser, responseSchema: { $ref: '#/components/schemas/UserSession' } }) },
  '/api/client/test-session': { post: operation('使用项目测试账号创建玩家会话', 'public', { contract: httpContracts.testSession, parameters: [{ name: 'X-Game-Id', in: 'header', required: true, schema: { type: 'string' } }], responseSchema: { $ref: '#/components/schemas/UserSession' } }) },
  '/api/client/session': { post: operation('使用平台凭证创建用户会话', 'public', { contract: httpContracts.platformSession, parameters: [{ name: 'X-Game-Id', in: 'header', required: true, schema: { type: 'string' } }], responseSchema: { $ref: '#/components/schemas/UserSession' } }) },
  '/api/client/me/configs': { get: operation('读取当前用户所属项目的全部配置', 'user', { parameters: [queryParameter('environment', { $ref: '#/components/schemas/Environment' })] }) },
  '/api/client/me/configs/{key}': { get: operation('读取当前用户所属项目的单项配置', 'user', { parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 128 } }, queryParameter('environment', { $ref: '#/components/schemas/Environment' })] }) },
  '/api/client/events': { post: operation('可信服务批量上报运营打点', 'game', { contract: httpContracts.events, responseSchema: { $ref: '#/components/schemas/TrackingResult' } }) },
  '/api/client/me/events': { post: operation('当前用户批量上报运营打点', 'user', { contract: httpContracts.events, responseSchema: { $ref: '#/components/schemas/TrackingResult' } }) },
  '/api/client/me/archives/{slot}': {
    get: operation('读取当前用户存档，不存在时返回 null', 'user', { contract: httpContracts.ownArchiveParams, responseSchema: { anyOf: [{ $ref: '#/components/schemas/Archive' }, { type: 'null' }] } }),
    put: operation('保存当前用户存档', 'user', { contract: { ...httpContracts.ownArchiveParams, ...httpContracts.archiveBody }, responseSchema: { $ref: '#/components/schemas/Archive' } }),
    delete: operation('删除当前用户存档', 'user', { contract: httpContracts.ownArchiveParams }),
  },
  '/api/client/users/{userId}/archives/{slot}': {
    get: operation('可信服务读取用户存档', 'game', { contract: httpContracts.trustedArchiveParams, responseSchema: { $ref: '#/components/schemas/Archive' } }),
    put: operation('可信服务保存用户存档', 'game', { contract: { ...httpContracts.trustedArchiveParams, ...httpContracts.archiveBody }, responseSchema: { $ref: '#/components/schemas/Archive' } }),
  },
} as const;

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: '游戏数据中心 API',
    version: '2.5.0',
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
      Error: {
        type: 'object', additionalProperties: false,
        properties: { error: { type: 'string' }, code: { type: 'string' }, current: {} },
        required: ['error'],
      },
      Environment: { type: 'string', enum: ['production', 'staging', 'development'], default: 'production' },
      AdminAccount: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, username: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'viewer'] }, must_change_password: { type: 'boolean' },
        },
        required: ['id', 'username', 'role', 'must_change_password'],
      },
      AdminSession: {
        type: 'object',
        properties: {
          token: { type: 'string' }, user: { $ref: '#/components/schemas/AdminAccount' },
        },
        required: ['token', 'user'],
      },
      Project: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, game_key: { type: 'string' }, name: { type: 'string' },
          description: { type: 'string' }, project_type: { type: 'string', enum: [...PROJECT_TYPES] },
          enabled: { type: 'boolean' }, settings: { type: 'object' },
        },
        required: ['id', 'game_key', 'name', 'project_type', 'enabled'],
      },
      ProjectCreated: {
        allOf: [
          { $ref: '#/components/schemas/Project' },
          { type: 'object', properties: { api_key: { type: 'string' }, warning: { type: 'string' } }, required: ['api_key'] },
        ],
      },
      UserSession: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, user_token: { type: 'string' }, expires_in: { type: 'integer' },
        },
        required: ['id', 'user_token', 'expires_in'],
      },
      Archive: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, slot: { type: 'string' }, data: {},
          version: { type: 'integer' }, updated_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'slot', 'data', 'version', 'updated_at'],
      },
      TrackingResult: {
        type: 'object',
        properties: {
          accepted: { type: 'integer' }, duplicated: { type: 'integer' }, rejected: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' }, eventKey: { type: 'string' },
                status: { type: 'string', enum: ['accepted', 'duplicated', 'rejected'] },
                code: { type: 'string' }, message: { type: 'string' },
              },
              required: ['index', 'eventKey', 'status'],
            },
          },
        },
        required: ['accepted', 'duplicated', 'rejected', 'results'],
      },
      PropertyAnalysis: {
        type: 'object',
        properties: {
          event_key: { type: 'string' }, event_name: { type: 'string' }, days: { type: 'integer' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' }, description: { type: 'string' },
                type: { type: 'string', enum: ['number', 'dimension'] },
                present_count: { type: 'integer' }, valid_count: { type: 'integer' },
                invalid_count: { type: 'integer' }, unique_actors: { type: 'integer' },
                minimum: { type: ['number', 'null'] }, maximum: { type: ['number', 'null'] },
                average: { type: ['number', 'null'] }, sum: { type: ['number', 'null'] },
                values: {
                  type: 'array', items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string' }, count: { type: 'integer' }, unique_actors: { type: 'integer' },
                    },
                    required: ['value', 'count', 'unique_actors'],
                  },
                },
                truncated: { type: 'boolean' },
              },
              required: ['key', 'description', 'type', 'present_count', 'valid_count', 'invalid_count', 'unique_actors'],
            },
          },
        },
        required: ['event_key', 'event_name', 'days', 'fields'],
      },
    },
  },
  paths,
} as const;
