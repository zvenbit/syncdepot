export type RuntimeConfig = {
  port: number;
  host: string;
  jwtSecret: string;
  bodyLimit: number;
  archiveSizeLimit: number;
  trustProxy: boolean;
  rateLimitStore: 'memory' | 'database';
  metricsFlushMs: number;
  metricsMaxQueue: number;
  auditRetentionDays: number;
  eventRetentionDays: number;
  archiveHistoryRetentionDays: number;
  configHistoryRetentionDays: number;
  credentialEncryptionKey?: string;
  adminUsername?: string;
  adminPassword?: string;
  clientCorsOrigins: string[];
  nodeEnv: string;
};

const DEVELOPMENT_JWT_SECRET = 'development-only-secret-change-me';
const PLACEHOLDER_PARTS = ['replace-with', 'change-this', 'example', 'development-only'];

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 之间的整数`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`${name} 只能是 true 或 false`);
  return value === 'true';
}

function optional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function corsOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(',').map(item => {
    const candidate = item.trim();
    if (!candidate || candidate === '*') throw new Error('CLIENT_CORS_ORIGINS 必须使用精确来源，不能使用 *');
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
      return url.origin;
    } catch {
      throw new Error(`CLIENT_CORS_ORIGINS 包含无效来源：${candidate}`);
    }
  }))];
}

function assertProductionSecret(name: string, value: string | undefined, minimumBytes: number): void {
  if (!value || Buffer.byteLength(value, 'utf8') < minimumBytes) {
    throw new Error(`生产环境必须设置至少 ${minimumBytes} 位的 ${name}`);
  }
  const normalized = value.toLowerCase();
  if (PLACEHOLDER_PARTS.some(part => normalized.includes(part))) {
    throw new Error(`生产环境不能使用 ${name} 的示例值`);
  }
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const rateLimitStore = env.RATE_LIMIT_STORE || 'memory';
  if (rateLimitStore !== 'memory' && rateLimitStore !== 'database') {
    throw new Error('RATE_LIMIT_STORE 只能是 memory 或 database');
  }
  const adminUsername = optional(env.ADMIN_USERNAME);
  const adminPassword = optional(env.ADMIN_PASSWORD);
  if (Boolean(adminUsername) !== Boolean(adminPassword)) {
    throw new Error('ADMIN_USERNAME 和 ADMIN_PASSWORD 必须同时设置');
  }
  if (adminPassword && adminPassword.length < 10) throw new Error('ADMIN_PASSWORD 必须至少 10 位');

  return {
    port: integer(env, 'PORT', 8080, 1, 65535),
    host: optional(env.HOST) || '0.0.0.0',
    jwtSecret: optional(env.JWT_SECRET) || DEVELOPMENT_JWT_SECRET,
    bodyLimit: integer(env, 'BODY_LIMIT', 1_048_576, 1_024, 52_428_800),
    archiveSizeLimit: integer(env, 'ARCHIVE_SIZE_LIMIT', 262_144, 1_024, 10_485_760),
    trustProxy: boolean(env, 'TRUST_PROXY', false),
    clientCorsOrigins: corsOrigins(env.CLIENT_CORS_ORIGINS),
    rateLimitStore,
    metricsFlushMs: integer(env, 'METRICS_FLUSH_MS', 1_000, 100, 60_000),
    metricsMaxQueue: integer(env, 'METRICS_MAX_QUEUE', 10_000, 100, 1_000_000),
    auditRetentionDays: integer(env, 'AUDIT_RETENTION_DAYS', 0, 0, 3_650),
    eventRetentionDays: integer(env, 'EVENT_RETENTION_DAYS', 0, 0, 3_650),
    archiveHistoryRetentionDays: integer(env, 'ARCHIVE_HISTORY_RETENTION_DAYS', 0, 0, 3_650),
    configHistoryRetentionDays: integer(env, 'CONFIG_HISTORY_RETENTION_DAYS', 0, 0, 3_650),
    ...(optional(env.CREDENTIAL_ENCRYPTION_KEY)
      ? { credentialEncryptionKey: optional(env.CREDENTIAL_ENCRYPTION_KEY)! }
      : {}),
    ...(adminUsername ? { adminUsername } : {}),
    ...(adminPassword ? { adminPassword } : {}),
    nodeEnv: optional(env.NODE_ENV) || 'development',
  };
}

export function validateProductionConfig(config: RuntimeConfig): void {
  if (config.nodeEnv !== 'production') return;
  assertProductionSecret('JWT_SECRET', config.jwtSecret, 32);
  if (config.credentialEncryptionKey) {
    assertProductionSecret('CREDENTIAL_ENCRYPTION_KEY', config.credentialEncryptionKey, 32);
  }
  if (config.adminPassword) assertProductionSecret('ADMIN_PASSWORD', config.adminPassword, 10);
}
