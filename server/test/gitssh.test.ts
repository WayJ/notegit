import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import ssh2 from 'ssh2';
import type { ClientChannel } from 'ssh2';

const { Client, utils: sshUtils } = ssh2;
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { createDbMembershipSource } from '../src/vaults/membership.ts';
import { createMaintenanceGate } from '../src/maintenance/gate.ts';
import { VaultService } from '../src/vaults/service.ts';
import { createVaultRepoOps } from '../src/gitrepo/lifecycle.ts';
import { vaultRepoPath } from '../src/vaults/repo-path.ts';
import { startGitSshServer, parseSshGitCommand, slugFromSshPath, type StartedGitSshServer } from '../src/gitssh/server.ts';
import { fingerprintOf, parsePublicKey, SshKeyRegistry } from '../src/gitssh/keys.ts';
import { FIXTURE_DDL, addEmployee, addMember } from './credentials-fixtures.ts';

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/** 一名员工的一对 SSH 密钥（私钥仅落测试临时目录，公钥走登记面）。 */
interface KeyPair {
  readonly privateKey: string;
  readonly publicLine: string;
  readonly fingerprint: string;
}

function newKeyPair(): KeyPair {
  // OpenSSH 形态（与成员 ~/.ssh 里的私钥同形）：ssh2 自己生成，解析器认。
  const { private: privateKey, public: publicKey } = sshUtils.generateKeyPairSync('ed25519');
  const parsed = sshUtils.parseKey(Buffer.from(privateKey, 'utf8'));
  assert.ok(!(parsed instanceof Error), '私钥应可解析');
  const blob = parsed.getPublicSSH();
  assert.ok(blob !== null, '应能导出公钥 wire blob');
  return {
    privateKey,
    publicLine: publicKey,
    fingerprint: fingerprintOf(blob),
  };
}

interface Harness {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly dbFile: string;
  readonly ssh: StartedGitSshServer;
  readonly docsRepo: string;
  readonly vaultId: number;
  readonly keys: Record<'alice' | 'bob' | 'carol' | 'dave', KeyPair>;
  close(): Promise<void>;
}

let h: Harness;

async function startHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'notegit-gitssh-'));
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = openDatabase(dbFile);
  migrate(db, MIGRATIONS);
  for (const ddl of FIXTURE_DDL) db.exec(ddl);

  const alice = addEmployee(db, { username: 'alice' });
  const bob = addEmployee(db, { username: 'bob' });
  const carol = addEmployee(db, { username: 'carol' });
  const dave = addEmployee(db, { username: 'dave' });

  const vaultService = new VaultService({ db, repoOps: createVaultRepoOps(dataDir) });
  const docs = await vaultService.createVaultWithRepo(
    { name: 'Docs', slug: 'docs' },
    { employeeId: alice, entry: 'web', carrierRef: 'session:fixture' },
  );
  db.prepare('UPDATE vaults SET main_admin_only = 1 WHERE id = ?').run(docs.id);
  addMember(db, docs.id, bob, 'editor', alice);
  addMember(db, docs.id, carol, 'reader', alice);

  // 种子提交：直接推入 bare 库（SSH 面之前的内容）
  const docsRepo = vaultRepoPath(dataDir, docs.id);
  const seed = path.join(dataDir, 'seed');
  await run('git', ['init', '-b', 'main', seed], { env: GIT_ENV });
  await writeFile(path.join(seed, 'README.md'), '# nav\n');
  await run('git', ['-C', seed, 'add', '.'], { env: GIT_ENV });
  await run('git', ['-C', seed, '-c', 'user.email=seed@notegit.test', '-c', 'user.name=seed', 'commit', '-m', 'seed'], { env: GIT_ENV });
  await run('git', ['-C', seed, 'push', docsRepo, 'main'], { env: GIT_ENV });

  // 公钥登记：每个员工一把
  const registry = new SshKeyRegistry({ db });
  const keys = {} as Harness['keys'];
  for (const [who, id] of [['alice', alice], ['bob', bob], ['carol', carol], ['dave', dave]] as const) {
    const pair = newKeyPair();
    keys[who] = pair;
    const parsed = parsePublicKey(pair.publicLine);
    assert.ok(parsed !== null, '公钥应可解析');
    registry.register(id, parsed, `${who}-laptop`);
  }

  const ssh = await startGitSshServer({
    dataDir,
    db,
    dbFile,
    membershipSource: createDbMembershipSource(db),
    maintenanceGate: createMaintenanceGate(),
    port: 0,
  });

  return {
    db,
    dataDir,
    dbFile,
    ssh,
    docsRepo,
    vaultId: docs.id,
    keys,
    close: async () => {
      await ssh.close();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h.close();
});

/** 某员工的 SSH 客户端命令（真实 git 客户端走 ssh -i）。 */
function sshCommandFor(who: keyof Harness['keys'], keyFile: string): string {
  return [
    'ssh',
    '-i', keyFile,
    '-p', String(h.ssh.port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
  ].join(' ');
}

/** 员工的私钥落盘（ssh -i 需要文件）。 */
async function keyFileFor(who: keyof Harness['keys']): Promise<string> {
  const file = path.join(h.dataDir, `${who}_key`);
  await writeFile(file, h.keys[who].privateKey, { mode: 0o600 });
  return file;
}

/** 走 SSH 的 git 调用（真实客户端）。 */
async function gitOverSsh(
  who: keyof Harness['keys'],
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const keyFile = await keyFileFor(who);
  return run('git', args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...GIT_ENV, GIT_SSH_COMMAND: sshCommandFor(who, keyFile) },
  });
}

test('命令解析只放行两个 pack 服务，路径只解出合法 slug', () => {
  assert.deepEqual(parseSshGitCommand("git-upload-pack '/docs.git'"), {
    service: 'git-upload-pack',
    path: '/docs.git',
  });
  assert.equal(parseSshGitCommand('git-upload-pack'), null);
  assert.equal(parseSshGitCommand("rm -rf '/docs.git'"), null);
  assert.equal(slugFromSshPath('/docs.git'), 'docs');
  assert.equal(slugFromSshPath('docs'), 'docs');
  assert.equal(slugFromSshPath('/../etc'), null);
  assert.equal(slugFromSshPath('/Docs'), null);
});

test('已登记公钥的成员可经 SSH 读到 refs（真实 git 客户端 ls-remote）', async () => {
  const result = await gitOverSsh('alice', ['ls-remote', `ssh://git@127.0.0.1:${h.ssh.port}/docs.git`]);
  assert.match(result.stdout, /refs\/heads\/main/);
});

test('未登记公钥一律认证失败（客户端拿不到 refs）', async () => {
  const stranger = newKeyPair();
  const keyFile = path.join(h.dataDir, 'stranger_key');
  await writeFile(keyFile, stranger.privateKey, { mode: 0o600 });
  await assert.rejects(
    run('git', ['ls-remote', `ssh://git@127.0.0.1:${h.ssh.port}/docs.git`], {
      env: {
        ...GIT_ENV,
        GIT_SSH_COMMAND: [
          'ssh', '-i', keyFile, '-p', String(h.ssh.port),
          '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
          '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
        ].join(' '),
      },
    }),
    (err: { stderr?: string; message?: string }) => {
      const text = `${err.stderr ?? ''}${err.message ?? ''}`;
      assert.match(text, /Permission denied|publickey|Authentication|could not read/i);
      return true;
    },
  );
});

test('非成员读不到 refs；reader 能读但写不动', async () => {
  // 非成员：库不存在与无权同形（不泄露存在性）——ls-remote 拿不到任何 ref。
  await assert.rejects(
    gitOverSsh('dave', ['ls-remote', `ssh://git@127.0.0.1:${h.ssh.port}/docs.git`]),
    (err: { stderr?: string; message?: string }) => {
      assert.match(`${err.stderr ?? ''}${err.message ?? ''}`, /not found|Repository|could not read|Permission denied/i);
      return true;
    },
  );
  // reader：clone（读）成立，推送被上游授权层拒绝。
  const work = path.join(h.dataDir, 'reader-clone');
  await gitOverSsh('carol', ['clone', `ssh://git@127.0.0.1:${h.ssh.port}/docs.git`, work]);
  await writeFile(path.join(work, 'reader.md'), '---\ntitle: Reader\n---\n\n# reader\n');
  await run('git', ['-C', work, 'add', '.'], { env: GIT_ENV });
  await run('git', ['-C', work, '-c', 'user.email=carol@notegit.test', '-c', 'user.name=carol', 'commit', '-m', 'reader push'], { env: GIT_ENV });
  await assert.rejects(gitOverSsh('carol', ['-C', work, 'push', 'origin', 'HEAD:refs/heads/reader-branch']));
});

test('标准 git 客户端可经 SSH clone 与 push（editor 推分支 / admin 推默认分支）', async () => {
  // editor：clone 成立；推默认分支被上游 main_admin_only 策略拒（授权层在服务端生效）。
  const editorWork = path.join(h.dataDir, 'clone-editor');
  await gitOverSsh('bob', ['clone', `ssh://git@127.0.0.1:${h.ssh.port}/docs.git`, editorWork]);
  // 知识格式校验（frontmatter 必填）在 SSH 面同样生效——内容按规则写。
  await writeFile(path.join(editorWork, 'notes.md'), '---\ntitle: Over SSH\n---\n\n# over ssh\n');
  await run('git', ['-C', editorWork, 'add', '.'], { env: GIT_ENV });
  await run('git', ['-C', editorWork, '-c', 'user.email=bob@notegit.test', '-c', 'user.name=bob', 'commit', '-m', 'ssh branch push'], { env: GIT_ENV });
  await gitOverSsh('bob', ['-C', editorWork, 'push', 'origin', 'HEAD:refs/heads/ssh-branch']);
  const branches = await run('git', ['-C', h.docsRepo, 'branch', '--list', 'ssh-branch'], { env: GIT_ENV });
  assert.match(branches.stdout, /ssh-branch/);

  // admin：推默认分支成立（clone 后直接推 main）。
  const adminWork = path.join(h.dataDir, 'clone-admin');
  await gitOverSsh('alice', ['clone', `ssh://git@127.0.0.1:${h.ssh.port}/docs.git`, adminWork]);
  await writeFile(path.join(adminWork, 'admin.md'), '---\ntitle: Admin Push\n---\n\n# admin push\n');
  await run('git', ['-C', adminWork, 'add', '.'], { env: GIT_ENV });
  await run('git', ['-C', adminWork, '-c', 'user.email=alice@notegit.test', '-c', 'user.name=alice', 'commit', '-m', 'ssh push'], { env: GIT_ENV });
  await gitOverSsh('alice', ['-C', adminWork, 'push', 'origin', 'main']);
  const log = await run('git', ['-C', h.docsRepo, 'log', '--oneline', '-1', 'main'], { env: GIT_ENV });
  assert.match(log.stdout, /ssh push/);
});
