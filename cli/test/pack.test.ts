import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cliDir = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  engines: { node: string }
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  bin: Record<string, string>
}

interface PackEntry { path: string; mode: number }
interface PackResult { files: PackEntry[]; entryCount: number }

function npmPackDryRun(): PackResult {
  // S7-T8 选型：不在测试内构建（T4 挂账的并发竞态——node --test 阶段多文件并发，
  // 本文件曾每次 dry-run 前跑 npm run build，半写 dist 被并发读者（login/sync 系）
  // 命中即瞬态失败）。构建属 npm test 串行前置相；这里消费已构建的 dist，
  // --ignore-scripts 跳过 prepack（=npm run build，同源竞态）。备选「构建加文件锁」
  // 被否决：竞态受害方是并发读者而非构建者，要求全部读者持锁侵入面过大；
  // 「test 脚本拆分串行相」被否决：源头已无并发构建者，无需新增编排。
  // 真实发布路径不受影响：npm pack（非 dry-run）照常走 prepack 自动构建。
  assert.ok(
    existsSync(new URL('../dist/bin/notegit.js', import.meta.url)),
    'dist 未构建——pack 清单断言依赖已构建产物；先 `npm run build`（或走 `npm test`，其串行前置相已含构建）',
  )
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: cliDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `npm pack --dry-run 应成功，stderr：${r.stderr.slice(0, 500)}`)
  const parsed = JSON.parse(r.stdout) as PackResult[]
  assert.ok(parsed.length > 0, 'npm pack --json 应输出至少一个包条目')
  return parsed[0]
}

test('pack 清单只含分发文件：dist/、README.md、package.json（files 白名单）', () => {
  const { files } = npmPackDryRun()
  assert.ok(files.length > 0)
  const allowed = /^(dist\/|README\.md$|package\.json$)/
  for (const f of files) {
    assert.match(f.path, allowed, `打包清单出现非分发文件：${f.path}`)
  }
})

test('pack 清单含 dist/bin/notegit.js（可执行、纯 JS——Node 不剥离 node_modules 下 .ts 类型）', () => {
  const { files } = npmPackDryRun()
  const entry = files.find((f) => f.path === 'dist/bin/notegit.js')
  assert.ok(entry !== undefined, 'dist/bin/notegit.js 应在打包清单中')
  assert.equal(entry.mode, 0o755, 'bin 入口应保留可执行位（0o755）')
})

test('pack 清单不含源码 .ts 与 dev 文件（源码经 tsc --noEmit 独立把关）', () => {
  const { files } = npmPackDryRun()
  const paths = files.map((f) => f.path)
  for (const p of paths) {
    assert.ok(!p.endsWith('.ts'), `源码 .ts 不应入包：${p}`)
    assert.ok(!p.startsWith('test/'), `dev 文件不应入包：${p}`)
    assert.ok(!p.startsWith('node_modules/'), `node_modules 不应入包：${p}`)
    assert.ok(!p.endsWith('.tgz'), `tarball 不应入包：${p}`)
  }
})

test('依赖接线（D5 + S6-T7 内嵌分发形态）：notegit-validation=构建输入（devDeps，编译内嵌 dist）、yaml=运行时依赖（vendored 副本消费），且不携带服务端私有依赖', () => {
  // S6-T7 起 validation 内嵌 CLI dist（master 裁定）：声明移至 devDependencies——
  // 发布产物自包含，npm install 不再从 registry 解析 notegit-validation（未发布，
  // 单 tarball 安装曾 E404）；yaml 由 vendored 副本在运行时消费，经 registry 正常安装。
  assert.equal((pkg.devDependencies as Record<string, string>)['notegit-validation'], '0.0.0')
  assert.equal(pkg.dependencies['yaml'], '2.9.1')
  const serverPrivate = ['fastify', '@node-rs/argon2']
  for (const dep of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]) {
    assert.ok(!serverPrivate.includes(dep), `服务端私有依赖不应出现在 CLI 依赖面：${dep}`)
  }
})

test('engines 声明 Node ≥22.13（D10 selection §6 CLI 分发承诺）', () => {
  assert.match(pkg.engines.node, /^>=22\.13/)
})

test('bin 映射名为 notegit 且指向分发产物 dist/bin/notegit.js（D10：npm 分发命令名）', () => {
  assert.equal(pkg.bin['notegit'], './dist/bin/notegit.js')
})
