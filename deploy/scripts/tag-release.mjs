#!/usr/bin/env node
/**
 * S9-T7 版本发布 tag 脚本（DOD-15 版本化发布包的 git 侧命令）。
 *
 * 义务与边界（breakdown §2.8 S9-T7）：真实 tag 不在任务内打——本脚本把
 * 「打 v0.1.0 标签」做成可复核命令：先冻结断言（三包版本一致、工作树干净、
 * tag 未存在），再给出（或 --apply 执行）带注解 tag 命令。默认 dry-run 只打印。
 *
 * 用法（仓库根执行）：
 *   node deploy/scripts/tag-release.mjs            # 冻结断言 + 打印命令（dry-run）
 *   node deploy/scripts/tag-release.mjs --apply    # 断言全过后真实执行 git tag -a
 * 退出码：0 = 断言全过（dry-run 打印 / --apply 已打）；1 = 任一断言失败或已存在。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = (cmd, argv) => spawnSync(cmd, argv, { cwd: REPO_ROOT, encoding: 'utf8' });

// ── 冻结断言 ────────────────────────────────────────────────────────────────
// 1) 三包版本一致（server / cli / packages/validation；monorepo 根随行）。
const pkgVersion = (p) => JSON.parse(readFileSync(path.join(REPO_ROOT, p), 'utf8')).version;
const versions = {
  server: pkgVersion('server/package.json'),
  cli: pkgVersion('cli/package.json'),
  validation: pkgVersion('packages/validation/package.json'),
};
const rootVersion = pkgVersion('package.json');
const frozen = new Set(Object.values(versions));
if (frozen.size !== 1) {
  console.error(`✗ 三包版本不一致：${JSON.stringify(versions)}——先冻结再打 tag。`);
  process.exit(1);
}
const version = versions.server;
const TAG = `v${version}`;
console.log(`✓ 三包版本一致：${version}（server/cli/validation；monorepo 根 ${rootVersion}）`);

// 2) 契约与迁移数留档进 tag 注记（与发布说明版本清单同源）。
const rulesVersion = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'docs/contracts/rules-version.json'), 'utf8'),
).rulesVersion;
const { MIGRATIONS } = await import(path.join(REPO_ROOT, 'server/src/db/migrations.ts'));
const schemaTop = MIGRATIONS[MIGRATIONS.length - 1].version;
console.log(`✓ rulesVersion ${rulesVersion}；schema 迁移 ${MIGRATIONS.length} 条（顶版 v${schemaTop}）`);

// 3) 工作树必须干净（tag 锚定已提交的冻结态，不锚定未提交改动）。
const dirty = run('git', ['status', '--porcelain']);
if (dirty.status !== 0) {
  console.error(`✗ git status 失败：${dirty.stderr}`);
  process.exit(1);
}
if (dirty.stdout.trim() !== '') {
  console.error(`✗ 工作树不干净：\n${dirty.stdout}——先提交冻结态再打 tag。`);
  process.exit(1);
}
console.log('✓ 工作树干净（tag 将锚定当前 HEAD）');

// 4) tag 未存在（重打同名 tag 是事故面，不幂等）。
const head = run('git', ['rev-parse', 'HEAD']).stdout.trim();
const exists = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${TAG}`]);
if (exists.status === 0) {
  console.error(`✗ tag ${TAG} 已存在（${exists.stdout.trim()}）——不得重打；如需移除属 master 显式裁决。`);
  process.exit(1);
}
console.log(`✓ tag ${TAG} 未存在；HEAD = ${head.slice(0, 10)}…`);

// ── 命令（打印 = 交付物；--apply 才执行）───────────────────────────────────
const message = `Notegit ${TAG} (rules ${rulesVersion}, schema ${MIGRATIONS.length} migrations)`;
const tagCmd = ['tag', '-a', TAG, '-m', message, head];
console.log('\n发布 tag 命令（tag 不随 S9-T7 任务执行，由发布操作者运行）：');
console.log(`  git ${tagCmd.map((a) => (a === message ? `"${a}"` : a)).join(' ')}`);
console.log('  # 推送 tag（另行执行；本仓约束 push 属 master）：');
console.log(`  git push origin ${TAG}`);

if (process.argv.includes('--apply')) {
  const r = run('git', tagCmd);
  if (r.status !== 0) {
    console.error(`✗ git tag 失败：${r.stderr}`);
    process.exit(1);
  }
  console.log(`\n✓ 已打注解 tag ${TAG} @ ${head.slice(0, 10)}…（未推送）`);
} else {
  console.log('\n（dry-run：命令已打印未执行；--apply 才真实打 tag）');
}
