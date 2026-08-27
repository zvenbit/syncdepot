import type { DatabaseClient } from '../db.js';

type Query = DatabaseClient['query'];

export type AnalyticsDatabase = {
  query: Query;
  transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T>;
};

export type EventDefinition = {
  id: string;
  game_id: string;
  event_key: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

export type AnalyticsEvent = {
  eventKey: string;
  userId?: string;
  sessionId?: string;
  properties?: unknown;
  occurredAt?: string | Date;
  idempotencyKey?: string;
};

const EVENT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,95}$/;
const MAX_BATCH_SIZE = 100;
const MAX_PROPERTIES_BYTES = 16 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function validateEventKey(eventKey: string): void {
  if (!EVENT_KEY_PATTERN.test(eventKey)) {
    throw httpError('event_key 只能使用小写字母、数字和下划线，且必须以字母开头', 400);
  }
}

function eventTime(value?: string | Date): Date {
  const occurredAt = value ? new Date(value) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw httpError('occurred_at 不是有效时间', 400);
  const offset = occurredAt.getTime() - Date.now();
  if (offset > MAX_FUTURE_SKEW_MS || offset < -MAX_EVENT_AGE_MS) {
    throw httpError('occurred_at 必须在过去 90 天至未来 5 分钟内', 422);
  }
  return occurredAt;
}

export function createAnalyticsModule(database: AnalyticsDatabase) {
  return {
    async defineEvent(command: {
      gameId: string;
      eventKey: string;
      name: string;
      category?: string;
      description?: string;
    }): Promise<EventDefinition> {
      validateEventKey(command.eventKey);
      if (!command.name?.trim()) throw httpError('事件名称不能为空', 400);
      try {
        return (await database.query<EventDefinition>(
          `INSERT INTO game_event_definitions(game_id,event_key,name,category,description)
           VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [command.gameId, command.eventKey, command.name.trim(), command.category?.trim() || 'custom', command.description?.trim() || ''],
        )).rows[0]!;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw httpError('该 event_key 已存在', 409);
        throw error;
      }
    },

    async listDefinitions(gameId: string): Promise<EventDefinition[]> {
      return (await database.query<EventDefinition>(
        `SELECT * FROM game_event_definitions WHERE game_id=$1 ORDER BY category,event_key`,
        [gameId],
      )).rows;
    },

    async updateDefinition(command: {
      definitionId: string;
      name?: string;
      category?: string;
      description?: string;
      enabled?: boolean;
    }): Promise<EventDefinition> {
      if (command.name !== undefined && !command.name.trim()) throw httpError('事件名称不能为空', 400);
      const result = await database.query<EventDefinition>(
        `UPDATE game_event_definitions SET
           name=COALESCE($2,name),
           category=COALESCE($3,category),
           description=COALESCE($4,description),
           enabled=COALESCE($5,enabled),
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [
          command.definitionId,
          command.name?.trim() ?? null,
          command.category?.trim() || (command.category === undefined ? null : 'custom'),
          command.description?.trim() ?? null,
          command.enabled ?? null,
        ],
      );
      if (!result.rowCount) throw httpError('事件定义不存在', 404);
      return result.rows[0]!;
    },

    async removeDefinition(definitionId: string): Promise<EventDefinition> {
      return database.transaction(async client => {
        const definition = (await client.query<EventDefinition>(
          `SELECT * FROM game_event_definitions WHERE id=$1 FOR UPDATE`,
          [definitionId],
        )).rows[0];
        if (!definition) throw httpError('事件定义不存在', 404);
        const history = (await client.query<{ count: string | number }>(
          `SELECT count(*) count FROM game_events WHERE game_id=$1 AND event_key=$2`,
          [definition.game_id, definition.event_key],
        )).rows[0]!;
        if (Number(history.count) > 0) throw httpError('事件已有历史数据，不能删除；可以将其停用', 409);
        await client.query(`DELETE FROM game_event_definitions WHERE id=$1`, [definitionId]);
        return definition;
      });
    },

    async recordEvents(command: { gameId: string; events: AnalyticsEvent[] }): Promise<{ accepted: number; duplicated: number }> {
      if (!Array.isArray(command.events) || command.events.length === 0 || command.events.length > MAX_BATCH_SIZE) {
        throw httpError(`events 数量必须在 1-${MAX_BATCH_SIZE} 之间`, 400);
      }
      const prepared = command.events.map(event => {
        validateEventKey(event.eventKey);
        if (!event.userId && !event.sessionId?.trim()) throw httpError('每条事件必须提供 userId 或 sessionId', 400);
        const properties = event.properties ?? {};
        if (Buffer.byteLength(JSON.stringify(properties), 'utf8') > MAX_PROPERTIES_BYTES) {
          throw httpError(`单条事件 properties 不能超过 ${MAX_PROPERTIES_BYTES / 1024}KB`, 413);
        }
        return {
          ...event,
          sessionId: event.sessionId?.trim() || null,
          occurredAt: eventTime(event.occurredAt),
          properties,
          idempotencyKey: event.idempotencyKey?.trim() || null,
        };
      });

      return database.transaction(async client => {
        const keys = [...new Set(prepared.map(event => event.eventKey))];
        const userIds = [...new Set(prepared.flatMap(event => event.userId ? [event.userId] : []))];
        if (userIds.length) {
          const users = (await client.query<{ id: string }>(
            `SELECT id FROM game_users WHERE game_id=$1 AND id::text=ANY($2::text[])`,
            [command.gameId, userIds],
          )).rows;
          if (users.length !== userIds.length) throw httpError('玩家不属于当前项目', 422);
        }
        const definitions = (await client.query<{ event_key: string }>(
          `SELECT event_key FROM game_event_definitions WHERE game_id=$1 AND enabled=true AND event_key=ANY($2::text[]) FOR SHARE`,
          [command.gameId, keys],
        )).rows;
        const enabled = new Set(definitions.map(item => item.event_key));
        const invalid = keys.filter(key => !enabled.has(key));
        if (invalid.length) throw httpError(`事件未定义或已停用：${invalid.join(', ')}`, 422);

        let accepted = 0;
        let duplicated = 0;
        for (const event of prepared) {
          const result = await client.query(
            `INSERT INTO game_events(game_id,event_key,user_id,session_id,properties,occurred_at,idempotency_key)
             VALUES($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT(game_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
            [command.gameId, event.eventKey, event.userId ?? null, event.sessionId, event.properties, event.occurredAt, event.idempotencyKey],
          );
          if (result.rowCount === 1) accepted += 1;
          else duplicated += 1;
        }
        return { accepted, duplicated };
      });
    },

    async getSummary(command: { gameId: string; days?: number }): Promise<{
      days: number;
      totalEvents: number;
      todayEvents: number;
      uniqueActors: number;
      byEvent: Array<{ eventKey: string; name: string; category: string; enabled: boolean; count: number; uniqueActors: number }>;
      daily: Array<{ date: string; count: number }>;
    }> {
      const days = Math.min(90, Math.max(1, Math.trunc(command.days ?? 7)));
      const interval = `${days - 1} days`;
      const totals = (await database.query<{ total_events: string | number; today_events: string | number; unique_actors: string | number }>(
        `SELECT count(*) total_events,
                count(*) FILTER(WHERE occurred_at >= date_trunc('day',now())) today_events,
                count(DISTINCT COALESCE(user_id::text,session_id)) unique_actors
         FROM game_events WHERE game_id=$1 AND occurred_at >= date_trunc('day',now())-$2::interval`,
        [command.gameId, interval],
      )).rows[0]!;
      const byEvent = (await database.query<{
        event_key: string; name: string; category: string; enabled: boolean; count: string | number; unique_actors: string | number;
      }>(
        `SELECT d.event_key,d.name,d.category,d.enabled,count(e.id) count,
                count(DISTINCT COALESCE(e.user_id::text,e.session_id)) unique_actors
         FROM game_event_definitions d
         LEFT JOIN game_events e ON e.game_id=d.game_id AND e.event_key=d.event_key
           AND e.occurred_at >= date_trunc('day',now())-$2::interval
         WHERE d.game_id=$1
         GROUP BY d.event_key,d.name,d.category,d.enabled ORDER BY d.event_key`,
        [command.gameId, interval],
      )).rows;
      const daily = (await database.query<{ date: string | Date; count: string | number }>(
        `SELECT day::date date,count(e.id) count
         FROM generate_series(date_trunc('day',now())-$2::interval,date_trunc('day',now()),interval '1 day') day
         LEFT JOIN game_events e ON e.game_id=$1 AND e.occurred_at >= day AND e.occurred_at < day+interval '1 day'
         GROUP BY day ORDER BY day`,
        [command.gameId, interval],
      )).rows;
      return {
        days,
        totalEvents: Number(totals.total_events),
        todayEvents: Number(totals.today_events),
        uniqueActors: Number(totals.unique_actors),
        byEvent: byEvent.map(item => ({
          eventKey: item.event_key,
          name: item.name,
          category: item.category,
          enabled: item.enabled,
          count: Number(item.count),
          uniqueActors: Number(item.unique_actors),
        })),
        daily: daily.map(item => ({ date: new Date(item.date).toISOString().slice(0, 10), count: Number(item.count) })),
      };
    },
  };
}
