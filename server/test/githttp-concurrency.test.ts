import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { VaultService } from '../src/vaults/service.ts';
import { createVaultRepoOps } from '../src/gitrepo/lifecycle.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { setAppSetting } from '../src/limits/engine.ts';
import { FIXTURE_DDL, addEmployee } from './credentials-fixtures.ts';

// S8-T8 githttp 并发闸门接线（implementation-breakdown §2.7 S8-T8 行：服务端每
// 请求 git 子进程并发上限「接线 githttp 子进程 spawn 处+测试」）。被测形态 =
// 真实 Fastify 应用 + 真实 git http-backend 子进程链 + 原始 HTTP fetch（与
// githttp-behavior.test.ts 同构的最小世界）。断言面 = 闸门观察面
//（app.childProcessGate：active/queued/peakActive——app.ts 装配时挂的观察缝）：
//  - cap=1：并发请求被串行化（peakActive 恒 1）且全部成功 = 排队不拒绝；
//  - 默认 8：同样并发自然重叠（peakActive ≥2）= 上面的串行化是闸门所致；
//  - 401 请求不取槽（acquire 在认证之后、spawn 之前——闸门只数真实子进程链）。

const run = promisify(execFile);

interface ConcHarness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

async function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

/** 每用例独立应用实例（闸门状态随 app 生命周期——峰值断言要求干净起点） */
async function startHarness(maxConcurrentChildren?: number): Promise<ConcHarness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitconc-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const pepper = { active: { version: 1, key: randomBytes(32) }, retired: [] as never[] };
  const alice = addEmployee(db, { username: 'alice' });
  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  await vaultService.createVaultWithRepo(
    { name: 'Docs', slug: 'docs' },
    { employeeId: alice, entry: 'web', carrierRef: 'session:fixture' },
  );

  // git 域配置行（热生效：应用启动前后皆可——capacity 每次 acquire 实时读取）
  if (maxConcurrentChildren !== undefined) {
    setAppSetting(db, { key: 'git.maxConcurrentChildren', value: maxConcurrentChildren, updatedBy: alice });
  }

  const credentials = new CredentialsService({ db, pepper });
  const token = credentials.createCredential(alice, {
    name: 'git-conc',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  }).token;

  const app = buildApp({
    db,
    pepper,
    bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'),
    dataDir,
    dbFile,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    app,
    db,
    dataDir,
    port: app.addresses()[0]!.port,
    token,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const infoRefs = (h: ConcHarness, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${h.port}/git/docs.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: 'Basic ' + Buffer.from(`alice:${h.token}`).toString('base64'), ...headers },
  });

/** 排干响应体：undici 未读体会占住 keep-alive 连接，拖慢收尾 app.close() */
async function drain(res: Response): Promise<void> {
  await res.arrayBuffer();
}

test('cap=1（app_settings 行）：4 路并发 refs 发现被串行化（peakActive 恒 1）且全部 200——排队不拒绝', async () => {
  const h = await startHarness(1);
  try {
    const gate = h.app.childProcessGate;
    assert.ok(gate, 'app.childProcessGate 观察缝应存在（app.ts 装配时挂）');
    const reqs = await Promise.all([infoRefs(h), infoRefs(h), infoRefs(h), infoRefs(h)]);
    for (const res of reqs) {
      assert.equal(res.status, 200, '排队请求最终全部成功（FIFO 排队语义，非拒绝）');
      await drain(res);
    }
    assert.equal(gate.peakActive(), 1, '容量 1：任一采样时刻至多 1 条在途链（闸门强制串行化）');
    assert.equal(gate.activeCount(), 0, '全部完成后槽位归零（释放无泄漏）');
  } finally {
    await h.close();
  }
});

test('默认 8：同样 4 路并发自然重叠（peakActive ≥2）——上一用例的串行化是闸门所致而非请求本身不并发', async () => {
  const h = await startHarness();
  try {
    const gate = h.app.childProcessGate;
    assert.ok(gate);
    const reqs = await Promise.all([infoRefs(h), infoRefs(h), infoRefs(h), infoRefs(h)]);
    for (const res of reqs) {
      assert.equal(res.status, 200);
      await drain(res);
    }
    assert.ok(
      gate.peakActive() >= 2 && gate.peakActive() <= 4,
      `默认容量下 4 路并发应真实重叠（实测峰值 ${gate.peakActive()}）`,
    );
    assert.equal(gate.activeCount(), 0);
  } finally {
    await h.close();
  }
});

test('接线点：未认证 401 不取槽（acquire 在认证之后——闸门只数真实 spawn 的子进程链）', async () => {
  const h = await startHarness();
  try {
    const gate = h.app.childProcessGate;
    assert.ok(gate);
    const res = await fetch(`http://127.0.0.1:${h.port}/git/docs.git/info/refs?service=git-upload-pack`);
    assert.equal(res.status, 401);
    await drain(res);
    assert.equal(gate.peakActive(), 0, '401 路径不进闸门');
    assert.equal(gate.activeCount(), 0);
  } finally {
    await h.close();
  }
});

test('真实 git 客户端经闸门正常 clone/push（功能面无回归）', async () => {
  const h = await startHarness(2);
  try {
    const gate = h.app.childProcessGate;
    assert.ok(gate);
    const url = `http://alice:${h.token}@127.0.0.1:${h.port}/git/docs.git`;
    const clone = path.join(h.dataDir, 'clone');
    await git(['clone', url, clone]);
    await writeFile(path.join(clone, 'README.md'), '# nav\n');
    await git(['-C', clone, 'add', '.']);
    await git(['-C', clone, '-c', 'user.email=a@notegit.test', '-c', 'user.name=a', 'commit', '-m', 'nav']);
    await git(['-C', clone, 'push', 'origin', 'HEAD:refs/heads/main']);
    assert.ok(gate.peakActive() >= 1, 'clone/push 链经过闸门');
    assert.equal(gate.activeCount(), 0);
  } finally {
    await h.close();
  }
});

test('fail-closed：git 域配置行非法 → 请求 500 并指名配置键（不静默回退默认值）', async () => {
  const h = await startHarness();
  try {
    h.db
      .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('git.maxConcurrentChildren', '{bad json', '2026-10-14T00:00:00.000Z')`)
      .run();
    const res = await infoRefs(h);
    assert.equal(res.status, 500, '非法配置 fail-closed：闸门消费点拒请求');
    const body = (await res.json()) as { message?: string };
    assert.match(body.message ?? '', /git\.maxConcurrentChildren/, '错误消息指名配置键');
  } finally {
    await h.close();
  }
});
