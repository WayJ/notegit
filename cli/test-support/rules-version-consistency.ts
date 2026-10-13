/**
 * 构建断言核心（S6-T7；breakdown §2.5 S6-T7 行、sprint 场景 S5、validation §7.3）：
 * CLI 内嵌 rulesVersion 与唯一机器来源（docs/contracts/rules-version.json）的一致性
 * 判定与失败提示。三端一致 = CLI 内嵌 == manifest == 服务端端点响应——本断言锁
 * 「CLI 内嵌 == manifest」链；服务端链在 server/test/rules-version-routes.test.ts
 * （端点响应 == manifest 文件直读）。MAJOR 漂移（validation §7.2 情形 C）提示三端
 * 同步升级；其余漂移提示重新构建（构建从 docs/contracts 复制单一来源，漂移即产物
 * 过期）；不可解析 fail-closed（不可比不等于一致）。
 *
 * 测试支撑件（不入分发产物——cli/package.json files 白名单只含 dist/ 与 README）。
 * SemVer 比较复用产品实现 compareRulesVersions（S6-T4，已有单测），不另写一份。
 */
import { compareRulesVersions } from '../src/lint/version-probe.ts'

/** 漂移判定（两段核心之外先看 MAJOR）：比较结果只给 -1/0/1，定位漂移级别需拆核心段。 */
function majorOf(v: string): string {
  return v.split('-')[0]!.split('.')[0]!
}

/**
 * 断言两端规则版本一致；不一致即抛错（构建/测试失败），文案区分：
 * - MAJOR 漂移 → 三端必须同步升级（服务端与全部分发物一起，validation §7.2 情形 C）；
 * - 其余漂移 → 重新构建 CLI dist（npm run build 从 docs/contracts 复制单一来源）；
 * - 不可按 SemVer 解析 → fail-closed 失败。
 */
export function assertSameRulesVersion(embedded: string, manifest: string): void {
  if (embedded === manifest) return
  const cmp = compareRulesVersions(embedded, manifest)
  if (cmp === null) {
    throw new Error(
      `规则版本无法按 SemVer 比较（validation.md §7.1 形态）：CLI 内嵌 ${JSON.stringify(embedded)} vs manifest ${JSON.stringify(manifest)}——` +
        `请核对 docs/contracts/rules-version.json 与 CLI 构建产物后重新构建。`,
    )
  }
  if (majorOf(embedded) !== majorOf(manifest)) {
    throw new Error(
      `MAJOR 漂移：CLI 内嵌规则版本 ${embedded} 与 manifest ${manifest} 的 MAJOR 不一致——` +
        `MAJOR 属破坏性变更，三端（CLI/hook/服务端）必须同步升级（validation.md §7.2 情形 C），` +
        `同步 rules-version.json 后重新构建 CLI（npm run build）并升级服务端。`,
    )
  }
  throw new Error(
    `规则版本不一致（非 MAJOR）：CLI 内嵌 ${embedded} vs manifest ${manifest}——` +
      `重新构建 CLI dist（npm run build 从 docs/contracts/rules-version.json 复制单一来源）。`,
  )
}
