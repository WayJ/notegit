import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { startApp } from '../src/main.ts';

// S2-T1 交接（architecture-notes §3）：启动接线 open → pragmas → migrate → listen
// （backup §9 随新版本启动自动执行）；bootstrap token / pepper 落 /data 布局（backup §2）。

const stubHash = async (p: string) => `stub-hash$${p}`;

test('启动接线：open→pragmas→migrate→listen 顺序生效（WAL、版本行、监听、初始化态资产就绪）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-start-'));
  try {
    const inst = await startApp({ dataDir: dir, host: '127.0.0.1', port: 0, hashPassword: stubHash });
    try {
      // listen 已发生（端口已分配）
      assert.ok(inst.port > 0);
      // pragmas 已生效（open 阶段）
      assert.equal(inst.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
      assert.equal(inst.db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
      // migrate 在 listen 前跑完：0002 已记录；依赖表已在（业务路由可用）
      const versions = inst.db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[];
      assert.deepEqual(versions.map((v) => v.version), [1, 2]);
      const health = await inst.app.inject({ method: 'GET', url: '/healthz' });
      assert.equal(health.statusCode, 200);
      // 空库 → 初始化态资产：bootstrap token 文件（0600）与 pepper（0600）已落 /data 布局
      assert.equal((await stat(inst.bootstrapTokenFile)).mode & 0o777, 0o600);
      assert.match(await readFile(inst.bootstrapTokenFile, 'utf8'), /^[A-Za-z0-9_-]{43}$/);
      assert.equal((await stat(path.join(dir, 'keys', 'token-pepper.key'))).mode & 0o777, 0o600);
      // 业务入口进入初始化态闸门（503 E-AUTH-007）
      const gated = await inst.app.inject({ method: 'GET', url: '/api/v1/admin/employees' });
      assert.equal(gated.statusCode, 503);
      assert.equal(gated.json().error.code, 'E-AUTH-007');
    } finally {
      await inst.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('重启稳定性：同数据目录再启动不重发 token、不重生成 pepper', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-start-'));
  try {
    const first = await startApp({ dataDir: dir, host: '127.0.0.1', port: 0, hashPassword: stubHash });
    const token1 = await readFile(first.bootstrapTokenFile, 'utf8');
    const pepper1 = await readFile(path.join(dir, 'keys', 'token-pepper.key'), 'utf8');
    await first.close();
    const second = await startApp({ dataDir: dir, host: '127.0.0.1', port: 0, hashPassword: stubHash });
    try {
      assert.equal(await readFile(second.bootstrapTokenFile, 'utf8'), token1);
      assert.equal(await readFile(path.join(dir, 'keys', 'token-pepper.key'), 'utf8'), pepper1);
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('已初始化实例丢失 pepper → 启动大声失败（防静默重生成废掉全部已存哈希）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-start-'));
  try {
    const inst = await startApp({ dataDir: dir, host: '127.0.0.1', port: 0, hashPassword: stubHash });
    const token = await readFile(inst.bootstrapTokenFile, 'utf8');
    const boot = await inst.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { bootstrap_token: token, username: 'root', display_name: 'Root', password: 'password-123456' },
    });
    assert.equal(boot.statusCode, 201);
    await inst.close();
    await rm(path.join(dir, 'keys', 'token-pepper.key'));
    await assert.rejects(
      () => startApp({ dataDir: dir, host: '127.0.0.1', port: 0, hashPassword: stubHash }),
      /pepper/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('数据目录可用 NOTEGIT_DATA_DIR 覆盖（默认 /data，容器布局 backup §2）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-start-'));
  const prev = process.env.NOTEGIT_DATA_DIR;
  process.env.NOTEGIT_DATA_DIR = dir;
  try {
    const inst = await startApp({ host: '127.0.0.1', port: 0, hashPassword: stubHash });
    try {
      assert.equal(path.dirname(inst.bootstrapTokenFile), path.join(dir, 'config'));
      assert.ok(existsSync(path.join(dir, 'db', 'notegit.sqlite')));
    } finally {
      await inst.close();
    }
  } finally {
    if (prev === undefined) delete process.env.NOTEGIT_DATA_DIR;
    else process.env.NOTEGIT_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
