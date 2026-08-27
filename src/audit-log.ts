import type { DatabaseClient } from './db.js';

export type AuditActor = {
  adminId?: string;
  actorType: 'admin' | 'game' | 'user' | 'system';
  actorId?: string;
  ip?: string;
};

export type AuditEvent = {
  action: string;
  resourceType: string;
  resourceId?: string;
  gameId?: string;
  before?: unknown;
  after?: unknown;
};

export async function appendAudit(client: DatabaseClient, event: AuditEvent, actor: AuditActor): Promise<void> {
  await client.query(`INSERT INTO audit_logs(game_id,admin_id,actor_type,actor_id,action,resource_type,resource_id,before_data,after_data,ip)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
    event.gameId || null,
    actor.adminId || null,
    actor.actorType,
    actor.actorId || null,
    event.action,
    event.resourceType,
    event.resourceId || null,
    event.before === undefined ? null : event.before,
    event.after === undefined ? null : event.after,
    actor.ip || null,
  ]);
}
