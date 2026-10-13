import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * 维护模式闸门（S2-T7；backup-recovery §3 唯一语义源）：
 *
 * - 实例级全局写闸门：开启后拒绝一切改变权威数据的写入；读路径与登录保持可用。
 * - 进程内同步标志（单实例单进程，架构 §9/D10）：切换调用返回后对所有后续请求
 *   立即生效，传播上界为 0（backup §3 生效机制；S2-T1 已确认容器内单应用进程）。
 * - 范围栅栏（backup §3）：本模块的进程内布尔标志只针对维护模式这一个闸门，
 *   不得援引为任何权限/凭据检查缓存的先例（认证/授权无缓存约束以 identity §5.1 为准，
 *   no-permission-cache.test.ts 的扫描范围不含本目录即此意）。
 */

/** 运行态写入放行清单（backup §3 写分类）：登录会话与维护生命周期自身。
 *  其余 /api/v1 非安全方法一律拒绝（api.md 标注「写」的端点全集 + 未来端点自动覆盖）。 */
const RUNTIME_WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
  '/api/v1/auth/login', // 矩阵第 6 行：会话是临时运行态，不属一致性集合（D-BR-06）
  '/api/v1/auth/logout', // 会话运行态写入（删会话行）：同上，登录会话域的运行态
  '/api/v1/admin/maintenance', // 维护模式自身的生命周期事件（开启/关闭），运行态写入
  '/api/v1/admin/search-index/rebuild', // S5-T5：派生索引全量重建——派生数据不入备份
  // 一致性集合（storage-model §2/backup §3 写分类），且 backup §7 步骤 9 的恢复
  // 流程在维护模式内触发；闸门目的是拦权威数据写入，对派生面不适用
]);

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface MaintenanceGate {
  isEnabled(): boolean;
  /** @returns 是否发生状态迁移（false = 已处于目标态，幂等无迁移） */
  enable(): boolean;
  /** @returns 是否发生状态迁移 */
  disable(): boolean;
}

/**
 * 恢复流程的启动初态（backup §7 步骤 1「部署容器（保持维护模式启动）」，S8-T5）：
 * `NOTEGIT_MAINTENANCE_ON_START=1` → 闸门以开启态创建——全新环境恢复在装载产物后、
 * §8 清单全绿前不得接收业务写。env 只设**初态**：生命周期端点语义不变（POST/DELETE
 * 仍可切换；POST 对已开闸门为幂等无迁移、不记审计行）。缺省不设/非 '1' 与 S2-T7
 * 行为完全一致（普通部署不触发）。
 */
export const MAINTENANCE_ON_START_ENV = 'NOTEGIT_MAINTENANCE_ON_START';

/** 进程内同步标志（每应用实例一个；生产单实例单进程） */
export function createMaintenanceGate(): MaintenanceGate {
  let enabled = process.env[MAINTENANCE_ON_START_ENV] === '1';
  return {
    isEnabled: () => enabled,
    enable: () => {
      if (enabled) return false;
      enabled = true;
      return true;
    },
    disable: () => {
      if (!enabled) return false;
      enabled = false;
      return true;
    },
  };
}

/**
 * 全局写闸门 onRequest 钩子（api.md §10 组装序第一位：maintenance → init gate →
 * csrf → 路由）：挂在路由解析之前，故 api.md 标注「写」的未来端点（vaults/成员/
 * 草稿/提交）无需各自挂接即被覆盖。Git receive-pack 的 403「维护中」属 S3 的
 * /git 入口（api.md §8.4），不在本钩点范围。
 */
export function maintenanceGuard(gate: MaintenanceGate) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!gate.isEnabled()) return;
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/v1')) return; // /healthz 与（未来的）/git/* 不在此层
    if (SAFE_METHODS.has(req.method)) return; // 一切读放行（矩阵第 7 行）
    if (RUNTIME_WRITE_ALLOWLIST.has(path)) return; // 运行态写入放行（backup §3 写分类）
    // 503 + 结构化错误（api.md §2.3 E-MAINT-001：maintenance: true；无 Retry-After——仅 429 使用）
    await reply.code(503).send({
      error: {
        code: 'E-MAINT-001',
        message: '维护中：写入被拒绝',
        details: { maintenance: true },
      },
    });
  };
}
