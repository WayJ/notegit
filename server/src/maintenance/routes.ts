import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rejectAuth, type RequestAuthenticator } from '../auth/lifecycle.ts';
import { recordAuditEvent } from '../audit/audit.ts';
import type { MaintenanceGate } from './gate.ts';

/**
 * 维护模式生命周期端点（S2-T7；backup-recovery §3 + coordinator 2026-10-13 批复）：
 *
 * - POST   /api/v1/admin/maintenance —— 开启；DELETE —— 关闭。
 * - 均需实例管理员（否则 403 E-AUTHZ-001；未认证 401 经统一缝 rejectAuth）。
 * - 幂等：已处于目标态返回 204 且不重复记审计（迁移发生才记）。
 * - 维护期间自身放行（运行态写入，backup §3 写分类）——闸门 allowlist 已覆盖。
 * - 切换记 maintenance.enable / maintenance.disable 审计行（storage-model §5：运行态
 *   写入，不入备份一致性集合）：主体 = 切换管理员 + 载体 + 入口（identity §8）。
 * - api.md 尚无此端点定义（§1 只定 E-MAINT-001 与放行规则）；形状经协调人批复，
 *   记录于 architecture-notes §8，api.md 补录留给下次契约修订（S3 会再动 api.md）。
 */

export interface MaintenanceRoutesOptions {
  readonly db: DatabaseSync;
  readonly gate: MaintenanceGate;
  readonly authenticateRequest: RequestAuthenticator;
  readonly now?: () => Date;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

export function registerMaintenanceRoutes(app: FastifyInstance, opts: MaintenanceRoutesOptions): void {
  const now = opts.now ?? (() => new Date());

  /** 实例管理员门槛：认证（统一缝）+ is_instance_admin（api.md §3.1 同款 403）。
   *  主体归因随 AuthSuccess 携带（载体 + 入口，architecture-notes §7.4）。 */
  async function requireInstanceAdmin(req: FastifyRequest, reply: FastifyReply) {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) {
      rejectAuth(reply, outcome);
      return null;
    }
    if (!outcome.subject.is_instance_admin) {
      sendError(reply, 403, 'E-AUTHZ-001', '需要实例管理员身份');
      return null;
    }
    return outcome;
  }

  /** 切换审计行（storage-model §5：maintenance.enable/disable 直接终态；运行态写入） */
  function auditToggle(
    outcome: NonNullable<Awaited<ReturnType<typeof requireInstanceAdmin>>>,
    eventKind: 'maintenance.enable' | 'maintenance.disable',
  ): void {
    recordAuditEvent(opts.db, {
      occurredAt: now().toISOString(),
      actorKind: 'employee',
      subject: {
        employeeId: outcome.subject.employee_id,
        carrierRef: outcome.carrierRef,
        entry: outcome.entry,
      },
      eventKind,
    });
  }

  app.post('/api/v1/admin/maintenance', async (req, reply) => {
    const outcome = await requireInstanceAdmin(req, reply);
    if (!outcome) return reply;
    if (opts.gate.enable()) auditToggle(outcome, 'maintenance.enable');  // 幂等：无迁移不记
    return reply.code(204).send();
  });

  app.delete('/api/v1/admin/maintenance', async (req, reply) => {
    const outcome = await requireInstanceAdmin(req, reply);
    if (!outcome) return reply;
    if (opts.gate.disable()) auditToggle(outcome, 'maintenance.disable');  // 维护期间可关闭
    return reply.code(204).send();
  });
}
