// S6-T7 内嵌打包（master 裁定的分发形态：validation 内嵌 CLI dist）——构建期
// vendor 步骤：notegit-validation 的产物组装（由 tsconfig.validation-dist.json 编译
// 到 dist/node_modules/notegit-validation/src 后运行）。选型记录见
// .agents/notes/2026-10-13-S6-T7-version.md：
//   - dist 复制（vendoring）而非 registry/bundle 依赖：notegit-validation 未发布
//     registry，npm install 无法解析；vendored 纯 JS 副本满足 Node ≥22.13（T1 实测
//     node_modules 下 .ts 类型剥离被 Node 拒绝）。
//   - 契约文件复制自唯一机器来源 docs/contracts/（validation §7.3 单一来源在构建
//     期的落地形态——不是第二份维护拷贝，产物与源的一致性由
//     cli/test/rules-version-consistency.test.ts 断言锁定）。
//   - vendored 包落位 dist/node_modules/：Node 解析器自 dist/src/** 向上走查自然
//     命中（不重写 import 说明符）；contract.ts 的相对定位
//     ../../../docs/contracts/ 恰指向 dist/docs/contracts/（本步骤复制目标）。
//   - yaml 经 cli dependencies 正常安装（npm 语义，不复制第三方代码进产物）。
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(cliDir, '..')
const validationPkg = JSON.parse(readFileSync(path.join(repoDir, 'packages/validation/package.json'), 'utf8'))
const vendoredDir = path.join(cliDir, 'dist/node_modules/notegit-validation')

// 1) vendored 包清单：只保留运行时必需字段（bin/engine 面不随 CLI 分发——那是
//    服务端 pre-receive 对 workspace 包的用法）。版本与 yaml 依赖取自源包单一来源。
const manifest = {
  name: validationPkg.name,
  version: validationPkg.version,
  type: 'module',
  exports: { '.': './src/index.js' },
  dependencies: { yaml: validationPkg.dependencies.yaml },
}
writeFileSync(path.join(vendoredDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// 2) 契约文件：validation 运行时读取面（contract.ts readContractJson 消费的两个文件）
mkdirSync(path.join(cliDir, 'dist/docs/contracts'), { recursive: true })
for (const name of ['rules-version.json', 'validation-defaults.json']) {
  copyFileSync(path.join(repoDir, 'docs/contracts', name), path.join(cliDir, 'dist/docs/contracts', name))
  JSON.parse(readFileSync(path.join(cliDir, `dist/docs/contracts/${name}`), 'utf8')) // 复制即解析自检
}

// 3) 自检：vendored 面纯 JS（.ts 混入即安装态必炸——T1 实测缺陷形态，测试亦断言）
const tsFiles = []
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (e.endsWith('.ts')) tsFiles.push(p)
  }
}
walk(path.join(vendoredDir, 'src'))
if (tsFiles.length > 0) {
  console.error(`vendor-validation: vendored 面混入 .ts（应为纯 JS 产物）：${tsFiles.join(', ')}`)
  process.exit(1)
}
// 成功静默：prepack 在 npm pack --json 内运行，stdout 混入会破坏 JSON 输出
//（pack.test.ts / rules-version-consistency.test.ts 均解析该输出）。
