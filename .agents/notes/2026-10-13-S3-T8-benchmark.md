# 2026-10-13 S3-T8 Q7 第一轮基准 — validation-defaults.json 建议值实测校正

Orca dispatch `ctx_e87eab5178d5`（task_c531fa82a198，branch `WayJ/s3-t8-limits`）。任务依据：implementation-breakdown §2.2 S3-T8 第 4 项「以 Q2 部署规格跑一轮基准，记录实测值 vs 默认值，产出修订建议」。语义来源（只读）：validation-defaults.json、validation.md §5/§7.2/§9、roadmap Q7/Q2 行、selection.md §5–§6。本文为 **第一轮**（S3 实现期）；S8 终值校正在真实用量下进行（validation.md §9 Q7 开放项）。

## 1. 环境（Q2 部署规格的本机容器化身）

| 项 | 值 | 对 Q2 规格的符合性 |
|---|---|---|
| 容器 | Docker 29.5.2，`node:24-alpine`（未装 git——基准只测校验器成本，无 git 依赖用例） | Q2 基础镜像 ✓ |
| CPU | `--cpus=1`（地板）/ `--cpus=2`（推荐）两轮 | Q2 地板 1 vCPU + 推荐 2 vCPU ✓ |
| 内存 | `--memory=512m --memory-swap=512m`（地板）/ `1g`（推荐） | Q2 地板 512MB + 推荐 1GB ✓ |
| 架构 | linux/arm64（宿主 Apple Silicon） | Q2 目标 x86_64/arm64 之 arm64 ✓ |
| Node | v24.21.0（容器内） | D10 Node 24 ✓ |
| 被测 | packages/validation @ rulesVersion 1.0.0-draft.1（本 worktree），基准脚本直接 import 包源码 | 三端单一来源本体 ✓ |

基准脚本（`bench.mjs`/`bench2.mjs`，随 run 原样保留于本文附录；运行形态 `docker run --rm --cpus=N --memory=M -v <repo>:/repo -v <bench>:/bench node:24-alpine node bench.mjs`）。方法学要点：预热一次再计时（JIT/模块初始化不计入）；单文档多轮取均值；批量用例单轮计时（量级 >秒）；`web-submit` scope（与 pre-receive 同一 processFile 链路）；文档负载为中英混排知识文档（含合规 frontmatter 与库内相对链接），分链接密度档。

## 2. 实测数据（JSON 原始输出摘录）

### 地板规格（1 vCPU / 512MB）

| case | 结果 |
|---|---|
| env 基线 | RSS 78MB（进程空载+包加载） |
| 单文档 10KB | 0.91ms |
| 单文档 100KB（稀疏链接） | 51.17ms |
| 单文档 1MiB（稠密链接 ~13k 条） | **3135ms**（worst-case 负载） |
| 附件 1MiB / 10MiB | 0.18ms / 0.09ms（仅计量+清单判定，内容不解析）；RSS 增量 ~10–20MB/缓冲 |
| 批量 100×1MiB 稠密链接（默认运行时限制） | 12.6s → **E-RUN-001 超时**（exitCode 2，fail-closed） |
| 并发 4 路 ×（20×100KiB 稀疏） | 单路 636ms；四路并行墙钟 2562ms（≈4× 单路——见 §3.5 语义澄清） |
| 库容量 walk 10k 松对象（39MiB） | 20.4ms |
| 库容量 walk 50k 松对象（195MiB） | 131.5ms |
| 链接密度 1MiB（0 / 120 / 704 条链接） | 1.61ms / 27.01ms / 154.43ms |
| 批量 100×100KiB 稀疏链接 | 131.6ms（pass） |

### 推荐规格（2 vCPU / 1GB）

单文档 1MiB 稠密 3128.88ms、批量 100×1MiB 12.6s（E-RUN-001）、并发四路墙钟 2491.97ms——**与地板规格几乎逐项相同**（原因见 §3.5：单进程内 JS 单线程，「并发」是交错排队而非并行；--cpus 提升不加速单线程 CPU 工作）。

### 文本压缩比（maxPushBytes 口径推算用，宿主 git 实测）

100 篇互异中文知识文档（4.4MB 工作区）→ git pack 332KiB ≈ **13x**；自然文本经验区间 **3–13x**（重复度越高压缩越好、但展开校验成本照付）。50MiB 默认 push 上限 ⇒ 展开文本 ≈ 150–650MiB。

## 3. 逐默认值分析与修订建议

**结论：本轮建议全部默认值维持不变（无 B1/B2 变更提议）**——实测表明建议值在 Q2 地板规格上对现实负载自洽；病态负载以可理解错误（E-RUN-001/E-LIMIT-00x，含 limit/limitKey）干净拒绝，属设计行为。四个 watch item 与一项优化机会记 §5，S8 以真实用量终值校正。

| 键 | 默认值 | 实测判定 | 建议 |
|---|---|---|---|
| maxDocumentBytes | 1 MiB | 现实文档（≤1 链接/8KB）27ms/篇；病态稠密（~13k 链接）3.1s/篇——单篇仍 < 10s 超时 | **维持** |
| maxAttachmentBytes | 10 MiB | 判定成本 ~0.1ms、内存增量 10–20MB/缓冲；10MiB 附件 × 4 并发对 512MB 地板无压力 | **维持** |
| attachmentAllowedExtensions | 6 项清单 | 无性能维度（安全边界键；svg 排除维持） | **维持** |
| maxPushBytes | 50 MiB | 传输字节口径（T6 计量 CONTENT_LENGTH/chunked 计数）。展开文本 150–650MiB ⇒ 现实稀疏链接校验 4–18s：3–5x 压缩比的现实推送 4–7s < 10s 超时；>10x 压缩比（高度重复文本）可能触超时——E-RUN-001 可理解可分批。⚠️ 运维注记：Q2 假设「每库工作副本 ≤500MB」，全量初始导入（≈150–250MiB 压缩）超 50MiB——**初始导入指引：管理员经 app_settings 临时调高（热生效），完成后回落**（运维指引入交付文档，S8/交付材料任务） | **维持**（附导入指引） |
| vaultCapacityBytes | 5 GiB | walk 成本：50k 松对象 132ms；5GiB 全松小对象外推 ≈3.4s/push（worst）。T8 落地的启动 prune 持续压低松对象数；pack 主导的现实库（几百个大文件）walk 毫秒级 | **维持**（watch §5-3） |
| additionalNavPatterns / specialFilePatterns | [] / 2 项 | 接受集语义键，无资源维度（触发测试覆盖接受集变化） | **维持** |
| validationTimeoutMs | 10000ms | 现实余量：50MiB 上限推送 × 现实压缩比 4–7s ✓；4 路并发现实负载墙钟 ~2.5s ✓；病态稠密批量 12.6s ✗ 触发（设计行为） | **维持**（watch §5-1/2） |
| maxConcurrentValidations | 4 | 地板与推荐规格同值（§3.5）——不构成超时风险放大器；pre-receive 每推送一进程（闸门计 1，跨进程天然由容器 CPU 配额约束），web 提交进程内排队 | **维持** |
| maxValidationMemoryMb | 256 MiB | 进程 RSS 口径（粗粒度上界）：地板实测基线 78–160MB；100×1MiB 批量入口 RSS ~120MB（未触 256 上限——超时先行）。512MB 地板容器下 256MB 阈值给 node 基线留有余量 | **维持**（watch §5-4） |

### 3.5 语义澄清（记录为 T8 裁决的一部分）

单进程内的 maxConcurrentValidations 是**排队闸门不是并行度**（JS 单线程：地板与推荐规格逐项同值即实证）。其价值：① 限制同时在途的校验状态（内存驻留）与交错深度；② web 提交入口的背压。git 推送的并行约束由「每推送一 hook 进程 + 容器 CPU 配额」承担（闸门在 hook 进程内计 1，恒放行）。两入口叠加后地板规格 1 vCPU 的实际并行度 ≈1，推荐规格 ≈2（进程级）。

## 4. 修订建议的版本化路径（B1/B2 纪律）

本轮**无默认值变更**——不触发 rules-version changelog。若 S8 终值校正需变更：判定型键（limits/exemptions）按 validation.md §7.2 B1（收紧/安全放宽=MAJOR，非安全放宽=MINOR）；运维型键（runtime）按 B2（任何调整=MINOR）；一律走 rules-version.json changelog 记旧值→新值。**本记录即 open 项**：Q7 保持 open 至 S8 终值（roadmap Q7 行）；validation-defaults.json 的 status 维持 suggested（契约只读，修订属 master）。

## 5. Watch items（S8 校正输入）

1. **W-LINK-101 的 lineOfIndex 二次项**：行号定位对每个链接做 O(文本长度) 扫描——成本 ≈ 链接数 × 文档长度（实测 0/120/704 链接 ⇒ 1.6/27/154ms；13k 链接 ⇒ 3.1s）。优化机会（预控行号索引一次、O(1) 查询）属性能优化非契约变更，S8 视真实负载决定；在此之前病态稠密文档由超时兜底。
2. **超时与 push 上限的交互**：压缩比 >10x 的 50MiB 推送可能 E-RUN-001（可理解、可分批）。若 S8 真实用量频繁触达，优先考虑 ①（消除二次项）而非调值。
3. **measureVaultBytes 全目录 walk**：松对象数线性；启动 prune 已落地压制，5GiB 全松对象 worst ~3.4s/push。S8 若实际库达 GB 级可换 count-objects 或缓存（T6 notes 既留路径）。
4. **maxValidationMemoryMb 的进程 RSS 口径**：入口单点检查、以进程整体 RSS 近似单次校验占用——地板 512MB 容器下阈值 256MB 与 node 基线（78–160MB）的间隔偏窄的边缘形态（多路大附件并发）值得 S8 在真实用量下复核。

## 6. 复现（附录：基准脚本）

运行：`docker run --rm --cpus=1 --memory=512m --memory-swap=512m -v <repo>:/repo -v <bench-dir>:/bench -w /bench node:24-alpine node bench.mjs`（bench2.mjs 同法）。脚本与本记录同 commit 存档（`.bench-tmp/` 临时目录随任务清理——以本附录为准）。

### bench.mjs（主轮：吞吐/附件/批量/并发/walk）

```js
import { validate, defaultConfig, rulesVersion } from '/repo/packages/validation/src/index.ts';
import { readdirSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const out = (name, data) => console.log(JSON.stringify({ case: name, ...data }));
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
const FM = '---\ntitle: Bench\nowner: bench\ndescription: 摘要\nsource: web\n---\n\n';
function makeDoc(sizeBytes) {
  const para = '知识条目正文段落，包含中文与 English 混排，链接 [相关](./other.md) 与引用。'.repeat(8);
  let body = '';
  while (Buffer.byteLength(FM + body, 'utf8') < sizeBytes) body += para + '\n';
  return FM + body;
}
async function runValidate(files, { config } = {}) {
  const t0 = process.hrtime.bigint();
  const r = await validate({ scope: 'web-submit', vaultId: 'bench', files, knownPaths: files.map((f) => f.path), ...(config ? { config } : {}) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms: Math.round(ms * 100) / 100, result: r.result, exitCode: r.exitCode, runIssue: r.issues?.[0]?.code, rssMb: rssMb() };
}
out('env', { node: process.version, platform: `${process.platform}/${process.arch}`, rssBaselineMb: rssMb(), rulesVersion: rulesVersion(), cpus: (await import('node:os')).cpus().length, defaults: defaultConfig() });
for (const kb of [10, 100, 1024]) {
  const doc = makeDoc(kb * 1024);
  await validate({ scope: 'web-submit', vaultId: 'bench', files: [{ path: 'docs/warm.md', mode: '100644', content: doc }] });
  out('doc-validate', { sizeKb: kb, bytes: Buffer.byteLength(doc), ...await runValidate([{ path: `docs/bench-${kb}k.md`, mode: '100644', content: doc }]) });
}
for (const mb of [1, 10]) {
  const buf = new Uint8Array(mb * 1024 * 1024).fill(0x89);
  out('attachment-validate', { sizeMb: mb, ...await runValidate([{ path: `assets/bench-${mb}m.png`, mode: '100644', content: buf }]) });
}
{
  const docs = Array.from({ length: 100 }, (_, i) => ({ path: `docs/bulk-${i}.md`, mode: '100644', content: makeDoc(1024 * 1024) }));
  out('bulk-100x1mib-default-memory', { rssBeforeMb: rssMb(), ...await runValidate(docs) });
  out('bulk-100x1mib-raised-memory', { ...await runValidate(docs, { config: { maxValidationMemoryMb: 2048 } }) });
}
{
  const files = Array.from({ length: 20 }, (_, i) => ({ path: `docs/conc-${i}.md`, mode: '100644', content: makeDoc(100 * 1024) }));
  const single = await runValidate(files);
  const t0 = process.hrtime.bigint();
  await Promise.all([1, 2, 3, 4].map(() => validate({ scope: 'web-submit', vaultId: 'bench', files })));
  out('concurrency-4x20docs', { singleRunMs: single.ms, fourParallelWallMs: Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100, rssMb: rssMb() });
}
{
  const vaultDir = '/tmp/bench-vault';
  const walk = (dir, inObjects) => {
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (inObjects && e.name.startsWith('incoming-')) continue;
      const child = path.join(dir, e.name);
      if (e.isDirectory()) total += walk(child, inObjects || e.name === 'objects');
      else if (e.isFile()) total += statSync(child).size;
    }
    return total;
  };
  for (const n of [10_000, 50_000]) {
    rmSync(vaultDir, { recursive: true, force: true });
    const objDir = path.join(vaultDir, 'objects');
    const perShard = Math.ceil(n / 256);
    let made = 0;
    const payload = Buffer.alloc(4096, 1);
    for (let s = 0; s < 256 && made < n; s++) {
      const shard = path.join(objDir, s.toString(16).padStart(2, '0'));
      mkdirSync(shard, { recursive: true });
      for (let f = 0; f < perShard && made < n; f++) { writeFileSync(path.join(shard, `obj-${f}-${made}`), payload); made++; }
    }
    const t0 = process.hrtime.bigint();
    const bytes = walk(vaultDir, false);
    out('vault-walk', { files: made, totalMiB: Math.round(bytes / 1048576), ms: Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100 });
  }
  rmSync(vaultDir, { recursive: true, force: true });
}
```

### bench2.mjs（链接密度维度）

```js
import { validate } from '/repo/packages/validation/src/index.ts';
const out = (name, data) => console.log(JSON.stringify({ case: name, ...data }));
const FM = '---\ntitle: Bench\nowner: bench\ndescription: 摘要\nsource: web\n---\n\n';
function makeDoc(sizeBytes, linkEveryBytes) {
  const plain = '知识条目正文段落，包含中文与 English 混排，阐述概念与操作步骤。'.repeat(8);
  const linked = plain + '相关条目参见 [相关](./other.md)。';
  let body = '', sinceLink = 0;
  while (Buffer.byteLength(FM + body, 'utf8') < sizeBytes) {
    if (linkEveryBytes > 0 && sinceLink >= linkEveryBytes) { body += linked + '\n'; sinceLink = 0; }
    else { body += plain + '\n'; sinceLink += 800; }
  }
  return FM + body;
}
for (const [label, every] of [['no-links', 0], ['sparse-8k', 8192], ['dense-800', 800]]) {
  const doc = makeDoc(1020 * 1024, every); // 1MiB 上限内留余量
  const files = [{ path: `docs/d-${label}.md`, mode: '100644', content: doc }];
  await validate({ scope: 'web-submit', vaultId: 'b', files });
  const t0 = process.hrtime.bigint();
  const r = await validate({ scope: 'web-submit', vaultId: 'b', files });
  out('link-density-1mib', { density: label, links: (doc.match(/\]\(\.?\/?/g) ?? []).length, ms: Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100, result: r.result });
}
{
  const docs = Array.from({ length: 100 }, (_, i) => ({ path: `docs/s-${i}.md`, mode: '100644', content: makeDoc(100 * 1024, 8192) }));
  const t0 = process.hrtime.bigint();
  const r = await validate({ scope: 'web-submit', vaultId: 'b', files: docs });
  out('bulk-100x100kib-sparse', { ms: Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100, result: r.result, exitCode: r.exitCode });
}
```

压缩比实测（宿主 git，100 篇互异中文文档）：`git init → 写 4.4MB docs → commit → git gc → git count-objects -vH` ⇒ size-pack 332KiB ≈ 13x；自然文本经验区间 3–13x。
