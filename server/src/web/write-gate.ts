import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MaintenanceGate } from '../maintenance/gate.ts';
import { layout } from './pages.ts';

/**
 * S4-T5 维护闸门 web 缝（S4-T4 遗留移交；backup-recovery §3 矩阵 web 行）：
 *
 * - 组装点（web/routes.ts）注入 gate 实例，这里生成 web 域写守卫 onRequest 钩子：
 *   维护模式开启后，全部 web 写操作（upload / rename / delete；未来的 edit
 *   submit POST 属 /vaults/ 下非安全方法，自动覆盖）503 拒绝。
 * - 响应形态分两路（backup §3 矩阵）：程序化上传（octet-stream）返 JSON 结构化
 *   错误（E-MAINT-001 + details.maintenance 标志，api.md §2.3 同款结构）；页面
 *   流程（表单 POST）返 503 HTML 同页提示（「维护中」文案）。
 * - 读路径不受影响（SAFE_METHODS 放行——矩阵第 7 行）；/api/v1 与 /git 不在
 *   本层（各自的 maintenanceGuard / githttp 入口已覆盖）；路径前缀 /vaults/
 *   即 web 页面域全量（S4-D5：web 写路由都在此后缀下）。
 */

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 页面域维护提示页（503；D5 极简同页提示形态——无写操作、无页内脚本） */
function maintenanceBlockedPage(): string {
  return layout(
    '维护中',
    `<h1>维护中</h1>
<p>实例处于维护模式：写入被拒绝（你的数据未变更）。维护结束后写入自动恢复，请稍后重试。</p>
<p><a href="/vaults">返回知识库</a></p>
`,
  );
}

/** 程序化上传维护拒绝 JSON 形状（E-MAINT-001；api.md §2.3 结构化错误同款） */
function maintenanceJson() {
  return {
    ok: false,
    stage: 'maintenance',
    reason: '维护中：写入被拒绝（维护模式已开启，恢复后重试）',
    error: { code: 'E-MAINT-001', message: '维护中：写入被拒绝', details: { maintenance: true } },
  };
}

/** web 写守卫（onRequest 钩子；gate 缺省 = 无缝调用形态，S2 测试同构不拦截） */
export function webWriteGuard(gate: MaintenanceGate | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (gate === undefined || !gate.isEnabled()) return;
    if (SAFE_METHODS.has(req.method.toUpperCase())) return;
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/vaults/')) return;
    if (String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) {
      await reply.code(503).send(maintenanceJson());
      return;
    }
    await reply.code(503).type('text/html; charset=utf-8').send(maintenanceBlockedPage());
  };
}
