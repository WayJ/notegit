/**
 * S7-T8 静态红线：并发测试阶段禁再构建 dist（T4 挂账的 pack 竞态守卫）。
 *
 * 机制（T4 记录、sprint 计划 Wave 3 注）：`npm test` 的 `node --test` 阶段多测试文件
 * 并发执行；任何测试文件内 spawn `npm run build`（或经 `npm pack` 的 prepack 生命周期
 * 触发构建）都会与其余并发读取 dist/ 的测试文件（login/sync/docs 系）交叉重写
 * dist——半写状态被并发读者命中即瞬态失败（T1/T4/T6 各记录过一次，单跑皆过）。
 *
 * 约定（S6-T6 起 docs-flow-e2e / rules-version-consistency 已然遵循，本守卫固化为
 * 不变量）：构建只发生在 `npm test` 串行前置相（test 脚本里的 `npm run build`）；
 * 测试文件内的 `npm pack` 一律 `--ignore-scripts`（跳过 prepack=build，消费已构建
 * 的 dist）。违反即红：新增测试想构建时，先想清楚它在跟谁并发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = fileURLToPath(new URL('.', import.meta.url))

/** 抽取源文本中 spawn 系调用传给 npm 的参数表（本仓库统一 'npm' 单引号字面量风格）。 */
function npmArgLists(source: string): string[][] {
  const lists: string[][] = []
  for (const m of source.matchAll(/(?:spawnSync|spawn|execFile|execFileSync|exec)\(\s*'npm'\s*,\s*\[([^\]]*)\]/g)) {
    lists.push([...(m[1] as string).matchAll(/'([^']*)'/g)].map((a) => a[1] as string))
  }
  return lists
}

test('并发阶段禁构建：测试文件不得 spawn `npm run build`（构建属 npm test 串行前置相）', () => {
  for (const f of readdirSync(testDir).filter((n) => n.endsWith('.test.ts'))) {
    const lists = npmArgLists(readFileSync(path.join(testDir, f), 'utf8'))
    for (const args of lists) {
      const buildIdx = args.findIndex((a) => a === 'build')
      assert.ok(
        !(args[0] === 'run' && buildIdx !== -1),
        `${f} 在并发测试阶段 spawn 了 npm run build——dist 并发重建竞态（T4 挂账、T8 处置）；构建应在 npm test 前置相完成`,
      )
    }
  }
})

test('并发阶段禁 prepack：测试文件内 `npm pack` 必须带 --ignore-scripts（prepack=npm run build 同源竞态）', () => {
  for (const f of readdirSync(testDir).filter((n) => n.endsWith('.test.ts'))) {
    const lists = npmArgLists(readFileSync(path.join(testDir, f), 'utf8'))
    for (const args of lists) {
      if (args[0] === 'pack') {
        assert.ok(
          args.includes('--ignore-scripts'),
          `${f} 的 npm pack 缺 --ignore-scripts——prepack 生命周期会在并发阶段触发 npm run build（竞态同源）`,
        )
      }
    }
  }
})
