import type { FastifyRequest } from 'fastify';
import { query, type DatabaseClient } from './db.js';
import { appendAudit } from './audit-log.js';
export type { AuditActor, AuditEvent } from './audit-log.js';

type AuditInput = {
  request: FastifyRequest;
  action: string;
  resourceType: string;
  resourceId?: string;
  gameId?: string;
  before?: unknown;
  after?: unknown;
  actorType?: 'admin' | 'game' | 'user' | 'system';
};

export async function writeAudit(input: AuditInput, client: DatabaseClient = { query, release() {} }): Promise<void> {
  const actorType = input.actorType || (input.request.admin ? 'admin' : input.request.userAccess ? 'user' : 'game');
  const actorId = input.request.admin?.sub || input.request.userAccess?.sub || input.request.game?.key_id || null;
  const gameId = input.gameId || input.request.game?.id;
  await appendAudit(client, {
    action: input.action,
    resourceType: input.resourceType,
    ...(gameId ? { gameId } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
  }, {
    actorType,
    ip: input.request.ip,
    ...(input.request.admin?.sub ? { adminId: input.request.admin.sub } : {}),
    ...(actorId ? { actorId } : {}),
  });
}
