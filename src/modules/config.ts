import { Ajv, type AnySchema } from 'ajv';
import type { DatabaseClient } from '../db.js';
import { appendAudit, type AuditActor } from '../audit-log.js';

type Query = DatabaseClient['query'];

export type ConfigDatabase = {
  query: Query;
  transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T>;
};

type RevisionRow = {
  id: string;
  config_id: string;
  game_id: string;
  version: number;
  release_version: number | null;
  value: unknown;
  schema: unknown;
  status: 'draft' | 'published' | 'superseded';
  note: string;
};

export type Draft = RevisionRow;
export type PublishedConfig = Omit<RevisionRow, 'version' | 'release_version'> & {
  revision: number;
  version: number;
};

type ConfigRow = {
  id: string;
  game_id: string;
  config_key: string;
  environment: string;
  value: unknown;
  schema: unknown;
  version: number;
  description: string;
};

type AdminCommand = { adminId: string; ip?: string };

const actor = (command: AdminCommand): AuditActor => ({
  adminId: command.adminId,
  actorType: 'admin',
  actorId: command.adminId,
  ...(command.ip ? { ip: command.ip } : {}),
});

const ajv = new Ajv({ allErrors: true, strict: false });

function validateValue(schema: unknown, value: unknown): void {
  if (schema === null || schema === undefined) return;
  let validate;
  try {
    validate = ajv.compile(schema as AnySchema);
  } catch (error) {
    throw Object.assign(new Error(`Schema 无效：${error instanceof Error ? error.message : '无法编译'}`), { statusCode: 400 });
  }
  if (!validate(value)) {
    const detail = ajv.errorsText(validate.errors, { separator: '；' });
    throw Object.assign(new Error(`配置不符合 Schema：${detail}`), { statusCode: 422 });
  }
}

function asPublished(revision: RevisionRow): PublishedConfig {
  return {
    id: revision.id,
    config_id: revision.config_id,
    game_id: revision.game_id,
    revision: Number(revision.version),
    version: Number(revision.release_version),
    value: revision.value,
    schema: revision.schema,
    status: revision.status,
    note: revision.note,
  };
}

export function createConfigModule(database: ConfigDatabase) {
  return {
    async remove(command: AdminCommand & { configId: string }): Promise<void> {
      await database.transaction(async client => {
        const config = (await client.query<ConfigRow>('SELECT * FROM game_configs WHERE id=$1 FOR UPDATE', [command.configId])).rows[0];
        if (!config) throw Object.assign(new Error('配置不存在'), { statusCode: 404 });
        await appendAudit(client, {
          gameId: config.game_id,
          action: 'config.delete',
          resourceType: 'config',
          resourceId: config.id,
          before: config,
        }, actor(command));
        await client.query('DELETE FROM config_revisions WHERE config_id=$1', [command.configId]);
        await client.query('DELETE FROM game_configs WHERE id=$1', [command.configId]);
      });
    },

    async importMany(command: AdminCommand & {
      gameId: string;
      items: Array<{ configKey: string; environment: string; value: unknown; schema?: unknown; description?: string }>;
    }): Promise<{ imported: number }> {
      return database.transaction(async client => {
        let imported = 0;
        for (const item of command.items) {
          const existing = (await client.query<ConfigRow>(
            `SELECT * FROM game_configs WHERE game_id=$1 AND environment=$2 AND config_key=$3 FOR UPDATE`,
            [command.gameId, item.environment, item.configKey],
          )).rows[0];
          const schema = item.schema === undefined ? existing?.schema : item.schema;
          validateValue(schema, item.value);
          if (!existing) {
            const created = (await client.query<ConfigRow>(
              `INSERT INTO game_configs(game_id,config_key,environment,value,schema,description)
               VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
              [command.gameId, item.configKey, item.environment, item.value, schema ?? null, item.description || ''],
            )).rows[0]!;
            await client.query(
              `INSERT INTO config_revisions(config_id,game_id,version,release_version,value,schema,status,note,created_by,published_at)
               VALUES($1,$2,1,1,$3,$4,'published','批量导入',$5,now())`,
              [created.id, command.gameId, item.value, schema ?? null, command.adminId],
            );
          } else {
            const revisionNumber = Number((await client.query<{ version: number }>(
              'SELECT COALESCE(max(version),0)+1 version FROM config_revisions WHERE config_id=$1', [existing.id],
            )).rows[0]!.version);
            const releaseVersion = Number(existing.version) + 1;
            await client.query(`UPDATE config_revisions SET status='superseded' WHERE config_id=$1 AND status='published'`, [existing.id]);
            await client.query(
              `UPDATE game_configs SET value=$2,schema=$3,description=$4,version=$5,updated_at=now() WHERE id=$1`,
              [existing.id, item.value, schema ?? null, item.description || '', releaseVersion],
            );
            await client.query(
              `INSERT INTO config_revisions(config_id,game_id,version,release_version,value,schema,status,note,created_by,published_at)
               VALUES($1,$2,$3,$4,$5,$6,'published','批量导入',$7,now())`,
              [existing.id, command.gameId, revisionNumber, releaseVersion, item.value, schema ?? null, command.adminId],
            );
          }
          imported += 1;
        }
        await appendAudit(client, {
          gameId: command.gameId,
          action: 'config.batch.import',
          resourceType: 'game',
          resourceId: command.gameId,
          after: { imported },
        }, actor(command));
        return { imported };
      });
    },

    async create(command: AdminCommand & {
      gameId: string;
      configKey: string;
      environment: string;
      value: unknown;
      schema?: unknown;
      description?: string;
      note?: string;
    }): Promise<ConfigRow> {
      validateValue(command.schema, command.value);
      return database.transaction(async client => {
        const config = (await client.query<ConfigRow>(
          `INSERT INTO game_configs(game_id,config_key,environment,value,schema,description)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [command.gameId, command.configKey, command.environment, command.value, command.schema ?? null, command.description || ''],
        )).rows[0]!;
        await client.query(
          `INSERT INTO config_revisions(config_id,game_id,version,release_version,value,schema,status,note,created_by,published_at)
           VALUES($1,$2,1,1,$3,$4,'published',$5,$6,now())`,
          [config.id, command.gameId, command.value, command.schema ?? null, command.note || '首次发布', command.adminId],
        );
        await appendAudit(client, {
          gameId: command.gameId,
          action: 'config.create',
          resourceType: 'config',
          resourceId: config.id,
          after: config,
        }, actor(command));
        return config;
      });
    },

    async rollback(command: AdminCommand & { configId: string; targetVersion: number }): Promise<PublishedConfig> {
      return database.transaction(async client => {
        const config = (await client.query<{ game_id: string; value: unknown; version: number; schema: unknown }>(
          'SELECT game_id,value,version,schema FROM game_configs WHERE id=$1 FOR UPDATE', [command.configId],
        )).rows[0];
        const target = (await client.query<{ value: unknown; schema: unknown }>(
          'SELECT value,schema FROM config_revisions WHERE config_id=$1 AND release_version=$2',
          [command.configId, command.targetVersion],
        )).rows[0];
        if (!config || !target) throw Object.assign(new Error('配置或历史发布版本不存在'), { statusCode: 404 });
        validateValue(target.schema, target.value);
        const revisionNumber = Number((await client.query<{ version: number }>(
          'SELECT COALESCE(max(version),0)+1 version FROM config_revisions WHERE config_id=$1', [command.configId],
        )).rows[0]!.version);
        const releaseVersion = Number(config.version) + 1;
        await client.query(`UPDATE config_revisions SET status='superseded' WHERE config_id=$1 AND status='published'`, [command.configId]);
        const restored = (await client.query<RevisionRow>(
          `INSERT INTO config_revisions(config_id,game_id,version,release_version,value,schema,status,note,created_by,published_at)
           VALUES($1,$2,$3,$4,$5,$6,'published',$7,$8,now()) RETURNING *`,
          [command.configId, config.game_id, revisionNumber, releaseVersion, target.value, target.schema, `回滚自 v${command.targetVersion}`, command.adminId],
        )).rows[0]!;
        await client.query('UPDATE game_configs SET value=$2,schema=$3,version=$4,updated_at=now() WHERE id=$1', [command.configId, target.value, target.schema, releaseVersion]);
        await appendAudit(client, {
          gameId: config.game_id,
          action: 'config.rollback',
          resourceType: 'config',
          resourceId: command.configId,
          before: { value: config.value, version: config.version },
          after: { value: target.value, version: releaseVersion, restored_from: command.targetVersion },
        }, actor(command));
        return asPublished(restored);
      });
    },

    async setSchema(command: AdminCommand & { configId: string; schema: unknown }): Promise<{ schema: unknown }> {
      return database.transaction(async client => {
        const config = (await client.query<{ game_id: string; value: unknown; schema: unknown }>(
          'SELECT game_id,value,schema FROM game_configs WHERE id=$1 FOR UPDATE', [command.configId],
        )).rows[0];
        if (!config) throw Object.assign(new Error('配置不存在'), { statusCode: 404 });
        validateValue(command.schema, config.value);
        await client.query('UPDATE game_configs SET schema=$2,updated_at=now() WHERE id=$1', [command.configId, command.schema]);
        await client.query(`UPDATE config_revisions SET schema=$2 WHERE config_id=$1 AND status='published'`, [command.configId, command.schema]);
        await appendAudit(client, {
          gameId: config.game_id,
          action: 'config.schema.update',
          resourceType: 'config',
          resourceId: command.configId,
          before: { schema: config.schema },
          after: { schema: command.schema },
        }, actor(command));
        return { schema: command.schema };
      });
    },

    async publishValue(command: AdminCommand & { configId: string; value: unknown; schema?: unknown; note?: string; description?: string }): Promise<PublishedConfig> {
      return database.transaction(async client => {
        const config = (await client.query<{ game_id: string; value: unknown; version: number; schema: unknown }>(
          'SELECT game_id,value,version,schema FROM game_configs WHERE id=$1 FOR UPDATE', [command.configId],
        )).rows[0];
        if (!config) throw Object.assign(new Error('配置不存在'), { statusCode: 404 });
        const schema = command.schema === undefined ? config.schema : command.schema;
        validateValue(schema, command.value);
        const revisionNumber = Number((await client.query<{ version: number }>(
          'SELECT COALESCE(max(version),0)+1 version FROM config_revisions WHERE config_id=$1', [command.configId],
        )).rows[0]!.version);
        const releaseVersion = Number(config.version) + 1;
        await client.query(`UPDATE config_revisions SET status='superseded' WHERE config_id=$1 AND status='published'`, [command.configId]);
        const published = (await client.query<RevisionRow>(
          `INSERT INTO config_revisions(config_id,game_id,version,release_version,value,schema,status,note,created_by,published_at)
           VALUES($1,$2,$3,$4,$5,$6,'published',$7,$8,now()) RETURNING *`,
          [command.configId, config.game_id, revisionNumber, releaseVersion, command.value, schema ?? null, command.note || '直接发布', command.adminId],
        )).rows[0]!;
        await client.query(
          'UPDATE game_configs SET value=$2,version=$3,description=COALESCE($4,description),schema=$5,updated_at=now() WHERE id=$1',
          [command.configId, command.value, releaseVersion, command.description ?? null, schema ?? null],
        );
        await appendAudit(client, {
          gameId: config.game_id,
          action: 'config.publish',
          resourceType: 'config',
          resourceId: command.configId,
          before: { value: config.value, version: config.version },
          after: { value: command.value, version: releaseVersion },
        }, actor(command));
        return asPublished(published);
      });
    },

    async createDraft(command: AdminCommand & { configId: string; value: unknown; schema?: unknown; note?: string }): Promise<Draft> {
      return database.transaction(async client => {
        const config = (await client.query<{ game_id: string; value: unknown; schema: unknown }>(
          'SELECT game_id,value,schema FROM game_configs WHERE id=$1 FOR UPDATE', [command.configId],
        )).rows[0];
        if (!config) throw Object.assign(new Error('配置不存在'), { statusCode: 404 });
        const schema = command.schema === undefined ? config.schema : command.schema;
        const value = command.value === undefined ? config.value : command.value;
        validateValue(schema, value);
        const revision = (await client.query<RevisionRow>(
          `INSERT INTO config_revisions(config_id,game_id,version,value,schema,status,note,created_by)
           SELECT $1,$2,COALESCE(max(version),0)+1,$3,$4,'draft',$5,$6
           FROM config_revisions WHERE config_id=$1 RETURNING *`,
          [command.configId, config.game_id, value, schema ?? null, command.note || '', command.adminId],
        )).rows[0]!;
        await appendAudit(client, {
          gameId: config.game_id,
          action: 'config.draft.create',
          resourceType: 'config_revision',
          resourceId: revision.id,
          after: revision,
        }, actor(command));
        return revision;
      });
    },

    async publishDraft(command: AdminCommand & { configId: string; revisionId: string }): Promise<PublishedConfig> {
      return database.transaction(async client => {
        const config = (await client.query<{ game_id: string; version: number }>(
          'SELECT game_id,version FROM game_configs WHERE id=$1 FOR UPDATE', [command.configId],
        )).rows[0];
        if (!config) throw Object.assign(new Error('配置不存在'), { statusCode: 404 });
        const revision = (await client.query<RevisionRow>(
          `SELECT * FROM config_revisions WHERE id=$1 AND config_id=$2 AND status='draft' FOR UPDATE`,
          [command.revisionId, command.configId],
        )).rows[0];
        if (!revision) throw Object.assign(new Error('草稿不存在'), { statusCode: 404 });

        validateValue(revision.schema, revision.value);

        const nextVersion = Number(config.version) + 1;
        await client.query(`UPDATE config_revisions SET status='superseded' WHERE config_id=$1 AND status='published'`, [command.configId]);
        const published = (await client.query<RevisionRow>(
          `UPDATE config_revisions SET status='published',release_version=$2,published_at=now() WHERE id=$1 RETURNING *`,
          [command.revisionId, nextVersion],
        )).rows[0]!;
        await client.query(`UPDATE game_configs SET value=$2,schema=$3,version=$4,updated_at=now() WHERE id=$1`, [command.configId, revision.value, revision.schema, nextVersion]);
        await appendAudit(client, {
          gameId: config.game_id,
          action: 'config.draft.publish',
          resourceType: 'config_revision',
          resourceId: command.revisionId,
          after: { ...published, version: nextVersion },
        }, actor(command));
        return asPublished(published);
      });
    },
  };
}
