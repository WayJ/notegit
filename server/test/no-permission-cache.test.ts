import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// D-IC-05（identity §5.1）：认证与授权检查每请求实时查库/查源，任何形式的权限
// 缓存/TTL（含读路径）不在契约允许范围。本文件是**代码结构断言**（静态检查 +
// 依赖图断言），与 lifecycle.test.ts 的运行时「下一请求立即生效」用例互补：
// 运行时用例证明判定确实逐请求反映库中状态，本断言防止后续任务引入缓存形态。

const SRC_ROOT = path.resolve(import.meta.dirname, '../src');

/** 权限判定面（identity §5.1 两层检查的实现模块）：缓存禁区的核心 */
const DECISION_MODULES = [
  'auth/sessions.ts',
  'auth/subject.ts',
  'auth/lifecycle.ts',
  'auth/csrf.ts',
  'credentials/service.ts',
  'credentials/token.ts',
] as const;

/** 模块级可变容器扫描范围（判定面之外的身份/凭据/引导域一并纳入） */
const SCANNED_DIRS = ['auth', 'credentials', 'bootstrap', 'invites', 'db'] as const;

function readSrc(rel: string): string {
  return readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

function tsFiles(dir: string): string[] {
  return readdirSync(path.join(SRC_ROOT, dir)).filter((f) => f.endsWith('.ts'));
}

test('结构断言：权限判定模块无缓存/记忆化/TTL 形态标识（D-IC-05）', () => {
  const banned = /\b(cache|Cache|CACHE|memo|Memo|memoize|lru|LRU|ttl|TTL)\b/;
  for (const rel of DECISION_MODULES) {
    const src = readSrc(rel);
    const hits = src.split('\n').map((line, i) => ({ line, no: i + 1 })).filter((l) => banned.test(l.line));
    assert.deepEqual(
      hits.map((h) => h.line.trim()),
      [],
      `${rel} 不得出现缓存/TTL 形态标识（D-IC-05；命中行：${hits.map((h) => h.no).join(',')}）`,
    );
  }
});

test('结构断言：判定模块的 import 仅 node 内置 / fastify / 项目内相对路径（无缓存库依赖）', () => {
  for (const rel of DECISION_MODULES) {
    const imports = [...readSrc(rel).matchAll(/import[^'"]*from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) {
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../') || spec === 'fastify',
        `${rel} 的依赖 ${spec} 应为 node 内置、fastify 框架或项目内相对路径（不引入缓存库）`,
      );
    }
  }
});

test('结构断言：server 运行时依赖不含缓存组件（依赖图层面）', () => {
  const pkg = JSON.parse(readFileSync(path.join(SRC_ROOT, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const deps = Object.keys(pkg.dependencies ?? {});
  const bannedDeps = /cache|lru|redis|memcach/i;
  assert.deepEqual(deps.filter((d) => bannedDeps.test(d)), [], '不得引入缓存组件依赖');
});

test('结构断言：身份/凭据域无模块级可变容器充当跨请求状态（allowlist 逐条具名并论证）', () => {
  // 模块顶层（行首无缩进）声明 new Map/Set/WeakMap = 跨请求共享的可变状态。
  // 唯一 allowlist：credentials/routes.ts 的 authUsers——键为请求对象（每请求唯一），
  // 只承载该请求内的认证上下文，结构上不可能跨请求缓存判定（D-IC-05）。
  const ALLOWED: Record<string, string[]> = {
    'credentials/routes.ts': ['const authUsers = new WeakMap'],
  };
  const moduleLevelContainer = /^(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Map|Set|WeakMap)\s*[<(]/;
  for (const dir of SCANNED_DIRS) {
    for (const file of tsFiles(dir)) {
      const rel = `${dir}/${file}`;
      const offenders = readSrc(rel)
        .split('\n')
        .filter((line) => moduleLevelContainer.test(line))
        .filter((line) => !(ALLOWED[rel] ?? []).some((a) => line.includes(a)));
      assert.deepEqual(offenders, [], `${rel} 存在未具名豁免的模块级可变容器（跨请求状态，D-IC-05 禁区）`);
    }
  }
});

test('结构断言：backoff 的进程内计数在工厂闭包内（登录退避运行态，非权限判定，storage-model §2）', () => {
  const src = readSrc('auth/backoff.ts');
  assert.match(src, /export function createLoginBackoff/);
  // Map 必须出现在工厂函数体内（缩进），不得提升到模块顶层
  assert.ok(
    !/^const\s+\w+\s*=\s*new\s+Map/.test(src),
    '退避计数 Map 须留在工厂闭包内（每实例独立运行态，不构成权限缓存）',
  );
  assert.match(src, /\n\s+const entries = new Map/, '计数容器应在 createLoginBackoff 闭包内');
});
