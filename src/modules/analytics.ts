import type { DatabaseClient } from '../db.js';

type Query = DatabaseClient['query'];

export type AnalyticsDatabase = {
  query: Query;
  transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T>;
};

export type AnalysisType = 'count' | 'property' | 'level_result';

type EventDefinitionCommand = {
  gameId: string;
  eventKey: string;
  name: string;
  category?: string;
  description?: string;
  analysisType?: AnalysisType;
  settings?: Record<string, unknown>;
};

type PreparedEventDefinition = {
  gameId: string;
  eventKey: string;
  name: string;
  category: string;
  description: string;
  analysisType: AnalysisType;
  settings: Record<string, unknown>;
};

export type EventDefinition = {
  id: string;
  game_id: string;
  event_key: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  analysis_type: AnalysisType;
  settings: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
};

export type LevelResultMode = {
  id: string;
  displayName: string;
  failReasons: string[];
};

export type AnalyticsTableSettings = {
  key: string;
  name: string;
  field: string;
  order: number;
};

export type AnalyticsTable = {
  key: string;
  name: string;
  rows: Array<{
    eventKey: string;
    field: string;
    name: string;
    description: string;
    category: string;
    enabled: boolean;
    count: number;
    uniqueActors: number;
    averagePerActor: number | null;
    order: number;
  }>;
};

export type AnalyticsEvent = {
  eventKey: string;
  userId?: string;
  sessionId?: string;
  properties?: unknown;
  occurredAt?: string | Date;
  idempotencyKey?: string;
};

export type EventRecordItemResult = {
  index: number;
  eventKey: string;
  status: 'accepted' | 'duplicated' | 'rejected';
  code?: string;
  message?: string;
};

export type EventRecordResult = {
  accepted: number;
  duplicated: number;
  rejected: number;
  results: EventRecordItemResult[];
};

type LevelResultSettings = {
  suspectedStuckFailures: number;
  collectionStartedAt: string;
  modes: LevelResultMode[];
};

export type PropertyAnalysisField = {
  key: string;
  description: string;
  type: 'number' | 'dimension';
  limit: number;
};

type PropertyAnalysisSettings = {
  fields: PropertyAnalysisField[];
};

export type PropertyAnalysisResult = {
  eventKey: string;
  eventName: string;
  days: number;
  fields: Array<{
    key: string;
    description: string;
    type: 'number' | 'dimension';
    presentCount: number;
    validCount: number;
    invalidCount: number;
    uniqueActors: number;
    minimum?: number | null;
    maximum?: number | null;
    average?: number | null;
    sum?: number | null;
    values?: Array<{ value: string; count: number; uniqueActors: number }>;
    truncated?: boolean;
  }>;
};

type ParsedLevelResult = {
  schemaVersion: number;
  modeId: string;
  levelId: string;
  levelOrder: number;
  result: 'success' | 'fail';
  failReason: string | null;
};

type PreparedEvent = {
  index: number;
  eventKey: string;
  userId: string | null;
  sessionId: string | null;
  properties: unknown;
  occurredAt: Date;
  occurredAtProvided: boolean;
  idempotencyKey: string | null;
  definition?: EventDefinition;
  levelResult?: ParsedLevelResult;
};

type AnalyticsError = Error & { statusCode: number; code: string };

const EVENT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,95}$/;
const TABLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MODE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const FAIL_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_BATCH_SIZE = 100;
const MAX_DEFINITION_BATCH_SIZE = 100;
const MAX_PROPERTIES_BYTES = 16 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 191;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_LEVEL_MODES = 20;
const MAX_MODE_NAME_LENGTH = 128;
const MAX_FAIL_REASONS = 20;
const MAX_LEVEL_VALUE = 1_000_000_000;
const MAX_TABLE_TEXT_LENGTH = 128;
const MAX_TABLE_ORDER = 10_000;
const PROPERTY_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/;
const MAX_PROPERTY_FIELDS = 20;
const MAX_PROPERTY_FIELD_LENGTH = 128;
const MAX_PROPERTY_DIMENSION_VALUES = 100;

function httpError(message: string, statusCode: number, code = 'INVALID_EVENT'): AnalyticsError {
  return Object.assign(new Error(message), { statusCode, code });
}

function asAnalyticsError(error: unknown): AnalyticsError {
  if (error instanceof Error && typeof (error as Partial<AnalyticsError>).statusCode === 'number') {
    return error as AnalyticsError;
  }
  return httpError(error instanceof Error ? error.message : '事件格式无效', 422);
}

function rejected(index: number, eventKey: string, error: unknown): EventRecordItemResult {
  const normalized = asAnalyticsError(error);
  return { index, eventKey, status: 'rejected', code: normalized.code, message: normalized.message };
}

function validateEventKey(eventKey: string): void {
  if (!EVENT_KEY_PATTERN.test(eventKey)) {
    throw httpError('event_key 只能使用小写字母、数字和下划线，且必须以字母开头', 400, 'INVALID_EVENT_KEY');
  }
}

function eventTime(value?: string | Date): Date {
  if (value !== undefined && typeof value !== 'string' && !(value instanceof Date)) {
    throw httpError('occurred_at 不是有效时间', 400, 'INVALID_OCCURRED_AT');
  }
  const occurredAt = value ? new Date(value) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw httpError('occurred_at 不是有效时间', 400, 'INVALID_OCCURRED_AT');
  const offset = occurredAt.getTime() - Date.now();
  if (offset > MAX_FUTURE_SKEW_MS || offset < -MAX_EVENT_AGE_MS) {
    throw httpError('occurred_at 必须在过去 90 天至未来 5 分钟内', 422, 'INVALID_OCCURRED_AT');
  }
  return occurredAt;
}

function analysisType(value: unknown): AnalysisType {
  if (value === undefined || value === 'count') return 'count';
  if (value === 'property' || value === 'level_result') return value;
  throw httpError('analysis_type 必须是 count、property 或 level_result', 400, 'INVALID_ANALYSIS_TYPE');
}

function defaultStartedAt(value?: Date | string): string {
  const candidate = value ? new Date(value) : new Date();
  return Number.isNaN(candidate.getTime()) ? new Date().toISOString() : candidate.toISOString();
}

function parseLevelResultSettings(value: unknown, fallbackStartedAt?: Date | string): LevelResultSettings {
  const settings = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawThreshold = settings.suspected_stuck_failures ?? 3;
  if (!Number.isInteger(rawThreshold) || Number(rawThreshold) < 1 || Number(rawThreshold) > 100) {
    throw httpError('suspected_stuck_failures 必须是 1-100 之间的整数', 400, 'INVALID_STUCK_THRESHOLD');
  }
  const rawModes = settings.modes;
  if (!Array.isArray(rawModes) || !rawModes.length || rawModes.length > MAX_LEVEL_MODES) {
    throw httpError(`关卡结果分析必须配置 1-${MAX_LEVEL_MODES} 个玩法`, 400, 'INVALID_LEVEL_MODES');
  }
  const modes = rawModes.map((item, index): LevelResultMode => {
    const mode = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const id = typeof mode.id === 'string' ? mode.id.trim() : '';
    const displayName = typeof mode.display_name === 'string' ? mode.display_name.trim() : '';
    if (!MODE_ID_PATTERN.test(id)) {
      throw httpError(`modes[${index}].id 只能使用小写字母、数字和下划线，且必须以字母开头`, 400, 'INVALID_MODE_ID');
    }
    if (!displayName || displayName.length > MAX_MODE_NAME_LENGTH) {
      throw httpError(`modes[${index}].display_name 不能为空且不能超过 ${MAX_MODE_NAME_LENGTH} 个字符`, 400, 'INVALID_MODE_NAME');
    }
    const rawReasons = mode.fail_reasons ?? [];
    if (!Array.isArray(rawReasons) || rawReasons.length > MAX_FAIL_REASONS) {
      throw httpError(`modes[${index}].fail_reasons 最多配置 ${MAX_FAIL_REASONS} 项`, 400, 'INVALID_FAIL_REASONS');
    }
    const failReasons = rawReasons.map((reason, reasonIndex) => {
      const normalized = typeof reason === 'string' ? reason.trim() : '';
      if (!FAIL_REASON_PATTERN.test(normalized)) {
        throw httpError(`modes[${index}].fail_reasons[${reasonIndex}] 格式无效`, 400, 'INVALID_FAIL_REASON');
      }
      return normalized;
    });
    if (new Set(failReasons).size !== failReasons.length) {
      throw httpError(`modes[${index}].fail_reasons 不能重复`, 400, 'DUPLICATE_FAIL_REASON');
    }
    return { id, displayName, failReasons };
  });
  if (new Set(modes.map(item => item.id)).size !== modes.length) {
    throw httpError('玩法 mode_id 不能重复', 400, 'DUPLICATE_MODE_ID');
  }
  const startedAtValue = settings.collection_started_at;
  const startedAt = typeof startedAtValue === 'string' && startedAtValue.trim()
    ? new Date(startedAtValue)
    : new Date(defaultStartedAt(fallbackStartedAt));
  if (Number.isNaN(startedAt.getTime())) {
    throw httpError('collection_started_at 不是有效时间', 400, 'INVALID_COLLECTION_STARTED_AT');
  }
  return {
    suspectedStuckFailures: Number(rawThreshold),
    collectionStartedAt: startedAt.toISOString(),
    modes,
  };
}

function storedLevelResultSettings(settings: LevelResultSettings): Record<string, unknown> {
  return {
    suspected_stuck_failures: settings.suspectedStuckFailures,
    collection_started_at: settings.collectionStartedAt,
    modes: settings.modes.map(mode => ({
      id: mode.id,
      display_name: mode.displayName,
      fail_reasons: mode.failReasons,
    })),
  };
}

function parsePropertyAnalysisSettings(value: unknown): PropertyAnalysisSettings {
  const settings = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (!Array.isArray(settings.fields) || !settings.fields.length || settings.fields.length > MAX_PROPERTY_FIELDS) {
    throw httpError(`属性分析必须配置 1-${MAX_PROPERTY_FIELDS} 个字段`, 400, 'INVALID_PROPERTY_FIELDS');
  }
  const fields = settings.fields.map((item, index): PropertyAnalysisField => {
    const field = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const key = typeof field.key === 'string' ? field.key.trim() : '';
    const description = typeof field.description === 'string' ? field.description.trim() : '';
    if (!PROPERTY_FIELD_PATTERN.test(key) || key.length > MAX_PROPERTY_FIELD_LENGTH) {
      throw httpError(
        `fields[${index}].key 必须是点号分隔的 JSON 字段路径，且不能超过 ${MAX_PROPERTY_FIELD_LENGTH} 个字符`,
        400,
        'INVALID_PROPERTY_FIELD_KEY',
      );
    }
    if (!description || description.length > MAX_PROPERTY_FIELD_LENGTH) {
      throw httpError(
        `fields[${index}].description 不能为空且不能超过 ${MAX_PROPERTY_FIELD_LENGTH} 个字符`,
        400,
        'INVALID_PROPERTY_FIELD_DESCRIPTION',
      );
    }
    if (field.type !== 'number' && field.type !== 'dimension') {
      throw httpError(`fields[${index}].type 必须是 number 或 dimension`, 400, 'INVALID_PROPERTY_FIELD_TYPE');
    }
    const rawLimit = field.limit ?? 20;
    if (!Number.isInteger(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_PROPERTY_DIMENSION_VALUES) {
      throw httpError(
        `fields[${index}].limit 必须是 1-${MAX_PROPERTY_DIMENSION_VALUES} 之间的整数`,
        400,
        'INVALID_PROPERTY_FIELD_LIMIT',
      );
    }
    return { key, description, type: field.type, limit: Number(rawLimit) };
  });
  if (new Set(fields.map(field => field.key)).size !== fields.length) {
    throw httpError('属性分析字段 key 不能重复', 400, 'DUPLICATE_PROPERTY_FIELD_KEY');
  }
  return { fields };
}

function storedPropertyAnalysisSettings(settings: PropertyAnalysisSettings): Record<string, unknown> {
  return {
    fields: settings.fields.map(field => ({
      key: field.key,
      description: field.description,
      type: field.type,
      ...(field.type === 'dimension' ? { limit: field.limit } : {}),
    })),
  };
}

function parseAnalyticsTableSettings(value: unknown): AnalyticsTableSettings | null {
  const settings = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (settings.table === undefined || settings.table === null) return null;
  if (!settings.table || typeof settings.table !== 'object' || Array.isArray(settings.table)) {
    throw httpError('settings.table 必须是对象', 400, 'INVALID_ANALYTICS_TABLE');
  }
  const table = settings.table as Record<string, unknown>;
  const key = typeof table.key === 'string' ? table.key.trim() : '';
  const name = typeof table.name === 'string' ? table.name.trim() : '';
  const field = typeof table.field === 'string' ? table.field.trim() : '';
  const order = table.order === undefined ? 0 : Number(table.order);
  if (!TABLE_KEY_PATTERN.test(key)) {
    throw httpError('组合表格标识只能使用小写字母、数字和下划线，且必须以字母开头', 400, 'INVALID_TABLE_KEY');
  }
  if (!name || name.length > MAX_TABLE_TEXT_LENGTH) {
    throw httpError(`组合表格名称不能为空且不能超过 ${MAX_TABLE_TEXT_LENGTH} 个字符`, 400, 'INVALID_TABLE_NAME');
  }
  if (!field || field.length > MAX_TABLE_TEXT_LENGTH) {
    throw httpError(`组合表格字段不能为空且不能超过 ${MAX_TABLE_TEXT_LENGTH} 个字符`, 400, 'INVALID_TABLE_FIELD');
  }
  if (!Number.isInteger(order) || order < 0 || order > MAX_TABLE_ORDER) {
    throw httpError(`组合表格顺序必须是 0-${MAX_TABLE_ORDER} 之间的整数`, 400, 'INVALID_TABLE_ORDER');
  }
  return { key, name, field, order };
}

function storedAnalyticsTableSettings(settings: AnalyticsTableSettings): Record<string, unknown> {
  return { key: settings.key, name: settings.name, field: settings.field, order: settings.order };
}

function definitionSettings(
  type: AnalysisType,
  value: unknown,
  fallbackStartedAt?: Date | string,
): Record<string, unknown> {
  const table = parseAnalyticsTableSettings(value);
  const settings = type === 'count'
    ? {}
    : type === 'property'
      ? storedPropertyAnalysisSettings(parsePropertyAnalysisSettings(value))
      : storedLevelResultSettings(parseLevelResultSettings(value, fallbackStartedAt));
  if (table) settings.table = storedAnalyticsTableSettings(table);
  return settings;
}

function normalizedDefinition(definition: EventDefinition): EventDefinition {
  return {
    ...definition,
    settings: definitionSettings(definition.analysis_type, definition.settings, definition.created_at),
  };
}

function settingsForDefinition(definition: EventDefinition): LevelResultSettings {
  return parseLevelResultSettings(definition.settings, definition.created_at);
}

function parseLevelResult(definition: EventDefinition, event: PreparedEvent): ParsedLevelResult {
  if (!event.userId) {
    throw httpError('关卡结果事件必须使用稳定玩家身份，不能使用 session_id', 422, 'LEVEL_RESULT_REQUIRES_PLAYER');
  }
  if (!event.occurredAtProvided) {
    throw httpError('关卡结果事件必须提供 occurred_at', 422, 'MISSING_OCCURRED_AT');
  }
  if (!event.idempotencyKey) {
    throw httpError('关卡结果事件必须提供 idempotency_key', 422, 'MISSING_IDEMPOTENCY_KEY');
  }
  if (!event.properties || typeof event.properties !== 'object' || Array.isArray(event.properties)) {
    throw httpError('关卡结果事件 properties 必须是对象', 422, 'INVALID_LEVEL_RESULT_PROPERTIES');
  }
  const properties = event.properties as Record<string, unknown>;
  if (properties.schema_version !== 1) {
    throw httpError('schema_version 必须为 1', 422, 'INVALID_SCHEMA_VERSION');
  }
  const modeId = typeof properties.mode_id === 'string' ? properties.mode_id.trim() : '';
  const settings = settingsForDefinition(definition);
  const mode = settings.modes.find(item => item.id === modeId);
  if (!mode) throw httpError('mode_id 未在当前项目玩法中配置', 422, 'INVALID_MODE_ID');
  const levelId = typeof properties.level_id === 'string' ? properties.level_id.trim() : '';
  if (!levelId || levelId.length > 128) {
    throw httpError('level_id 不能为空且不能超过 128 个字符', 422, 'INVALID_LEVEL_ID');
  }
  const levelOrder = properties.level_order;
  if (!Number.isInteger(levelOrder) || Number(levelOrder) < 1 || Number(levelOrder) > MAX_LEVEL_VALUE) {
    throw httpError(`level_order 必须是 1-${MAX_LEVEL_VALUE} 之间的整数`, 422, 'INVALID_LEVEL_ORDER');
  }
  if (properties.result !== 'success' && properties.result !== 'fail') {
    throw httpError('result 必须是 success 或 fail', 422, 'INVALID_LEVEL_RESULT');
  }
  const result = properties.result;
  const rawFailReason = properties.fail_reason;
  let failReason: string | null = null;
  if (result === 'success') {
    if (rawFailReason !== undefined && rawFailReason !== null && rawFailReason !== '') {
      throw httpError('success 结果不能携带 fail_reason', 422, 'UNEXPECTED_FAIL_REASON');
    }
  } else {
    failReason = typeof rawFailReason === 'string' ? rawFailReason.trim() : '';
    if (!failReason) {
      if (mode.failReasons.length) {
        throw httpError('当前玩法配置了失败原因，fail_reason 不能为空', 422, 'MISSING_FAIL_REASON');
      }
      failReason = null;
    } else {
      if (!FAIL_REASON_PATTERN.test(failReason)) {
        throw httpError('fail_reason 格式无效', 422, 'INVALID_FAIL_REASON');
      }
      if (mode.failReasons.length && !mode.failReasons.includes(failReason)) {
        throw httpError('fail_reason 未在当前玩法中配置', 422, 'INVALID_FAIL_REASON');
      }
    }
  }
  return {
    schemaVersion: 1,
    modeId,
    levelId,
    levelOrder: Number(levelOrder),
    result,
    failReason,
  };
}

function eventResult(results: EventRecordItemResult[]): EventRecordResult {
  const ordered = [...results].sort((left, right) => left.index - right.index);
  return {
    accepted: ordered.filter(item => item.status === 'accepted').length,
    duplicated: ordered.filter(item => item.status === 'duplicated').length,
    rejected: ordered.filter(item => item.status === 'rejected').length,
    results: ordered,
  };
}

function prepareEventDefinition(command: EventDefinitionCommand): PreparedEventDefinition {
  const eventKey = command.eventKey?.trim() || '';
  validateEventKey(eventKey);
  const name = command.name?.trim();
  if (!name) throw httpError('事件名称不能为空', 400, 'INVALID_EVENT_NAME');
  const type = analysisType(command.analysisType);
  return {
    gameId: command.gameId,
    eventKey,
    name,
    category: command.category?.trim() || 'custom',
    description: command.description?.trim() || '',
    analysisType: type,
    settings: definitionSettings(type, command.settings, new Date()),
  };
}

async function insertEventDefinition(
  database: Pick<DatabaseClient, 'query'>,
  definition: PreparedEventDefinition,
): Promise<EventDefinition> {
  return (await database.query<EventDefinition>(
    `INSERT INTO game_event_definitions(game_id,event_key,name,category,description,analysis_type,settings)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
    [
      definition.gameId,
      definition.eventKey,
      definition.name,
      definition.category,
      definition.description,
      definition.analysisType,
      JSON.stringify(definition.settings),
    ],
  )).rows[0]!;
}

async function ensureAnalyticsTableCompatibility(
  database: Pick<DatabaseClient, 'query'>,
  gameId: string,
  candidates: Array<{ eventKey: string; settings: Record<string, unknown> }>,
  excludedDefinitionIds: string[] = [],
): Promise<void> {
  const candidateTables = candidates.flatMap(candidate => {
    const table = parseAnalyticsTableSettings(candidate.settings);
    return table ? [{ eventKey: candidate.eventKey, table }] : [];
  });
  const tableNames = new Map<string, string>();
  const tableFields = new Map<string, string>();
  for (const candidate of candidateTables) {
    const knownName = tableNames.get(candidate.table.key);
    if (knownName && knownName !== candidate.table.name) {
      throw httpError(`组合表格 ${candidate.table.key} 的名称必须保持一致`, 409, 'TABLE_NAME_CONFLICT');
    }
    tableNames.set(candidate.table.key, candidate.table.name);
    const fieldKey = `${candidate.table.key}\u0000${candidate.table.field}`;
    const knownEventKey = tableFields.get(fieldKey);
    if (knownEventKey && knownEventKey !== candidate.eventKey) {
      throw httpError(`组合表格字段已被事件 ${knownEventKey} 使用：${candidate.table.field}`, 409, 'TABLE_FIELD_EXISTS');
    }
    tableFields.set(fieldKey, candidate.eventKey);
  }
  if (!candidateTables.length) return;
  const excluded = new Set(excludedDefinitionIds);
  const existing = (await database.query<Pick<EventDefinition, 'id' | 'event_key' | 'settings'>>(
    `SELECT id,event_key,settings FROM game_event_definitions WHERE game_id=$1`,
    [gameId],
  )).rows;
  for (const definition of existing) {
    if (excluded.has(definition.id)) continue;
    const table = parseAnalyticsTableSettings(definition.settings);
    if (!table || !tableNames.has(table.key)) continue;
    if (tableNames.get(table.key) !== table.name) {
      throw httpError(`组合表格 ${table.key} 已使用名称：${table.name}`, 409, 'TABLE_NAME_CONFLICT');
    }
    const fieldKey = `${table.key}\u0000${table.field}`;
    const candidateEventKey = tableFields.get(fieldKey);
    if (candidateEventKey && candidateEventKey !== definition.event_key) {
      throw httpError(`组合表格字段已被事件 ${definition.event_key} 使用：${table.field}`, 409, 'TABLE_FIELD_EXISTS');
    }
  }
}

async function lockAnalyticsDefinitionNamespace(client: DatabaseClient, gameId: string): Promise<void> {
  const game = await client.query('SELECT id FROM games WHERE id=$1 FOR UPDATE', [gameId]);
  if (!game.rowCount) throw httpError('项目不存在', 404, 'GAME_NOT_FOUND');
}

export function createAnalyticsModule(database: AnalyticsDatabase) {
  return {
    async defineEvent(command: EventDefinitionCommand): Promise<EventDefinition> {
      const definition = prepareEventDefinition(command);
      try {
        return await database.transaction(async client => {
          await lockAnalyticsDefinitionNamespace(client, command.gameId);
          await ensureAnalyticsTableCompatibility(client, command.gameId, [definition]);
          return insertEventDefinition(client, definition);
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw httpError('该 event_key 已存在', 409, 'EVENT_KEY_EXISTS');
        throw error;
      }
    },

    async defineEvents(command: {
      gameId: string;
      definitions: Omit<EventDefinitionCommand, 'gameId'>[];
    }): Promise<EventDefinition[]> {
      if (!command.definitions.length || command.definitions.length > MAX_DEFINITION_BATCH_SIZE) {
        throw httpError(`definitions 必须包含 1-${MAX_DEFINITION_BATCH_SIZE} 个事件定义`, 400, 'INVALID_DEFINITION_BATCH');
      }
      const definitions = command.definitions.map(definition => prepareEventDefinition({
        ...definition,
        gameId: command.gameId,
      }));
      const seen = new Set<string>();
      for (const definition of definitions) {
        if (seen.has(definition.eventKey)) {
          throw httpError(`批量数据中 event_key 重复：${definition.eventKey}`, 400, 'DUPLICATE_EVENT_KEY');
        }
        seen.add(definition.eventKey);
      }
      try {
        return await database.transaction(async client => {
          await lockAnalyticsDefinitionNamespace(client, command.gameId);
          await ensureAnalyticsTableCompatibility(client, command.gameId, definitions);
          const existing = (await client.query<{ event_key: string }>(
            `SELECT event_key FROM game_event_definitions
             WHERE game_id=$1 AND event_key=ANY($2::text[])
             ORDER BY event_key LIMIT 1`,
            [command.gameId, definitions.map(definition => definition.eventKey)],
          )).rows[0];
          if (existing) {
            throw httpError(`该 event_key 已存在：${existing.event_key}`, 409, 'EVENT_KEY_EXISTS');
          }
          const created: EventDefinition[] = [];
          for (const definition of definitions) {
            created.push(await insertEventDefinition(client, definition));
          }
          return created;
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw httpError('批量数据中存在已创建的 event_key', 409, 'EVENT_KEY_EXISTS');
        throw error;
      }
    },

    async listDefinitions(gameId: string): Promise<EventDefinition[]> {
      const definitions = (await database.query<EventDefinition>(
        `SELECT * FROM game_event_definitions WHERE game_id=$1 ORDER BY category,event_key`,
        [gameId],
      )).rows;
      return definitions.map(normalizedDefinition);
    },

    async updateDefinition(command: {
      definitionId: string;
      name?: string;
      category?: string;
      description?: string;
      enabled?: boolean;
      analysisType?: AnalysisType;
      settings?: Record<string, unknown>;
    }): Promise<EventDefinition> {
      if (command.name !== undefined && !command.name.trim()) throw httpError('事件名称不能为空', 400, 'INVALID_EVENT_NAME');
      return database.transaction(async client => {
        const current = (await client.query<EventDefinition>(
          'SELECT * FROM game_event_definitions WHERE id=$1 FOR UPDATE', [command.definitionId],
        )).rows[0];
        if (!current) throw httpError('事件定义不存在', 404, 'EVENT_DEFINITION_NOT_FOUND');
        await lockAnalyticsDefinitionNamespace(client, current.game_id);
        const type = command.analysisType === undefined ? current.analysis_type : analysisType(command.analysisType);
        if (type !== current.analysis_type) {
          const history = (await client.query<{ count: string | number }>(
            `SELECT count(*) count FROM game_events WHERE game_id=$1 AND event_key=$2`,
            [current.game_id, current.event_key],
          )).rows[0]!;
          if (Number(history.count) > 0) {
            throw httpError('事件已有历史数据，不能修改分析方式', 409, 'ANALYSIS_TYPE_LOCKED');
          }
        }
        const settings = definitionSettings(
          type,
          command.settings === undefined ? current.settings : command.settings,
          current.created_at,
        );
        await ensureAnalyticsTableCompatibility(
          client,
          current.game_id,
          [{ eventKey: current.event_key, settings }],
          [current.id],
        );
        if (current.analysis_type === 'level_result' && type === 'level_result') {
          const previousModes = settingsForDefinition(current).modes.map(item => item.id);
          const nextModes = new Set(parseLevelResultSettings(settings, current.created_at).modes.map(item => item.id));
          const removedModes = previousModes.filter(modeId => !nextModes.has(modeId));
          if (removedModes.length) {
            const used = (await client.query<{ mode_id: string }>(
              `SELECT mode_id FROM level_result_events
               WHERE game_id=$1 AND event_key=$2 AND mode_id=ANY($3::text[]) LIMIT 1`,
              [current.game_id, current.event_key, removedModes],
            )).rows[0];
            if (used) throw httpError(`玩法 ${used.mode_id} 已有结果数据，不能移除`, 409, 'LEVEL_MODE_IN_USE');
          }
        }
        const updated = (await client.query<EventDefinition>(
          `UPDATE game_event_definitions SET
             name=COALESCE($2,name),category=COALESCE($3,category),
             description=COALESCE($4,description),enabled=COALESCE($5,enabled),
             analysis_type=$6,settings=$7::jsonb,updated_at=now()
           WHERE id=$1 RETURNING *`,
          [
            command.definitionId,
            command.name?.trim() ?? null,
            command.category?.trim() || (command.category === undefined ? null : 'custom'),
            command.description?.trim() ?? null,
            command.enabled ?? null,
            type,
            JSON.stringify(settings),
          ],
        )).rows[0]!;
        return normalizedDefinition(updated);
      });
    },

    async removeDefinition(definitionId: string): Promise<EventDefinition> {
      return database.transaction(async client => {
        const definition = (await client.query<EventDefinition>(
          `SELECT * FROM game_event_definitions WHERE id=$1 FOR UPDATE`,
          [definitionId],
        )).rows[0];
        if (!definition) throw httpError('事件定义不存在', 404, 'EVENT_DEFINITION_NOT_FOUND');
        const history = (await client.query<{ count: string | number }>(
          `SELECT count(*) count FROM game_events WHERE game_id=$1 AND event_key=$2`,
          [definition.game_id, definition.event_key],
        )).rows[0]!;
        if (Number(history.count) > 0) throw httpError('事件已有历史数据，不能删除；可以将其停用', 409, 'EVENT_HAS_HISTORY');
        await client.query(`DELETE FROM game_event_definitions WHERE id=$1`, [definitionId]);
        return definition;
      });
    },

    async recordEvents(command: { gameId: string; events: AnalyticsEvent[] }): Promise<EventRecordResult> {
      if (!Array.isArray(command.events) || command.events.length === 0 || command.events.length > MAX_BATCH_SIZE) {
        throw httpError(`events 数量必须在 1-${MAX_BATCH_SIZE} 之间`, 400, 'INVALID_BATCH_SIZE');
      }
      const results: EventRecordItemResult[] = [];
      const prepared: PreparedEvent[] = [];
      command.events.forEach((event, index) => {
        const eventKey = typeof event.eventKey === 'string' ? event.eventKey.trim() : '';
        try {
          validateEventKey(eventKey);
          const userId = typeof event.userId === 'string' && event.userId.trim() ? event.userId.trim() : null;
          const sessionId = typeof event.sessionId === 'string' && event.sessionId.trim() ? event.sessionId.trim() : null;
          if (!userId && !sessionId) throw httpError('每条事件必须提供 userId 或 sessionId', 400, 'MISSING_ACTOR');
          const properties = event.properties ?? {};
          let serialized: string;
          try {
            serialized = JSON.stringify(properties);
          } catch {
            throw httpError('事件 properties 不能序列化为 JSON', 422, 'INVALID_EVENT_PROPERTIES');
          }
          if (Buffer.byteLength(serialized, 'utf8') > MAX_PROPERTIES_BYTES) {
            throw httpError(`单条事件 properties 不能超过 ${MAX_PROPERTIES_BYTES / 1024}KB`, 413, 'EVENT_PROPERTIES_TOO_LARGE');
          }
          const idempotencyKey = typeof event.idempotencyKey === 'string' && event.idempotencyKey.trim()
            ? event.idempotencyKey.trim()
            : null;
          if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
            throw httpError(
              `idempotency_key 不能超过 ${MAX_IDEMPOTENCY_KEY_LENGTH} 个字符`,
              422,
              'INVALID_IDEMPOTENCY_KEY',
            );
          }
          prepared.push({
            index,
            eventKey,
            userId,
            sessionId,
            properties,
            occurredAt: eventTime(event.occurredAt),
            occurredAtProvided: event.occurredAt !== undefined,
            idempotencyKey,
          });
        } catch (error) {
          results.push(rejected(index, eventKey, error));
        }
      });
      if (!prepared.length) return eventResult(results);

      const keys = [...new Set(prepared.map(event => event.eventKey))];
      const definitions = (await database.query<EventDefinition>(
        `SELECT * FROM game_event_definitions WHERE game_id=$1 AND enabled=true AND event_key=ANY($2::text[])`,
        [command.gameId, keys],
      )).rows;
      const definitionsByKey = new Map(definitions.map(definition => [definition.event_key, normalizedDefinition(definition)]));
      const userIds = [...new Set(prepared.flatMap(event => event.userId ? [event.userId] : []))];
      const ownedUsers = userIds.length
        ? new Set((await database.query<{ id: string }>(
          `SELECT id FROM game_users WHERE game_id=$1 AND id::text=ANY($2::text[])`,
          [command.gameId, userIds],
        )).rows.map(item => item.id))
        : new Set<string>();

      const acceptedForInsert: PreparedEvent[] = [];
      for (const event of prepared) {
        try {
          const definition = definitionsByKey.get(event.eventKey);
          if (!definition) throw httpError(`事件未定义或已停用：${event.eventKey}`, 422, 'EVENT_NOT_DEFINED');
          if (event.userId && !ownedUsers.has(event.userId)) {
            throw httpError('玩家不属于当前项目', 422, 'PLAYER_NOT_IN_GAME');
          }
          event.definition = definition;
          if (definition.analysis_type === 'level_result') event.levelResult = parseLevelResult(definition, event);
          acceptedForInsert.push(event);
        } catch (error) {
          results.push(rejected(event.index, event.eventKey, error));
        }
      }

      if (acceptedForInsert.length) {
        await database.transaction(async client => {
          for (const event of acceptedForInsert) {
            const inserted = (await client.query<{ id: string | number; received_at: Date | string }>(
              `INSERT INTO game_events(game_id,event_key,user_id,session_id,properties,occurred_at,idempotency_key)
               VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
               ON CONFLICT(game_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
               RETURNING id,received_at`,
              [
                command.gameId,
                event.eventKey,
                event.userId,
                event.sessionId,
                JSON.stringify(event.properties),
                event.occurredAt,
                event.idempotencyKey,
              ],
            )).rows[0];
            if (!inserted) {
              results.push({ index: event.index, eventKey: event.eventKey, status: 'duplicated' });
              continue;
            }
            if (event.levelResult && event.userId) {
              const level = event.levelResult;
              await client.query(
                `INSERT INTO level_result_events(
                   event_id,game_id,event_key,player_id,schema_version,mode_id,level_id,
                   level_order,result,fail_reason,occurred_at,received_at
                 ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                  inserted.id,
                  command.gameId,
                  event.eventKey,
                  event.userId,
                  level.schemaVersion,
                  level.modeId,
                  level.levelId,
                  level.levelOrder,
                  level.result,
                  level.failReason,
                  event.occurredAt,
                  inserted.received_at,
                ],
              );
            }
            results.push({ index: event.index, eventKey: event.eventKey, status: 'accepted' });
          }
        });
      }
      return eventResult(results);
    },

    async getSummary(command: { gameId: string; days?: number; includeTest?: boolean }): Promise<{
      days: number;
      totalEvents: number;
      todayEvents: number;
      uniqueActors: number;
      byEvent: Array<{
        eventKey: string;
        name: string;
        description: string;
        category: string;
        enabled: boolean;
        count: number;
        uniqueActors: number;
        table: AnalyticsTableSettings | null;
      }>;
      tables: AnalyticsTable[];
      daily: Array<{ date: string; count: number }>;
    }> {
      const days = Math.min(90, Math.max(1, Math.trunc(command.days ?? 7)));
      const interval = `${days - 1} days`;
      const includeTest = command.includeTest === true;
      const totals = (await database.query<{ total_events: string | number; today_events: string | number; unique_actors: string | number }>(
        `SELECT count(*) total_events,
                count(*) FILTER(WHERE occurred_at >= date_trunc('day',now())) today_events,
                count(DISTINCT COALESCE(user_id::text,session_id)) unique_actors
         FROM game_events e WHERE game_id=$1 AND occurred_at >= date_trunc('day',now())-$2::interval
           AND ($3::boolean OR NOT EXISTS(SELECT 1 FROM game_test_accounts test WHERE test.user_id=e.user_id))`,
        [command.gameId, interval, includeTest],
      )).rows[0]!;
      const byEvent = (await database.query<{
        event_key: string;
        name: string;
        description: string;
        category: string;
        enabled: boolean;
        settings: Record<string, unknown>;
        count: string | number;
        unique_actors: string | number;
      }>(
        `SELECT d.event_key,d.name,d.description,d.category,d.enabled,d.settings,count(e.id) count,
                count(DISTINCT COALESCE(e.user_id::text,e.session_id)) unique_actors
         FROM game_event_definitions d
         LEFT JOIN game_events e ON e.game_id=d.game_id AND e.event_key=d.event_key
           AND e.occurred_at >= date_trunc('day',now())-$2::interval
           AND ($3::boolean OR NOT EXISTS(SELECT 1 FROM game_test_accounts test WHERE test.user_id=e.user_id))
         WHERE d.game_id=$1
         GROUP BY d.event_key,d.name,d.description,d.category,d.enabled,d.settings ORDER BY d.event_key`,
        [command.gameId, interval, includeTest],
      )).rows;
      const daily = (await database.query<{ date: string | Date; count: string | number }>(
        `SELECT day::date date,count(e.id) count
         FROM generate_series(date_trunc('day',now())-$2::interval,date_trunc('day',now()),interval '1 day') day
         LEFT JOIN game_events e ON e.game_id=$1 AND e.occurred_at >= day AND e.occurred_at < day+interval '1 day'
           AND ($3::boolean OR NOT EXISTS(SELECT 1 FROM game_test_accounts test WHERE test.user_id=e.user_id))
         GROUP BY day ORDER BY day`,
        [command.gameId, interval, includeTest],
      )).rows;
      const normalizedByEvent = byEvent.map(item => ({
        eventKey: item.event_key,
        name: item.name,
        description: item.description,
        category: item.category,
        enabled: item.enabled,
        count: Number(item.count),
        uniqueActors: Number(item.unique_actors),
        table: parseAnalyticsTableSettings(item.settings),
      }));
      const tableGroups = new Map<string, AnalyticsTable>();
      for (const item of normalizedByEvent) {
        if (!item.table) continue;
        const group = tableGroups.get(item.table.key) || {
          key: item.table.key,
          name: item.table.name,
          rows: [],
        };
        group.rows.push({
          eventKey: item.eventKey,
          field: item.table.field,
          name: item.name,
          description: item.description,
          category: item.category,
          enabled: item.enabled,
          count: item.count,
          uniqueActors: item.uniqueActors,
          averagePerActor: item.uniqueActors ? item.count / item.uniqueActors : null,
          order: item.table.order,
        });
        tableGroups.set(group.key, group);
      }
      const tables = [...tableGroups.values()]
        .map(table => ({
          ...table,
          rows: table.rows.sort((left, right) => left.order - right.order
            || left.field.localeCompare(right.field)
            || left.eventKey.localeCompare(right.eventKey)),
        }))
        .sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
      return {
        days,
        totalEvents: Number(totals.total_events),
        todayEvents: Number(totals.today_events),
        uniqueActors: Number(totals.unique_actors),
        byEvent: normalizedByEvent,
        tables,
        daily: daily.map(item => ({ date: new Date(item.date).toISOString().slice(0, 10), count: Number(item.count) })),
      };
    },

    async getPropertyAnalysis(command: {
      gameId: string;
      eventKey: string;
      days?: number;
      includeTest?: boolean;
    }): Promise<PropertyAnalysisResult> {
      const definition = (await database.query<EventDefinition>(
        `SELECT * FROM game_event_definitions WHERE game_id=$1 AND event_key=$2`,
        [command.gameId, command.eventKey],
      )).rows[0];
      if (!definition || definition.analysis_type !== 'property') {
        throw httpError('属性分析事件不存在', 404, 'PROPERTY_EVENT_NOT_FOUND');
      }
      const settings = parsePropertyAnalysisSettings(definition.settings);
      const days = Math.min(90, Math.max(1, Math.trunc(command.days ?? 7)));
      const interval = `${days - 1} days`;
      const includeTest = command.includeTest === true;
      const fields: PropertyAnalysisResult['fields'] = [];

      for (const field of settings.fields) {
        const summary = (await database.query<{
          present_count: string | number;
          valid_count: string | number;
          unique_actors: string | number;
          minimum: string | number | null;
          maximum: string | number | null;
          average: string | number | null;
          sum: string | number | null;
        }>(
          `WITH values AS (
             SELECT e.user_id,e.session_id,
                    e.properties #> string_to_array($3,'.') raw_value,
                    e.properties #>> string_to_array($3,'.') text_value
             FROM game_events e
             WHERE e.game_id=$1 AND e.event_key=$2
               AND e.occurred_at >= date_trunc('day',now())-$4::interval
               AND ($5::boolean OR NOT EXISTS(
                 SELECT 1 FROM game_test_accounts test WHERE test.user_id=e.user_id
               ))
           )
           SELECT
             count(*) FILTER(WHERE raw_value IS NOT NULL AND jsonb_typeof(raw_value)<>'null') present_count,
             count(*) FILTER(WHERE ${field.type === 'number'
              ? "jsonb_typeof(raw_value)='number'"
              : "jsonb_typeof(raw_value) IN ('string','number','boolean')"}) valid_count,
             count(DISTINCT COALESCE(user_id::text,session_id)) FILTER(WHERE ${field.type === 'number'
              ? "jsonb_typeof(raw_value)='number'"
              : "jsonb_typeof(raw_value) IN ('string','number','boolean')"}) unique_actors,
             ${field.type === 'number'
              ? `min(CASE WHEN jsonb_typeof(raw_value)='number' THEN text_value::numeric END) minimum,
                 max(CASE WHEN jsonb_typeof(raw_value)='number' THEN text_value::numeric END) maximum,
                 avg(CASE WHEN jsonb_typeof(raw_value)='number' THEN text_value::numeric END) average,
                 sum(CASE WHEN jsonb_typeof(raw_value)='number' THEN text_value::numeric END) sum`
              : 'NULL::numeric minimum,NULL::numeric maximum,NULL::numeric average,NULL::numeric sum'}
           FROM values`,
          [command.gameId, command.eventKey, field.key, interval, includeTest],
        )).rows[0]!;
        const presentCount = Number(summary.present_count);
        const validCount = Number(summary.valid_count);
        const base = {
          key: field.key,
          description: field.description,
          type: field.type,
          presentCount,
          validCount,
          invalidCount: presentCount - validCount,
          uniqueActors: Number(summary.unique_actors),
        };
        if (field.type === 'number') {
          const numberOrNull = (value: string | number | null): number | null => {
            if (value === null) return null;
            const number = Number(value);
            return Number.isFinite(number) ? number : null;
          };
          fields.push({
            ...base,
            type: 'number',
            minimum: numberOrNull(summary.minimum),
            maximum: numberOrNull(summary.maximum),
            average: numberOrNull(summary.average),
            sum: numberOrNull(summary.sum),
          });
          continue;
        }
        const values = (await database.query<{
          value: string;
          count: string | number;
          unique_actors: string | number;
        }>(
          `SELECT e.properties #>> string_to_array($3,'.') value,
                  count(*) count,count(DISTINCT COALESCE(e.user_id::text,e.session_id)) unique_actors
           FROM game_events e
           WHERE e.game_id=$1 AND e.event_key=$2
             AND e.occurred_at >= date_trunc('day',now())-$4::interval
             AND jsonb_typeof(e.properties #> string_to_array($3,'.')) IN ('string','number','boolean')
             AND ($5::boolean OR NOT EXISTS(
               SELECT 1 FROM game_test_accounts test WHERE test.user_id=e.user_id
             ))
           GROUP BY value ORDER BY count(*) DESC,value LIMIT $6`,
          [command.gameId, command.eventKey, field.key, interval, includeTest, field.limit + 1],
        )).rows;
        fields.push({
          ...base,
          type: 'dimension',
          values: values.slice(0, field.limit).map(item => ({
            value: item.value,
            count: Number(item.count),
            uniqueActors: Number(item.unique_actors),
          })),
          truncated: values.length > field.limit,
        });
      }
      return { eventKey: command.eventKey, eventName: definition.name, days, fields };
    },

    async getLevelResultAnalysis(command: { gameId: string; eventKey: string; modeId: string; includeTest?: boolean }): Promise<{
      eventKey: string;
      modeId: string;
      modeName: string;
      suspectedStuckFailures: number;
      collectionStartedAt: string;
      levels: Array<{
        levelId: string;
        levelOrder: number;
        resultPlayers: number;
        successPlayers: number;
        successEvents: number;
        failedPlayers: number;
        failureEvents: number;
        unresolvedFailedPlayers: number;
        suspectedStuckPlayers: number;
        playerCompletionRate: number | null;
        resultFailureRatio: number | null;
        failuresPerResultPlayer: number | null;
      }>;
      highestResultDistribution: Array<{ levelOrder: number; players: number }>;
      highestSuccessDistribution: Array<{ levelOrder: number; players: number }>;
      currentSuspectedStuckDistribution: Array<{ levelOrder: number; players: number }>;
    }> {
      const definition = (await database.query<EventDefinition>(
        `SELECT * FROM game_event_definitions WHERE game_id=$1 AND event_key=$2`,
        [command.gameId, command.eventKey],
      )).rows[0];
      if (!definition || definition.analysis_type !== 'level_result') {
        throw httpError('关卡结果事件不存在', 404, 'LEVEL_RESULT_EVENT_NOT_FOUND');
      }
      const settings = settingsForDefinition(definition);
      const mode = settings.modes.find(item => item.id === command.modeId);
      if (!mode) throw httpError('玩法未在关卡结果事件中配置', 400, 'INVALID_MODE_ID');
      const threshold = settings.suspectedStuckFailures;
      const includeTest = command.includeTest === true;
      const levelRows = (await database.query<{
        level_id: string;
        level_order: string | number;
        result_players: string | number;
        success_players: string | number;
        success_events: string | number;
        failed_players: string | number;
        failure_events: string | number;
        unresolved_failed_players: string | number;
        suspected_stuck_players: string | number;
      }>(
        `WITH player_level AS (
           SELECT player_id,level_order,max(level_id) level_id,
                  count(*) FILTER(WHERE result='success') success_count,
                  count(*) FILTER(WHERE result='fail') fail_count
           FROM level_result_events
           WHERE game_id=$1 AND event_key=$2 AND mode_id=$3 AND occurred_at >= $5
             AND ($6::boolean OR NOT EXISTS(SELECT 1 FROM game_test_accounts test WHERE test.user_id=player_id))
           GROUP BY player_id,level_order
         )
         SELECT level_order,max(level_id) level_id,count(*) result_players,
                count(*) FILTER(WHERE success_count>0) success_players,
                sum(success_count) success_events,
                count(*) FILTER(WHERE fail_count>0) failed_players,
                sum(fail_count) failure_events,
                count(*) FILTER(WHERE fail_count>0 AND success_count=0) unresolved_failed_players,
                count(*) FILTER(WHERE fail_count>=$4 AND success_count=0) suspected_stuck_players
         FROM player_level GROUP BY level_order ORDER BY level_order`,
        [command.gameId, command.eventKey, command.modeId, threshold, settings.collectionStartedAt, includeTest],
      )).rows;
      const distributionRows = (await database.query<{
        kind: 'highest_result' | 'highest_success' | 'current_suspected_stuck';
        level_order: string | number;
        players: string | number;
      }>(
        `WITH player_level AS (
           SELECT player_id,level_order,
                  count(*) FILTER(WHERE result='success') success_count,
                  count(*) FILTER(WHERE result='fail') fail_count
           FROM level_result_events
           WHERE game_id=$1 AND event_key=$2 AND mode_id=$3 AND occurred_at >= $5
             AND ($6::boolean OR NOT EXISTS(SELECT 1 FROM game_test_accounts test WHERE test.user_id=player_id))
           GROUP BY player_id,level_order
         ), points AS (
           SELECT 'highest_result'::text kind,player_id,max(level_order) level_order
           FROM player_level GROUP BY player_id
           UNION ALL
           SELECT 'highest_success'::text kind,player_id,max(level_order) level_order
           FROM player_level WHERE success_count>0 GROUP BY player_id
           UNION ALL
           SELECT 'current_suspected_stuck'::text kind,player_id,max(level_order) level_order
           FROM player_level WHERE fail_count>=$4 AND success_count=0 GROUP BY player_id
         )
         SELECT kind,level_order,count(*) players FROM points
         GROUP BY kind,level_order ORDER BY kind,level_order`,
        [command.gameId, command.eventKey, command.modeId, threshold, settings.collectionStartedAt, includeTest],
      )).rows;
      const levels = levelRows.map(item => {
        const resultPlayers = Number(item.result_players);
        const successPlayers = Number(item.success_players);
        const successEvents = Number(item.success_events);
        const failureEvents = Number(item.failure_events);
        const resultEvents = successEvents + failureEvents;
        return {
          levelId: item.level_id,
          levelOrder: Number(item.level_order),
          resultPlayers,
          successPlayers,
          successEvents,
          failedPlayers: Number(item.failed_players),
          failureEvents,
          unresolvedFailedPlayers: Number(item.unresolved_failed_players),
          suspectedStuckPlayers: Number(item.suspected_stuck_players),
          playerCompletionRate: resultPlayers ? successPlayers / resultPlayers : null,
          resultFailureRatio: resultEvents ? failureEvents / resultEvents : null,
          failuresPerResultPlayer: resultPlayers ? failureEvents / resultPlayers : null,
        };
      });
      const distribution = (kind: typeof distributionRows[number]['kind']) => distributionRows
        .filter(item => item.kind === kind)
        .map(item => ({ levelOrder: Number(item.level_order), players: Number(item.players) }));
      return {
        eventKey: command.eventKey,
        modeId: command.modeId,
        modeName: mode.displayName,
        suspectedStuckFailures: threshold,
        collectionStartedAt: settings.collectionStartedAt,
        levels,
        highestResultDistribution: distribution('highest_result'),
        highestSuccessDistribution: distribution('highest_success'),
        currentSuspectedStuckDistribution: distribution('current_suspected_stuck'),
      };
    },
  };
}
