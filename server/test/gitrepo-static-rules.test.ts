import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// S3-T1 静态规则（任务约束「异步 spawn——禁 execFileSync，N4 教训：代码审查 +
// 静态规则双重拦截」；架构 §3.2「仓库路径由数据库中的稳定 ID 映射，不直接拼接
// 用户输入」）。与代码审查互补：这里做的是可在 CI 复跑的结构性断言——
// 1) 产品代码（src/）不得出现任何同步子进程调用（对自家服务自死锁，spike 两次踩中）；
// 2) `.git` 磁盘命名只允许出现在 vaults/repo-path.ts（正/逆映射唯一来源）——
//    任何别处拼出 `<something>.git` 路径即违反「路径经 DB 稳定 ID 映射」注入防线。

const SRC = path.resolve(import.meta.dirname, '../src');

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

/** 去注释（粗粒度：// 行注释与块注释）——规则只针对可执行代码，注释里的引用不算 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('静态规则：src/ 产品代码无任何同步子进程调用（execFileSync/spawnSync/execSync）', async () => {
  for (const file of await tsFiles(SRC)) {
    const code = stripComments(await readFile(file, 'utf8'));
    const hit = /\b(execFileSync|spawnSync|execSync)\b/.exec(code);
    assert.ok(hit === null, `${path.relative(SRC, file)} 含同步子进程调用「${hit?.[1]}」（N4 自死锁教训：一律异步 spawn）`);
  }
});

test('静态规则：`.git` 磁盘命名仅存在于 vaults/repo-path.ts（路径映射唯一来源）', async () => {
  // repo-path.ts = 正/逆映射唯一来源；db/migrations.ts = 契约 DDL 逐字迁移，
  // 其 `.git` 全部是 SQL 注释里的契约原文（storage-model §3.5），无路径构造代码。
  // githttp/cgi.ts（S3-T2）= clone URL 惯例后缀剥离（/git/<slug>.git 的正则），
  // 纯 URL 解析、不构造任何磁盘路径——磁盘 `<id>.git` 仍只出自 repo-path.ts。
  const allow = new Set([
    path.join('vaults', 'repo-path.ts'),
    path.join('db', 'migrations.ts'),
    path.join('githttp', 'cgi.ts'),
  ]);
  for (const file of await tsFiles(SRC)) {
    if ([...allow].some((a) => file.endsWith(a))) continue;
    const code = stripComments(await readFile(file, 'utf8'));
    assert.ok(!code.includes('.git'), `${path.relative(SRC, file)} 出现 .git 形态——仓库路径须经 vaultRepoPath/parseVaultRepoDirName 映射（repo-path.ts 唯一来源）`);
  }
});
