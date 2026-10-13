import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.ts';
import { CredentialsService } from '../src/credentials/service.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { initBareVaultRepo } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { loadOrCreatePepper } from '../src/bootstrap/pepper.ts';
import { httpMaintenanceControl } from '../src/backup/run.ts';
import { FIXTURE_DDL, addEmployee, addVault } from './credentials-fixtures.ts';
import { drainCount } from '../src/audit/audit.ts';
import { newPushId, preRecordPendingPush } from '../src/githttp/receive-audit.ts';
import { main as reconcileMain, parseReconcileArgs } from '../src/audit/reconcile-cli.ts';

// S8-T6 恢复对账 CLI 面（触发形态 = 脚本/CLI——选型记录见 reconcile-cli.ts 头注；
// 与 S8-T4 备份 CLI 同形：维护断言经运行实例端点，数据面独立连接直读）：
// - 参数面：--data-dir/--url/--token-file（或 NOTEGIT_ADMIN_TOKEN）、--json；凭据卫生
//   同 DOD-09（令牌不进 argv）；
// - 执行面：真实应用 + 真实维护端点 + 真实 bare 仓库——维护未开 → 退出码 2 且零行
//   被改；维护开着 → 对账处置 + 报告 + 退出码 0，且完成后维护仍开（结构上不退）。

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@notegit.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@notegit.test',
};
async function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return (await run('git', args, { ...opts, env: GIT_ENV })).stdout.trim();
}
function gitIn(args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: GIT_ENV });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(' ')}: ${err}`)),
    );
    child.stdin.end(input);
  });
}

// ── 参数面（纯函数）────────────────────────────────────────────────────────

test('reconcile：最小合法参数解析齐全；--json 开关缺省关', () => {
  const a = parseReconcileArgs([
    'reconcile',
    '--data-dir', '/data',
    '--url', 'http://127.0.0.1:3000',
    '--token-file', '/run/secrets/admin.token',
  ]);
  assert.equal(a.command, 'reconcile');
  assert.equal(a.dataDir, '/data');
  assert.equal(a.url, 'http://127.0.0.1:3000');
  assert.equal(a.tokenFile, '/run/secrets/admin.token');
  assert.equal(a.json, false);
});

test('reconcile：必填缺失与未知参数 → 拒绝并带用法提示', () => {
  assert.throws(
    () => parseReconcileArgs(['reconcile', '--url', 'http://x', '--token-file', '/f']),
    (err: Error) => /--data-dir/.test(err.message),
  );
  assert.throws(
    () => parseReconcileArgs(['reconcile', '--data-dir', '/d', '--token-file', '/f']),
    (err: Error) => /--url/.test(err.message),
  );
  assert.throws(
    () => parseReconcileArgs(['reconcile', '--data-dir', '/d', '--url', 'http://x', '--bogus']),
    (err: Error) => /未知|--bogus/.test(err.message),
  );
  assert.throws(
    () => parseReconcileArgs(['reconcile', '--data-dir', '/d', '--url', 'http://x']),
    (err: Error) => /令牌|token/i.test(err.message),
  );
});

// ── 执行面：真实实例（维护断言经端点；处置后维护仍开）──────────────────────

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  baseUrl: string;
  tokenFile: string;
  control: ReturnType<typeof httpMaintenanceControl>;
  vaultId: number;
  close(): Promise<void>;
}

async function startInstance(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-s8t6-cli-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const admin = addEmployee(db, { username: 'root', is_instance_admin: 1 });
  const vaultId = addVault(db, 'docs', admin);
  await initBareVaultRepo(dataDir, vaultId);

  const pepper = await loadOrCreatePepper(path.join(dataDir, 'keys', 'token-pepper.key'));
  const credentials = new CredentialsService({ db, pepper });
  const token = credentials
    .createCredential(admin, {
      name: 'reconcile-carrier',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    .token;
  const tokenFile = path.join(dataDir, 'config', 'admin.token');
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(path.join(dataDir, 'config', 'admin-bootstrap.token'), 'stub\n', { mode: 0o600 });

  const app = buildApp({ db, pepper, bootstrapTokenFile: path.join(dataDir, 'config', 'admin-bootstrap.token'), dataDir, dbFile });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${app.addresses()[0]!.port}`;
  return {
    app,
    db,
    dataDir,
    baseUrl,
    tokenFile,
    control: httpMaintenanceControl({ baseUrl, token }),
    vaultId,
    close: async () => {
      await app.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function seedAnomaly(h: Harness): Promise<void> {
  // 半应用写 A 形态：bare 内 plumbing 造提交并把引用实推到 new；审计行停 pending
  const repo = vaultRepoPath(h.dataDir, h.vaultId);
  const blob = await gitIn(['hash-object', '-w', '--stdin'], repo, '# cli drill\n');
  const tree = await gitIn(['mktree'], repo, `100644 blob ${blob}\tdoc.md\n`);
  const commit = await git(['commit-tree', tree, '-m', 'cli'], { cwd: repo });
  await git(['update-ref', 'refs/heads/main', commit], { cwd: repo });
  preRecordPendingPush(h.db, {
    subject: { employeeId: 1, carrierRef: 'credential:1', entry: 'git' },
    vaultId: h.vaultId,
    commands: [{ ref: 'refs/heads/main', oldOid: '0'.repeat(40), newOid: commit }],
    pushId: newPushId(),
    occurredAt: new Date().toISOString(),
  });
}

let h: Harness;
after(async () => {
  if (h) await h.close();
});

test('CLI 执行：维护未开 → 退出码 2、零行被改；开维护 → 对账处置退出码 0、完成后维护仍开', async () => {
  h = await startInstance();
  await seedAnomaly(h);
  const argvBase = ['reconcile', '--data-dir', h.dataDir, '--url', h.baseUrl, '--token-file', h.tokenFile];

  // 维护未开：对账拒绝动手
  assert.equal(await reconcileMain([...argvBase]), 2);
  assert.equal(drainCount(h.db), 1, '对账未动任何行');

  // 开维护（经实例端点——恢复流程 §7 步骤 1 的前置在此由测试代置）
  await h.control.enable();
  assert.equal(await reconcileMain([...argvBase]), 0);
  assert.equal(drainCount(h.db), 0, 'pending 已定终态');
  assert.equal(await h.control.isEnabled(), true, '对账完成不退维护（§7 步骤 8–10 仍待人工）');
});
