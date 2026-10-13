import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { hashPassword } from '../src/auth/password.ts';
import { newDb, addEmployee } from './credentials-fixtures.ts';
import { createMaintenanceGate } from '../src/maintenance/gate.ts';

// S8-T5 恢复启动形态（backup-recovery §7 步骤 1「部署容器（保持维护模式启动）」）：
// NOTEGIT_MAINTENANCE_ON_START=1 → 闸门以开启态创建——恢复流程装载产物后、§8 清单
// 全绿前，实例不得接收业务写。env 只设**初态**：生命周期端点语义不变（POST/DELETE
// 仍可切换，POST 幂等无迁移不记行）；缺省（不设/非 '1'）行为与 S2-T7 完全一致。

const ORIGIN = { origin: 'http://localhost' };

async function buildStartedApp(): Promise<{
  app: FastifyInstance;
  db: DatabaseSync;
  dir: string;
  close(): Promise<void>;
}> {
  const db = newDb();
  const alice = addEmployee(db, { username: 'alice', is_instance_admin: 1 });
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(
    await hashPassword('password-alice-1'),
    alice,
  );
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-maint-start-'));
  const pepper = await loadOrCreatePepper(path.join(dir, 'token-pepper.key'));
  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dir, 'admin-bootstrap.token'),
  });
  return {
    app,
    db,
    dir,
    close: async () => {
      await app.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('闸门单元：NOTEGIT_MAINTENANCE_ON_START=1 → 以开启态创建；端点切换语义不变', () => {
  const prev = process.env.NOTEGIT_MAINTENANCE_ON_START;
  try {
    process.env.NOTEGIT_MAINTENANCE_ON_START = '1';
    const gate = createMaintenanceGate();
    assert.equal(gate.isEnabled(), true, 'env=1 → 初始即开启（§7 步骤 1）');
    assert.equal(gate.enable(), false, '已开再开无迁移（幂等语义不变）');
    assert.equal(gate.disable(), true, '可正常关闭（生命周期端点可用）');
    assert.equal(gate.isEnabled(), false);

    process.env.NOTEGIT_MAINTENANCE_ON_START = '0';
    assert.equal(createMaintenanceGate().isEnabled(), false, "非 '1' 值不触发");
    delete process.env.NOTEGIT_MAINTENANCE_ON_START;
    assert.equal(createMaintenanceGate().isEnabled(), false, '缺省与 S2-T7 一致');
  } finally {
    if (prev === undefined) delete process.env.NOTEGIT_MAINTENANCE_ON_START;
    else process.env.NOTEGIT_MAINTENANCE_ON_START = prev;
  }
});

test('应用级：env 启动即维护态——进度面 enabled=true、业务写 503、登录读放行', async () => {
  const prev = process.env.NOTEGIT_MAINTENANCE_ON_START;
  process.env.NOTEGIT_MAINTENANCE_ON_START = '1';
  const ctx = await buildStartedApp();
  try {
    // 登录放行（D-BR-06：会话是运行态）
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: 'password-alice-1' },
    });
    assert.equal(login.statusCode, 200, '维护中登录保持可用');
    const sid = /ngt_sid=([^;]+)/.exec(
      (login.headers['set-cookie'] as string | undefined) ?? '',
    )?.[1];
    assert.ok(sid, '应建立会话');
    const cookie = { cookie: `ngt_sid=${sid}`, ...ORIGIN };

    // 进度面如实呈现开启态（恢复流程的 finalize 以此复核「确实以维护态启动」）
    const face = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/maintenance', headers: cookie });
    assert.equal(face.statusCode, 200);
    assert.equal((face.json() as { enabled?: boolean }).enabled, true, '启动即维护态');

    // 业务写被拒（草稿保存——backup §3 矩阵第 2 行；503 E-MAINT-001）
    const write = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/vaults/any/drafts/x.md',
      headers: cookie,
      payload: { content: '---\ntitle: t\n---\n', base_commit: null },
    });
    assert.equal(write.statusCode, 503, '启动即维护态下业务写必须 503');
    assert.equal((write.json() as { error?: { code?: string } }).error?.code, 'E-MAINT-001');

    // 读放行（一切读——矩阵第 7 行）
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: cookie });
    assert.equal(me.statusCode, 200);

    // 可经端点正常退出（§7 步骤 10 的出口保持唯一：显式 DELETE）
    const off = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/admin/maintenance', headers: cookie });
    assert.equal(off.statusCode, 204);
    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/maintenance', headers: cookie });
    assert.equal((after.json() as { enabled?: boolean }).enabled, false);
  } finally {
    await ctx.close();
    if (prev === undefined) delete process.env.NOTEGIT_MAINTENANCE_ON_START;
    else process.env.NOTEGIT_MAINTENANCE_ON_START = prev;
  }
});
