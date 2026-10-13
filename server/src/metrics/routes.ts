import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { rejectAuth, type RequestAuthenticator } from '../auth/lifecycle.ts';
import { metricsCollector } from './collector.ts';
import { evaluateWatermark, scanDiskUsage } from './disk.ts';

/**
 * 运维指标面（S8-T2；R14 方法——运维页/API 可查，形态在此定稿为 API 独立面）：
 *
 * - **GET /api/v1/admin/metrics**（实例管理员；只读）：架构 §10 最低清单——
 *   磁盘水位（/data 四分域用量 + statfs 容量比值水位）、失败推送计数、校验
 *   耗时分布（P50/P95 累计）、认证失败计数（identity §8「不逐条入审计」的
 *   替代呈现）、备份完成时间（S8-T4 接线：最新 backup.completed 审计行，
 *   尚无备份如实 null）。
 * - **失败类持久指标以审计行为唯一计数来源**（storage-model §5/§6 终态语义；
 *   不另立账本——重启不丢、与恢复对账同源）：pushes.failed/unresolved 取
 *   vault.push 终态行；web_submits.failed 取 vault.web_submit；validation.failed
 *   取 detail.reason='validation' 的拒绝行（两 kind 通吃）。
 * - **进程内运行态指标**（重启归零，如实呈现）：认证失败计数与校验耗时样本
 *   来自 metricsCollector（挂接点见 collector.ts 文档注释）。
 * - 磁盘面：dataDir 接线形态逐请求实时扫描（分域递归求和 + statfs）；无
 *   dataDir（S2 测试形态）→ {wired: false} 如是报告（search-index running:false
 *   同款诚实形态）。
 * - 只读端点：无审计行、GET 免 CSRF、维护模式读放行（gate SAFE_METHODS）。
 * - 选型记录（独立面而非 healthz 扩展）：/healthz 是容器基础设施探针（T1
 *   HEALTHCHECK 消费面），无认证、轻量、不耦合管理数据——运维指标需实例
 *   管理员门槛，故独立成面；建议稿 docs/s1/metrics-face-amendments.md（api.md
 *   未入册——D11 模式，master 随 D 批裁决归位）。
 */

export interface MetricsRoutesOptions {
  /** 审计面（失败类指标的计数来源——只读查询） */
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
  /** 数据目录（接线形态：磁盘分域扫描）；缺省（无 dataDir 测试形态）→ disk.wired=false */
  readonly dataDir?: string;
}

function countOf(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number | bigint }).n);
}

/** 磁盘呈现面（接线形态）：实时扫描 + 水位判定 */
async function diskFace(dataDir: string) {
  const usage = await scanDiskUsage(dataDir);
  const watermark = evaluateWatermark(usage);
  return {
    wired: true,
    data_dir: dataDir,
    capacity_bytes: usage.capacityBytes,
    free_bytes: usage.freeBytes,
    domains: usage.domains.map((d) => ({ name: d.name, used_bytes: d.usedBytes })),
    watermark: {
      used_ratio: watermark.used_ratio,
      level: watermark.level,
      alert: watermark.alert,
      warn_ratio: watermark.warn_ratio,
      critical_ratio: watermark.critical_ratio,
    },
  };
}

/** 审计面计数（单一 SELECT 语义集中于此；json_extract 取拒绝原因） */
function auditCounters(db: DatabaseSync) {
  return {
    pushes: {
      failed: countOf(db, `SELECT COUNT(*) AS n FROM audit_events WHERE event_kind = 'vault.push' AND status = 'rejected'`),
      unresolved: countOf(db, `SELECT COUNT(*) AS n FROM audit_events WHERE event_kind = 'vault.push' AND status = 'unresolved'`),
    },
    web_submits: {
      failed: countOf(db, `SELECT COUNT(*) AS n FROM audit_events WHERE event_kind = 'vault.web_submit' AND status = 'rejected'`),
    },
    validation: {
      failed: countOf(
        db,
        `SELECT COUNT(*) AS n FROM audit_events
         WHERE event_kind IN ('vault.push','vault.web_submit') AND status = 'rejected'
           AND json_extract(detail, '$.reason') = 'validation'`,
      ),
    },
  };
}

export function registerMetricsRoutes(app: FastifyInstance, opts: MetricsRoutesOptions): void {
  app.get('/api/v1/admin/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) {
      rejectAuth(reply, outcome);
      return;
    }
    if (!outcome.subject.is_instance_admin) {
      reply.code(403).send({ error: { code: 'E-AUTHZ-001', message: '需要实例管理员身份' } });
      return;
    }

    const counters = auditCounters(opts.db);
    const auth = metricsCollector.authFailureSnapshot();
    const timing = metricsCollector.validationTimingSnapshot();
    const disk = opts.dataDir === undefined ? { wired: false } : await diskFace(opts.dataDir);
    // S8-T4 接线（C2 定稿）：备份完成时间以审计行为唯一来源（与失败计数同一选型——
    // 不另立账本），呈现最新 backup.completed 成功行的 occurred_at（backup §4 步骤 7）。
    const lastBackup = opts.db
      .prepare(
        `SELECT occurred_at FROM audit_events
         WHERE event_kind = 'backup.completed' AND status = 'succeeded'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { occurred_at: string } | undefined;

    reply.send({
      disk,
      pushes: counters.pushes,
      web_submits: counters.web_submits,
      validation: { failed: counters.validation.failed, timing },
      auth_failures: {
        total: auth.total,
        by_entry: auth.by_entry,
        last_at: auth.last_at,
      },
      backup: {
        // S8-T4 已接线：完成时间 = 最新 backup.completed 审计行（尚无备份 → 如实 null）
        wired: true,
        last_completed_at: lastBackup?.occurred_at ?? null,
      },
    });
  });
}
