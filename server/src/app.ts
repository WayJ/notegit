import fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { PepperFile } from './bootstrap/pepper.ts';
import { isUninitialized } from './bootstrap/state.ts';
import { registerBootstrapRoutes } from './bootstrap/routes.ts';
import { registerInviteRoutes } from './invites/routes.ts';
import { registerAuth } from './auth/routes.ts';
import { createRequestAuthenticator, type RequestAuthenticator } from './auth/lifecycle.ts';
import { csrfGuard } from './auth/csrf.ts';
import { hashPassword as defaultHashPassword } from './auth/password.ts';
import { CredentialsService } from './credentials/service.ts';
import { credentialsPlugin } from './credentials/routes.ts';
import { createDbMembershipSource } from './vaults/membership.ts';
import { VaultService } from './vaults/service.ts';
import { vaultsPlugin } from './vaults/routes.ts';
import { draftsPlugin } from './drafts/routes.ts';
import { createVaultRepoOps } from './gitrepo/lifecycle.ts';
import { gitHttpPlugin } from './githttp/http-backend.ts';
import { createGitChildGate, effectiveGitLimits } from './limits/git-gate.ts';
import { createMaintenanceGate, maintenanceGuard } from './maintenance/gate.ts';
import { registerMaintenanceRoutes } from './maintenance/routes.ts';
import { registerRulesVersionRoutes } from './rulesversion/routes.ts';
import { registerSearchRoutes } from './search/routes.ts';
import { registerApiReadVaultRoutes } from './api-read/vaults.ts';
import { SearchIndexer } from './search/indexer.ts';
import { registerTreeReadRoutes } from './api-read/tree.ts';
import { registerDocsReadRoutes } from './api-read/docs.ts';
import { registerAuditQueryRoutes } from './audit/routes.ts';
import { metricsCollector } from './metrics/collector.ts';
import { registerMetricsRoutes } from './metrics/routes.ts';
import { registerWebRoutes } from './web/routes.ts';

/** 认证主体（identity §1：认证主体 = 员工账号）。 */
export interface Subject {
  readonly employee_id: number;
  readonly username: string;
  readonly is_instance_admin: boolean;
}

/** 口令哈希（identity §2/D-IC-02）：默认 Argon2id（m=19456,t=2,p=1，src/auth/password.ts，
 *  S2-T2 落地、S2-T3 复用）；可注入替换（测试用桩加速）。 */
export type PasswordHasher = (password: string) => Promise<string>;

/** 凭据域可调项（identity §3.3/§3.5：上限默认值可配；now 注入供测试控时） */
export interface CredentialsOptions {
  readonly now?: () => string;
  readonly maxCredentialsPerEmployee?: number;
  readonly maxTokenLifetimeDays?: number;
}

export interface AppDeps {
  readonly db: DatabaseSync;
  readonly pepper: PepperFile;
  readonly bootstrapTokenFile: string;
  /** 请求级认证缝（S2-T5 统一）：Bearer/会话双载体 + 四状态精确 401 映射
   *  （auth/lifecycle.ts）。默认接真实载体；注入覆盖（测试用桩）。 */
  readonly authenticateRequest?: RequestAuthenticator;
  readonly hashPassword?: PasswordHasher;
  readonly credentials?: CredentialsOptions;
  readonly logger?: FastifyServerOptions['logger'];
  /** 数据目录（S3-T1）：注入后建库端点真实 init bare 于 <dataDir>/git/<id>.git；
   *  缺省 = S2 测试形态（仅建行）。生产装配（main.ts）恒传入。
   *  S3-T2：注入后同时注册 /git Smart HTTP 入口（CGI 包装 git http-backend）。 */
  readonly dataDir?: string;
  /** 库文件路径（S3-T2）：透传 NOTEGIT_DB 给 pre-receive hook 子进程直连；
   *  缺省则 /git 推送在 hook 处 fail-closed（读路径不受影响）。main.ts 恒传入。 */
  readonly dbFile?: string;
  /** 搜索索引器可调项（S5-T3；dataDir 注入时生效）：pollMs 节奏 / derive 注入
   *  （失败注入测试缝）/ now 控时 / log 收集。缺省全默认（250ms 或
   *  NOTEGIT_SEARCH_POLL_MS）。 */
  readonly searchIndex?: {
    pollMs?: number;
    derive?: (repoPath: string, branch: string) => Promise<import('./search/derive.ts').DerivedIndex>;
    now?: () => Date;
    log?: import('./search/indexer.ts').SearchLog;
  };
}

/** 已填默认值的依赖，注册路由用。 */
export interface WiredAppDeps extends AppDeps {
  readonly authenticateRequest: RequestAuthenticator;
  readonly hashPassword: PasswordHasher;
}

/**
 * 构建 Fastify v5 应用。无 deps = S2-T1 骨架形态（仅 /healthz）；带 deps = S2-T2 起
 * 业务形态：初始化态闸门（identity §7.1-1：未初始化时一切 /api/v1 业务入口 503
 * E-AUTH-007，仅 bootstrap 端点开放；/healthz 属基础设施放行）+ 身份域路由；
 * S2-T4 起含凭据域路由（api.md §4）。S2-T5 起：单一凭据域服务实例同时喂
 * 路由与认证缝（token 四状态映射唯一来源）。
 */
export function buildApp(deps?: AppDeps): FastifyInstance {
  const app = fastify({ logger: deps?.logger ?? false });
  app.get('/healthz', async () => ({ status: 'ok' }));

  if (deps) {
    const credentialsService = new CredentialsService({
      db: deps.db,
      pepper: deps.pepper,
      now: deps.credentials?.now,
      maxCredentialsPerEmployee: deps.credentials?.maxCredentialsPerEmployee,
      maxTokenLifetimeDays: deps.credentials?.maxTokenLifetimeDays,
    });
    // 真实载体解析（S2-T5 统一，auth/lifecycle.ts）：Bearer（显式头凭据，优先）+
    // ngt_sid 会话 Cookie；四状态精确映射 E-AUTH-001..004。注入可覆盖（测试用桩）。
    // pepper 传版本化文件（S2-T8）：会话校验含 retired 键 + rehash-on-use（identity §6.2）。
    const authenticateRequest: RequestAuthenticator =
      deps.authenticateRequest ??
      createRequestAuthenticator({
        db: deps.db,
        pepper: deps.pepper,
        authenticateToken: (token) => credentialsService.authenticate(token),
      });
    const hashPassword: PasswordHasher = deps.hashPassword ?? defaultHashPassword;
    const wired: WiredAppDeps = { ...deps, authenticateRequest, hashPassword };

    // 非法 JSON 等解析错误 → 400 E-RES-004（api.md §2.3）；其余错误交回 Fastify 默认处理
    app.setErrorHandler((err: Error & { code?: string }, _req, reply) => {
      if (err.code?.startsWith('FST_ERR_CTP') || err instanceof SyntaxError) {
        return reply.code(400).send({ error: { code: 'E-RES-004', message: '请求形态错误（非法 JSON）' } });
      }
      return reply.send(err); // 默认语义（404/500 保持原状态码）
    });

    // 维护模式写闸门（S2-T7；backup-recovery §3）：进程内同步标志（传播上界 0），
    // 全局 onRequest 第一位（api.md §10 组装序：maintenance → …），先于路由解析——
    // 未来「写」端点自动被覆盖。运行态写入（登录/登出/维护生命周期）放行。
    const maintenanceGate = createMaintenanceGate();
    app.addHook('onRequest', maintenanceGuard(maintenanceGate));

    // 初始化态闸门：未初始化 ⇒ 一切 /api/v1 业务入口 503（未来任务的路由自动被覆盖）
    app.addHook('onRequest', async (req, reply) => {
      const p = req.url.split('?')[0];
      if (p === '/api/v1/auth/bootstrap' || !p.startsWith('/api/v1')) return;
      if (isUninitialized(wired.db)) {
        return reply.code(503).send({ error: { code: 'E-AUTH-007', message: '实例未初始化：业务入口不可用，仅 bootstrap 端点开放' } });
      }
    });

    // CSRF 同源校验（identity §4 + api.md §1；E-AUTH-006）：会话 Cookie 认证的
    // 状态改变请求校验 Origin（缺失回退 Referer）同源；Bearer/头凭据豁免。
    // 挂在初始化闸门之后（api.md §10 组装序：闸门 → CSRF → 认证 → 路由）。
    app.addHook('onRequest', csrfGuard);

    // S8-T2 认证失败计数（identity §8：「不逐条入审计，以失败计数指标呈现」的
    // 替代呈现挂接点）：应用级 onResponse 钩子按 401 响应归因——凡统一认证缝判
    // E-AUTH-001..004 的 401 都计入（api/web/git 三入口分桶）；429 限速、403
    // 授权拒绝等非认证失败不计。进程内运行态计数（metrics/collector.ts）。
    app.addHook('onResponse', async (req, reply) => {
      if (reply.statusCode !== 401) return;
      const p = req.url.split('?')[0]!;
      metricsCollector.recordAuthFailure(p.startsWith('/git') ? 'git' : p.startsWith('/api') ? 'api' : 'web');
    });

    registerBootstrapRoutes(app, wired);
    registerInviteRoutes(app, wired);
    // S2-T7 维护模式生命周期端点（POST/DELETE /api/v1/admin/maintenance；实例管理员）；
    // 切换记 maintenance.enable/disable 审计行（运行态写入，闸门 allowlist 放行自身）
    registerMaintenanceRoutes(app, {
      db: wired.db,
      gate: maintenanceGate,
      authenticateRequest: wired.authenticateRequest,
    });
    // S2-T3 认证域路由（api.md §3：login/logout/me/password/PATCH admin employees）；
    // S2-T5 起认证缝统一（/me 与 /me/password 双载体，api.md §3 错误列 001–004）；
    // S2-T8 起 pepper 传版本化文件（会话 retired 校验 + rehash-on-use，identity §6.2）
    void app.register(registerAuth, {
      db: deps.db,
      pepper: deps.pepper,
      authenticateRequest: wired.authenticateRequest,
    });
    // S2-T4 凭据域路由（api.md §4：自助+管理员代管）；S2-T5 起共享服务实例与统一认证缝
    app.register(credentialsPlugin, {
      db: wired.db,
      service: credentialsService,
      authenticateRequest: wired.authenticateRequest,
    });
    // S2-T6 库与成员域路由（api.md §5）：授权经共用 authorize（auth/lifecycle.ts ×
    // vaults/membership.ts 真实表 MembershipSource）——Web/API 入口共用，Git 入口
    // （S3）消费同一源与组件。S3-T1：dataDir 注入时挂真实 bare 仓库生命周期
    app.register(vaultsPlugin, {
      service: new VaultService({ db: wired.db, ...(deps.dataDir ? { repoOps: createVaultRepoOps(deps.dataDir) } : {}) }),
      authenticateRequest: wired.authenticateRequest,
      membershipSource: createDbMembershipSource(wired.db),
    });
    // S18-T1 机器面读协议（E6 D36/D37；api.md §3 建议稿 docs/s18/api-amendments.md）：
    // GET /api/v1/vaults（清单 +doc_count——路由自 vaultsPlugin 迁入，D1 文件所有权）
    // + GET /api/v1/vaults/{slug}/index-status（search_index_state 逐库行）。只读。
    registerApiReadVaultRoutes(app, { db: wired.db, authenticateRequest: wired.authenticateRequest });
    // S4-T6 草稿域路由（api.md §7）：按作者私有 CRUD + 发布后状态流转面；
    // 授权经同一 authorize/membershipSource（三入口同源），维护/CSRF 由 app 级
    // 闸门自动覆盖（gate.ts 注记明列「草稿」写端点）。
    app.register(draftsPlugin, {
      db: wired.db,
      authenticateRequest: wired.authenticateRequest,
    });
    // S5-T3 搜索索引器（dataDir 注入时接线）：进程内异步——审计尾随（push 的
    // settle 钩子与网页发布共用触发面）+ 启动对账（崩溃兜底）；失败不阻断发布
    // （D7），只记 state 告警字段与日志。定时器 unref（不独自维持事件循环），
    // app.close() 经 onClose 排空在途工作（不留后台未决写）。
    const searchIndexer =
      deps.dataDir !== undefined
        ? new SearchIndexer({ db: deps.db, dataDir: deps.dataDir, ...(deps.searchIndex ?? {}) })
        : undefined;
    if (searchIndexer !== undefined) {
      searchIndexer.start();
      app.addHook('onClose', async () => {
        await searchIndexer.stop();
      });
    }
    // S5-T3 最小可观测端点：GET /api/v1/admin/search-index（实例管理员）——延迟
    // 指标/时间戳/失败告警/实时新鲜度 + S5-T4 查询端点：GET /api/v1/search?q=
    // （任意认证员工，成员关系实时过滤——两端点 api.md 均未入册，D11 建议稿
    // docs/s1/ C2/C3，表行待 D13 由 master 落）
    registerSearchRoutes(app, {
      db: wired.db,
      authenticateRequest: wired.authenticateRequest,
      ...(searchIndexer !== undefined ? { indexer: searchIndexer } : {}),
    });
    // S18-T2 agent 读协议 v1（E6 机器面，读 JSON）：GET /api/v1/vaults/{slug}/tree
    // 与 /docs/{path}（D1 文件所有权 api-read/{tree,docs}.ts——T2 持两行；
    // T1 的 api-read/vaults.ts 注册行自持，互不改他人行）。认证走统一缝
    // （匿名 401），授权 authorize read + token scope 收窄（无权=不存在 404
    // D-IC-06）；GET 免 CSRF；只读无审计行；写通道零变更。
    registerTreeReadRoutes(app, {
      db: wired.db,
      authenticateRequest: wired.authenticateRequest,
      dataDir: deps.dataDir,
    });
    registerDocsReadRoutes(app, {
      db: wired.db,
      authenticateRequest: wired.authenticateRequest,
      dataDir: deps.dataDir,
    });
    // S19-T1 审计查询两端点（api.md §9 契约在册）：GET /api/v1/vaults/{slug}/audit
    // （库管理员或实例管理员）+ GET /api/v1/admin/audit（实例管理员，vault 过滤）。
    // 只读零写：GET 免 CSRF、维护模式读放行（app 级闸门）、不记审计行。
    registerAuditQueryRoutes(app, { db: wired.db, authenticateRequest: wired.authenticateRequest });
    // S2-T8 最小页面 + S4 浏览族（/login、/、/admin、/credentials、/vaults…——GET
    // 外壳/数据页；页面无写操作，安全判定全部在 API 侧复用 authorize/管理员门槛）。
    // S4-T1 骨架裁决：web 域此后只在 server/src/web/ 内 append 模块，本调用是
    // 唯一接入点（dataDir 供目录浏览/预览读 bare 仓库；缺省 = S2 测试形态）。
    registerWebRoutes(app, {
      db: wired.db,
      authenticateRequest: wired.authenticateRequest,
      dataDir: deps.dataDir,
      maintenanceGate, // S4-T5 缝：web 写操作（upload/rename/delete/未来 edit POST）维护模式 503（backup §3 web 行）
    });
    // S6-T7 规则版本元信息端点（api.md §3.3 补录；ADR 由 master 落）：
    // GET /api/v1/rules-version → 200 {rulesVersion, status}，需认证（统一缝双载体）；
    // 值经 notegit-validation 运行时读 rules-version.json（validation §7.3 单一来源，
    // 与 pre-receive 同机制）——CLI version-probe（S6-T4）的激活端点
    registerRulesVersionRoutes(app, { authenticateRequest: wired.authenticateRequest });
    // S8-T2 运维指标面（实例管理员；架构 §10 最低清单）：GET /api/v1/admin/metrics
    // ——磁盘水位（/data 四分域）、失败推送/校验失败计数（审计面计数来源）、校验
    // 耗时分布、认证失败计数、备份完成时间预留。api.md 未入册（D11 模式——建议稿
    // docs/s1/metrics-face-amendments.md，master 随 D 批落）。只读：无审计行。
    registerMetricsRoutes(app, {
      db: wired.db,
      authenticateRequest: wired.authenticateRequest,
      ...(deps.dataDir !== undefined ? { dataDir: deps.dataDir } : {}),
    });
    // S3-T2 Git Smart HTTP 入口（api.md §8.4）：CGI 包装 git http-backend，认证
    // 经 Basic→token（同一凭据域服务）、授权经同一 authorize/membershipSource、
    // 维护模式 write 403——与 Web/API 三入口共用组件；dataDir 注入时注册。
    // S8-T8：每请求 git 子进程并发闸门（git.maxConcurrentChildren，FIFO 排队，
    // 容量热生效）在此装配并挂观察缝 app.childProcessGate（测试与未来指标接线）。
    if (deps.dataDir !== undefined) {
      const childProcessGate = createGitChildGate(() => effectiveGitLimits({ db: deps.db }).maxConcurrentChildren);
      app.childProcessGate = childProcessGate;
      app.register(gitHttpPlugin, {
        dataDir: deps.dataDir,
        dbFile: deps.dbFile,
        membershipSource: createDbMembershipSource(deps.db),
        authenticateToken: (token) => credentialsService.authenticate(token),
        maintenanceGate,
        childProcessGate,
        db: deps.db, // S3-T6：receive 子进程退出后的中断清扫（pending → 待核对）
      });
    }
  }
  return app;
}
