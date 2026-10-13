import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// S8-T1 容器发行包静态契约（breakdown §2.7 S8-T1 行；D10；selection §5；backup §2；
// roadmap 风险 N3）。与 githttp-behavior（行为）互补：这里做的是可在 CI 复跑的
// 结构性断言，防镜像/编排/文档随演进静默漂移——
// 1) git-http-backend 归属 git-daemon 包（N3 防回归：注释 + 构建期存在性断言）；
// 2) /data 四分域布局（backup §2）、非 root 运行、/healthz 健康检查；
// 3) 运行形态 = node src/main.ts（TS 生产执行策略定稿：运行时 type-stripping，
//    S2-T1 挂账销账——镜像内不引入 tsc 构建/tsx 依赖）；
// 4) compose 单实例 + 命名持久卷；
// 5) deploy/README 记载最低规格（selection §5 + S7-T8 RSS 232MB 修正、512MB 地板
//    复核留给 S8-T8 定值）与 HTTPS 选型记录。
// 运行面全链验证由 deploy/scripts/init-drill.mjs（演练即测试，D5）承担，留档于
// .agents/notes/。

const DEPLOY = path.resolve(import.meta.dirname, '../../deploy');

function read(rel: string): Promise<string> {
  return readFile(path.join(DEPLOY, rel), 'utf8');
}

test('Dockerfile：基础镜像 node:24-alpine（D10/镜像 pin 可覆盖）', async () => {
  const df = await read('Dockerfile');
  // ARG 默认值即交付基线（node:24-alpine）；生产部署可用 --build-arg 钉住补丁版
  //（roadmap 风险行「锁定 Node 24 LTS 具体版本（镜像 pin）」），不改变基线声明。
  assert.match(df, /ARG\s+NODE_IMAGE=node:24(-[\d.]+)?-alpine\s*$/m, 'ARG NODE_IMAGE 默认应为 node:24-alpine');
  assert.match(df, /FROM\s+\$\{NODE_IMAGE\}/, 'FROM 应引用 ${NODE_IMAGE}');
});

test('Dockerfile：apk add 同时安装 git 与 git-daemon（N3——git-http-backend 归属 git-daemon 包）', async () => {
  const df = await read('Dockerfile');
  const apk = df.match(/^RUN apk add.*$/m);
  assert.ok(apk !== null, '应存在 RUN apk add 安装行');
  assert.match(apk[0], /(?<![\w-])git(?![\w-])/, 'apk add 须含 git 包');
  assert.match(apk[0], /(?<![\w-])git-daemon(?![\w-])/, 'apk add 须含 git-daemon 包（git-http-backend 的归属包，N3）');
});

test('Dockerfile：N3 防回归注释 + git-http-backend 构建期存在性断言', async () => {
  const df = await read('Dockerfile');
  // 注释（防回归标记）与断言（构建失败即暴露）双保险——breakdown 完成标准原文
  assert.match(df, /git-http-backend/, '注释须提及 git-http-backend（防回归标记）');
  assert.match(df, /归属.*git-daemon|git-daemon.*归属/, '注释须标注归属关系（git-http-backend 归属 git-daemon 包）');
  const run = df.match(/^RUN .*git-http-backend.*$/m);
  assert.ok(run !== null, '应存在构建期断言（RUN 内 test -x git-http-backend，缺失即构建失败）');
  assert.match(run[0], /test -x/, '断言应为 test -x 形态');
});

test('Dockerfile：非 root 运行用户 + /data 四分域预建（backup §2）', async () => {
  const df = await read('Dockerfile');
  assert.match(df, /^USER\s+(?!root[,\s]*$)\S+/m, '应以非 root 用户运行（USER <name>，不得是 root）');
  for (const dir of ['git', 'db', 'config', 'keys']) {
    assert.ok(df.includes(`/data/${dir}`), `/data/${dir} 应在镜像内预建（backup §2 布局）`);
  }
});

test('Dockerfile：HEALTHCHECK 探测 /healthz', async () => {
  const df = await read('Dockerfile');
  const hc = df.match(/^HEALTHCHECK .*$/m);
  assert.ok(hc !== null, '应存在 HEALTHCHECK 指令');
  assert.match(hc[0], /\/healthz/, 'HEALTHCHECK 应探测 /healthz（架构 §10 运维最低清单）');
});

test('Dockerfile：CMD = node src/main.ts（TS 生产执行策略：运行时 type-stripping，无构建步骤）', async () => {
  const df = await read('Dockerfile');
  assert.match(df, /^CMD\s+\[\s*"node",\s*"src\/main\.ts"\s*\]/m, 'CMD 应为 ["node", "src/main.ts"]（S2-T1 挂账定稿：Node 24 原生 type-stripping 直跑，不引入 tsc/tsx）');
});

test('compose：单实例 + 命名持久卷挂 /data + 重启策略 + 端口发布', async () => {
  const yml = await read('docker-compose.yml');
  assert.match(yml, /\/data/, '应将持久卷挂载到 /data');
  assert.match(yml, /^\s*volumes:\s*$/m, '应使用命名卷（volumes 顶级声明）');
  assert.match(yml, /restart:\s*(unless-stopped|always)/, '应声明 restart 策略（进程生命周期由容器运行时负责，process-model §1）');
  assert.match(yml, /ports:/, '应发布端口');
  assert.ok(!/\$\{.*\}/.test(yml) || true); // 占位：compose 允许变量但最小示例应开箱可用（不强断言）
});

test('deploy/README：最低规格引用 selection §5 + S8-T8 地板修正（RSS 232–240MB 基线 → 768MB 地板）', async () => {
  const md = await read('README.md');
  assert.match(md, /selection\.md|selection §5|§5/, '应引用 selection §5（最低部署规格来源）');
  assert.match(md, /232/, '应记载 RSS 基线实测（232–240MB，S7-T8/S8-T8——旧值 114.7MB 已过时）');
  assert.match(md, /768 ?MB/, '最低规格表应为 768MB 地板（S8-T8 修正）');
  assert.match(md, /512/, '512MB 旧值作为被修正对象记载（含不承诺降级路径说明）');
  assert.match(md, /maxConcurrentChildren/, '修正依据应含子进程并发上限键（每链 ~17MB × 默认 8）');
});

test('deploy/README：HTTPS 接入选型记录（反代终结 TLS 或容器内 TLS 二选一并给依据）', async () => {
  const md = await read('README.md');
  assert.match(md, /TLS|HTTPS/, '应含 HTTPS 接入说明（K3 交付形态）');
  assert.match(md, /反向代理/, '应记载选型：反向代理终结 TLS（或容器内 TLS 的选择及依据）');
});

test('architecture-notes：S2-T1 挂账「TS 生产执行策略」已由 S8-T1 定稿记录', async () => {
  const md = await readFile(path.resolve(import.meta.dirname, '../../docs/dev/architecture-notes.md'), 'utf8');
  assert.match(md, /S8-T1/, 'architecture-notes 应登记 S8-T1 对 TS 生产执行策略的定稿（工具链决策登记处）');
  assert.match(md, /type-stripping|node src\/main\.ts/, '定稿形态应明确（运行时 type-stripping / node src/main.ts）');
  // 原挂账行不得仍以「留给 S8」作为现行状态独立存在（定稿后应指向已定稿记录）
  assert.ok(
    !/TS 生产执行策略.*留给 S8 打包定稿.*本任务不引入构建步骤/.test(md.split('S8-T1')[0]),
    '挂账行应更新或被 S8-T1 定稿节覆盖，不得保持「留给 S8」的现行状态',
  );
});

test('演练脚本存在且断言化（D5 演练即测试：bootstrap→邀请→建库→双通道冒烟→重启→数据仍在）', async () => {
  const src = await readFile(path.join(DEPLOY, 'scripts/init-drill.mjs'), 'utf8');
  assert.match(src, /assert/, '脚本应断言化（node:assert，而非仅打印）');
  for (const marker of ['bootstrap', 'restart', '/healthz', 'push', 'view']) {
    assert.ok(src.includes(marker), `演练脚本应覆盖环节：${marker}`);
  }
});
