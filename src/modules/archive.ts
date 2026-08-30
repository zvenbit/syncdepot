import crypto from 'node:crypto';
import type { DatabaseClient } from '../db.js';
import { appendAudit, type AuditActor } from '../audit-log.js';

export type ArchiveDatabase = {
  query: DatabaseClient['query'];
  transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T>;
};

export type ArchiveRecord<T = unknown> = {
  id: string;
  game_id: string;
  user_id: string;
  slot: string;
  data: T;
  version: number;
  updated_at: string;
};

export type SaveArchiveCommand<T = unknown> = {
  gameId: string;
  userId: string;
  slot: string;
  data: T;
  version?: number;
  idempotencyKey?: string;
  actor: AuditActor;
};

export type SaveArchiveResult<T = unknown> = {
  kind: 'saved' | 'replayed';
  archive: ArchiveRecord<T>;
};

type IdempotencyRow = {
  request_hash: string;
  response: ArchiveRecord | null;
  status: 'pending' | 'completed';
};

const fail = (statusCode: number, message: string, current?: ArchiveRecord) =>
  Object.assign(new Error(message), { statusCode, ...(current ? { current } : {}) });

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const ARCHIVE_CODEC_KEY = '__syncdepot_archive_codec_v1__';
const ARCHIVE_CODEC_VALUE = 'json-utf8-base64';

type StoredArchiveEnvelope = {
  [ARCHIVE_CODEC_KEY]: typeof ARCHIVE_CODEC_VALUE;
  payload: string;
};

/**
 * Archive payloads are opaque to the service. Encoding the complete JSON value
 * keeps binary strings produced by pako (including NUL bytes) out of JSONB while
 * preserving the exact value returned to clients.
 */
export function encodeArchiveData(value: unknown): StoredArchiveEnvelope {
  const json = JSON.stringify(value) ?? 'null';
  return {
    [ARCHIVE_CODEC_KEY]: ARCHIVE_CODEC_VALUE,
    payload: Buffer.from(json, 'utf8').toString('base64'),
  };
}

export function decodeArchiveData<T = unknown>(value: unknown): T {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (value as Record<string, unknown>)[ARCHIVE_CODEC_KEY] !== ARCHIVE_CODEC_VALUE
    || typeof (value as Record<string, unknown>).payload !== 'string'
  ) return value as T;
  return JSON.parse(Buffer.from((value as StoredArchiveEnvelope).payload, 'base64').toString('utf8')) as T;
}

export function decodeArchiveRecord<T extends { data: unknown }>(record: T): T {
  return { ...record, data: decodeArchiveData(record.data) };
}

const storedJsonParameter = (value: unknown): string => JSON.stringify(value) ?? 'null';
const archiveJsonParameter = (value: unknown): string => storedJsonParameter(encodeArchiveData(value));

export function createArchiveSyncModule(database: ArchiveDatabase, options: { maxBytes: number }) {
  const assertSize = (data: unknown) => {
    if (Buffer.byteLength(stableJson(data), 'utf8') > options.maxBytes) throw fail(413, `存档不能超过 ${options.maxBytes} 字节`);
  };
  return {
    async update(command: { archiveId: string; data: unknown; version: number; actor: AuditActor }): Promise<ArchiveRecord> {
      assertSize(command.data);
      return database.transaction(async client => {
        const beforeStored = (await client.query<ArchiveRecord>('SELECT * FROM user_archives WHERE id=$1 FOR UPDATE', [command.archiveId])).rows[0];
        if (!beforeStored) throw fail(404, '存档不存在');
        const before = decodeArchiveRecord(beforeStored);
        const updatedStored = (await client.query<ArchiveRecord>(
          'UPDATE user_archives SET data=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *',
          [command.archiveId, archiveJsonParameter(command.data), command.version],
        )).rows[0];
        if (!updatedStored) throw fail(409, '存档已被更新，请刷新后重试', before);
        await client.query(
          `INSERT INTO archive_revisions(archive_id,game_id,user_id,slot,version,data,reason)
           VALUES($1,$2,$3,$4,$5,$6,'admin_edit')`,
          [
            updatedStored.id,
            updatedStored.game_id,
            updatedStored.user_id,
            updatedStored.slot,
            updatedStored.version,
            storedJsonParameter(updatedStored.data),
          ],
        );
        await appendAudit(client, {
          gameId: updatedStored.game_id,
          action: 'archive.update',
          resourceType: 'archive',
          resourceId: updatedStored.id,
          before: beforeStored,
          after: updatedStored,
        }, command.actor);
        return decodeArchiveRecord(updatedStored);
      });
    },

    async restore(command: { archiveId: string; targetVersion: number; actor: AuditActor }): Promise<ArchiveRecord> {
      return database.transaction(async client => {
        const currentStored = (await client.query<ArchiveRecord>('SELECT * FROM user_archives WHERE id=$1 FOR UPDATE', [command.archiveId])).rows[0];
        const targetStored = (await client.query<{ data: unknown }>(
          'SELECT data FROM archive_revisions WHERE archive_id=$1 AND version=$2', [command.archiveId, command.targetVersion],
        )).rows[0];
        if (!currentStored || !targetStored) throw fail(404, '存档或历史版本不存在');
        const targetData = decodeArchiveData(targetStored.data);
        assertSize(targetData);
        const restoredStored = (await client.query<ArchiveRecord>(
          'UPDATE user_archives SET data=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [command.archiveId, archiveJsonParameter(targetData)],
        )).rows[0]!;
        await client.query(
          `INSERT INTO archive_revisions(archive_id,game_id,user_id,slot,version,data,reason)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            restoredStored.id,
            restoredStored.game_id,
            restoredStored.user_id,
            restoredStored.slot,
            restoredStored.version,
            storedJsonParameter(restoredStored.data),
            `restore_v${command.targetVersion}`,
          ],
        );
        await appendAudit(client, {
          gameId: restoredStored.game_id,
          action: 'archive.restore',
          resourceType: 'archive',
          resourceId: restoredStored.id,
          before: currentStored,
          after: restoredStored,
        }, command.actor);
        return decodeArchiveRecord(restoredStored);
      });
    },

    async remove(command: { archiveId: string; actor: AuditActor }): Promise<void> {
      await database.transaction(async client => {
        const before = (await client.query<ArchiveRecord>('SELECT * FROM user_archives WHERE id=$1 FOR UPDATE', [command.archiveId])).rows[0];
        if (!before) throw fail(404, '存档不存在');
        await appendAudit(client, {
          gameId: before.game_id, action: 'archive.delete', resourceType: 'archive', resourceId: before.id, before,
        }, command.actor);
        await client.query('DELETE FROM user_archives WHERE id=$1', [command.archiveId]);
      });
    },

    async save<T>(command: SaveArchiveCommand<T>): Promise<SaveArchiveResult<T>> {
      const encoded = stableJson(command.data);
      if (Buffer.byteLength(encoded, 'utf8') > options.maxBytes) throw fail(413, `存档不能超过 ${options.maxBytes} 字节`);
      if (command.idempotencyKey !== undefined && (!command.idempotencyKey || command.idempotencyKey.length > 128)) {
        throw fail(400, 'Idempotency-Key 必须是 1-128 位字符串');
      }
      const requestHash = crypto.createHash('sha256').update(stableJson({
        userId: command.userId,
        slot: command.slot,
        data: command.data,
        version: command.version ?? null,
      })).digest('hex');

      return database.transaction(async client => {
        if (command.idempotencyKey) {
          await client.query(
            'DELETE FROM idempotency_records WHERE game_id=$1 AND idempotency_key=$2 AND expires_at<now()',
            [command.gameId, command.idempotencyKey],
          );
          const reserved = await client.query(
            `INSERT INTO idempotency_records(game_id,idempotency_key,request_hash,response,status)
             VALUES($1,$2,$3,NULL,'pending') ON CONFLICT(game_id,idempotency_key) DO NOTHING RETURNING idempotency_key`,
            [command.gameId, command.idempotencyKey, requestHash],
          );
          if (!reserved.rowCount) {
            const existing = (await client.query<IdempotencyRow>(
              `SELECT request_hash,response,status FROM idempotency_records
               WHERE game_id=$1 AND idempotency_key=$2 FOR UPDATE`,
              [command.gameId, command.idempotencyKey],
            )).rows[0];
            if (!existing) throw fail(409, '幂等请求状态不存在，请重试');
            if (existing.request_hash !== requestHash) throw fail(409, '同一 Idempotency-Key 不能用于不同请求');
            if (existing.status !== 'completed' || !existing.response) throw fail(409, '相同请求正在处理中，请稍后重试');
            return { kind: 'replayed', archive: decodeArchiveRecord(existing.response as ArchiveRecord<T>) };
          }
        }

        const currentStored = (await client.query<ArchiveRecord>(
          'SELECT * FROM user_archives WHERE game_id=$1 AND user_id=$2 AND slot=$3 FOR UPDATE',
          [command.gameId, command.userId, command.slot],
        )).rows[0];
        const current = currentStored ? decodeArchiveRecord(currentStored) : undefined;
        let savedStored: ArchiveRecord;
        if (currentStored) {
          if (!Number.isInteger(command.version)) throw fail(409, '更新已有存档时必须传当前 version', current);
          savedStored = (await client.query<ArchiveRecord>(
            `UPDATE user_archives SET data=$4,version=version+1,updated_at=now()
             WHERE game_id=$1 AND user_id=$2 AND slot=$3 AND version=$5 RETURNING *`,
            [command.gameId, command.userId, command.slot, archiveJsonParameter(command.data), command.version],
          )).rows[0]!;
          if (!savedStored) throw fail(409, '存档版本冲突', current);
        } else {
          savedStored = (await client.query<ArchiveRecord>(
            `INSERT INTO user_archives(game_id,user_id,slot,data)
             SELECT $1,id,$3,$4::jsonb FROM game_users WHERE id=$2 AND game_id=$1 RETURNING *`,
            [command.gameId, command.userId, command.slot, archiveJsonParameter(command.data)],
          )).rows[0]!;
          if (!savedStored) throw fail(404, '用户不存在');
        }
        const saved = decodeArchiveRecord(savedStored) as ArchiveRecord<T>;

        await client.query(
          `INSERT INTO archive_revisions(archive_id,game_id,user_id,slot,version,data,reason)
           VALUES($1,$2,$3,$4,$5,$6,'save') ON CONFLICT(archive_id,version) DO NOTHING`,
          [
            savedStored.id,
            savedStored.game_id,
            savedStored.user_id,
            savedStored.slot,
            savedStored.version,
            storedJsonParameter(savedStored.data),
          ],
        );
        if (command.idempotencyKey) {
          await client.query(
            `UPDATE idempotency_records SET response=$3::jsonb,status='completed',expires_at=now()+interval '24 hours'
             WHERE game_id=$1 AND idempotency_key=$2`,
            [command.gameId, command.idempotencyKey, storedJsonParameter(savedStored)],
          );
        }
        await appendAudit(client, {
          gameId: command.gameId,
          action: 'archive.save',
          resourceType: 'archive',
          resourceId: saved.id,
          after: { user_id: command.userId, slot: command.slot, version: saved.version },
        }, command.actor);
        return { kind: 'saved', archive: saved };
      });
    },
  };
}
