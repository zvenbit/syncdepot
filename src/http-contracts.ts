import { GAME_SCOPES, PROJECT_TYPES } from './constants.js';

export { PROJECT_TYPES } from './constants.js';

const uuid = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
} as const;
const slot = { type: 'string', minLength: 1, maxLength: 64 } as const;
const idParams = {
  type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid },
} as const;
const gameIdParams = {
  type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid },
} as const;

export const httpContracts = {
  login: {
    body: {
      type: 'object', additionalProperties: false, required: ['username', 'password'],
      properties: {
        username: { type: 'string', minLength: 1, maxLength: 64 },
        password: { type: 'string', minLength: 1, maxLength: 256 },
      },
    },
  },
  changePassword: {
    body: {
      type: 'object', additionalProperties: false, required: ['current_password', 'new_password'],
      properties: {
        current_password: { type: 'string', minLength: 1, maxLength: 256 },
        new_password: { type: 'string', minLength: 10, maxLength: 256 },
      },
    },
  },
  projectCreate: {
    body: {
      type: 'object', additionalProperties: false, required: ['game_key', 'name'],
      properties: {
        game_key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
        name: { type: 'string', minLength: 1, maxLength: 128 },
        description: { type: 'string', maxLength: 2000 },
        project_type: { type: 'string', enum: [...PROJECT_TYPES] },
      },
    },
  },
  idParams: { params: idParams },
  gameIdParams: { params: gameIdParams },
  adminCreate: {
    body: {
      type: 'object', additionalProperties: false, required: ['username', 'password', 'role'],
      properties: {
        username: { type: 'string', minLength: 1, maxLength: 64 },
        password: { type: 'string', minLength: 10, maxLength: 256 },
        role: { type: 'string', enum: ['admin', 'viewer'] },
      },
    },
  },
  adminUpdate: {
    params: idParams,
    body: {
      type: 'object', additionalProperties: false, minProperties: 1,
      properties: {
        password: { type: 'string', minLength: 10, maxLength: 256 },
        role: { type: 'string', enum: ['admin', 'viewer'] },
      },
    },
  },
  projectUpdate: {
    params: gameIdParams,
    body: {
      type: 'object', additionalProperties: false, minProperties: 1,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 128 },
        description: { type: 'string', maxLength: 2000 },
        project_type: { type: 'string', enum: [...PROJECT_TYPES] },
        enabled: { type: 'boolean' },
        settings: { type: 'object' },
      },
    },
  },
  wechatCredential: {
    params: gameIdParams,
    body: {
      type: 'object', additionalProperties: false, required: ['app_id'],
      properties: {
        app_id: { type: 'string', minLength: 1, maxLength: 191 },
        app_secret: { type: 'string', minLength: 1, maxLength: 512 },
      },
    },
  },
  projectMemberUpdate: {
    params: {
      type: 'object', additionalProperties: false, required: ['id', 'adminId'],
      properties: { id: uuid, adminId: uuid },
    },
    body: {
      type: 'object', additionalProperties: false, required: ['role'],
      properties: { role: { type: 'string', enum: ['viewer', 'editor', 'owner'] } },
    },
  },
  projectMemberParams: {
    params: {
      type: 'object', additionalProperties: false, required: ['id', 'adminId'],
      properties: { id: uuid, adminId: uuid },
    },
  },
  apiKeyCreate: {
    params: gameIdParams,
    body: {
      type: 'object', additionalProperties: false, required: ['name', 'scopes'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 128 },
        scopes: {
          type: 'array', minItems: 1, uniqueItems: true,
          items: { type: 'string', enum: [...GAME_SCOPES] },
        },
      },
    },
  },
  apiKeyUpdate: {
    params: idParams,
    body: {
      type: 'object', additionalProperties: false, minProperties: 1,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 128 },
        enabled: { type: 'boolean' },
        scopes: {
          type: 'array', minItems: 1, uniqueItems: true,
          items: { type: 'string', enum: [...GAME_SCOPES] },
        },
      },
    },
  },
  testAccountCreate: {
    params: gameIdParams,
    body: {
      type: 'object', additionalProperties: false,
      properties: {
        username: { type: 'string', minLength: 3, maxLength: 64, pattern: '^[A-Za-z0-9_.-]+$' },
      },
    },
  },
  testAccountUpdate: {
    params: idParams,
    body: {
      type: 'object', additionalProperties: false, required: ['enabled'],
      properties: { enabled: { type: 'boolean' } },
    },
  },
  testSession: {
    body: {
      type: 'object', additionalProperties: false, required: ['username', 'password'],
      properties: {
        username: { type: 'string', minLength: 3, maxLength: 64 },
        password: { type: 'string', minLength: 1, maxLength: 256 },
      },
    },
  },
  platformSession: {
    body: {
      type: 'object', additionalProperties: false, required: ['provider', 'credential'],
      properties: {
        provider: { type: 'string', minLength: 1, maxLength: 64 },
        credential: { type: 'string', minLength: 1, maxLength: 8192 },
      },
    },
  },
  resolveUser: {
    body: {
      type: 'object', additionalProperties: false,
      anyOf: [{ required: ['openid'] }, { required: ['user_id'] }],
      properties: {
        openid: { type: 'string', minLength: 1, maxLength: 191 },
        user_id: { type: 'string', minLength: 1, maxLength: 191 },
        profile: { type: 'object' },
      },
    },
  },
  archiveBody: {
    body: {
      type: 'object', additionalProperties: false, required: ['data'],
      properties: { data: {}, version: { type: 'integer', minimum: 1 } },
    },
  },
  events: {
    body: {
      type: 'object', additionalProperties: false, required: ['events'],
      properties: {
        events: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object', additionalProperties: false, required: ['event_key'],
            properties: {
              event_key: { type: 'string', minLength: 2, maxLength: 96, pattern: '^[a-z][a-z0-9_]+$' },
              user_id: uuid,
              session_id: { type: 'string', minLength: 1, maxLength: 191 },
              properties: {},
              occurred_at: { type: 'string', minLength: 1, maxLength: 64 },
              idempotency_key: { type: 'string', minLength: 1, maxLength: 191 },
            },
          },
        },
      },
    },
  },
  archiveAdminUpdate: {
    params: idParams,
    body: {
      type: 'object', additionalProperties: false, required: ['data', 'version'],
      properties: { data: {}, version: { type: 'integer', minimum: 1 } },
    },
  },
  archiveRestore: {
    params: idParams,
    body: {
      type: 'object', additionalProperties: false, required: ['version'],
      properties: { version: { type: 'integer', minimum: 1 } },
    },
  },
  ownArchiveParams: {
    params: {
      type: 'object', additionalProperties: false, required: ['slot'], properties: { slot },
    },
  },
  trustedArchiveParams: {
    params: {
      type: 'object', additionalProperties: false, required: ['userId', 'slot'],
      properties: { userId: uuid, slot },
    },
  },
} as const;
