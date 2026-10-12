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
    const authenticateRequest: RequestAuthenticator =
      deps.authenticateRequest ??
      createRequestAuthenticator({
        db: deps.db,
        pepper: deps.pepper.active.key,
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

    registerBootstrapRoutes(app, wired);
    registerInviteRoutes(app, wired);
    // S2-T3 认证域路由（api.md §3：login/logout/me/password/PATCH admin employees）；
    // S2-T5 起认证缝统一（/me 与 /me/password 双载体，api.md §3 错误列 001–004）
    void app.register(registerAuth, {
      db: deps.db,
      pepper: deps.pepper.active.key,
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
    // （S3）消费同一源与组件
    app.register(vaultsPlugin, {
      service: new VaultService({ db: wired.db }),
      authenticateRequest: wired.authenticateRequest,
      membershipSource: createDbMembershipSource(wired.db),
    });
  }
  return app;
}
