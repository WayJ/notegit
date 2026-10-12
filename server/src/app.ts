import fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { PepperFile } from './bootstrap/pepper.ts';
import { isUninitialized } from './bootstrap/state.ts';
import { registerBootstrapRoutes } from './bootstrap/routes.ts';
import { registerInviteRoutes } from './invites/routes.ts';
import { hashPassword as defaultHashPassword } from './auth/password.ts';
import { credentialsPlugin } from './credentials/routes.ts';

/** 认证主体（identity §1：认证主体 = 员工账号）。 */
export interface Subject {
  readonly employee_id: number;
  readonly username: string;
  readonly is_instance_admin: boolean;
}

/**
 * 请求 → 认证主体 的解析缝。默认实现 fail-closed（恒 null → 401）：真实载体解析
 * （ngt_sid Cookie / Bearer ngt_，api.md §1）随 S2-T3/T5 落地后替换。凭据域路由在
 * 缝之外自备 Bearer ngt_ 解析（identity §3 的四状态精确 401 映射），并先试本缝——
 * 会话载体落地后 Cookie 认证的凭据自助操作即自动可用。
 */
export type SubjectResolver = (req: FastifyRequest) => Subject | null | Promise<Subject | null>;

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
  readonly resolveSubject?: SubjectResolver;
  readonly hashPassword?: PasswordHasher;
  readonly credentials?: CredentialsOptions;
  readonly logger?: FastifyServerOptions['logger'];
}

/** 已填默认值（fail-closed）的依赖，注册路由用。 */
export interface WiredAppDeps extends AppDeps {
  readonly resolveSubject: SubjectResolver;
  readonly hashPassword: PasswordHasher;
}

/**
 * 构建 Fastify v5 应用。无 deps = S2-T1 骨架形态（仅 /healthz）；带 deps = S2-T2 起
 * 业务形态：初始化态闸门（identity §7.1-1：未初始化时一切 /api/v1 业务入口 503
 * E-AUTH-007，仅 bootstrap 端点开放；/healthz 属基础设施放行）+ 身份域路由；
 * S2-T4 起含凭据域路由（api.md §4）。
 */
export function buildApp(deps?: AppDeps): FastifyInstance {
  const app = fastify({ logger: deps?.logger ?? false });
  app.get('/healthz', async () => ({ status: 'ok' }));

  if (deps) {
    const resolveSubject: SubjectResolver = deps.resolveSubject ?? (() => null);
    const hashPassword: PasswordHasher = deps.hashPassword ?? defaultHashPassword;
    const wired: WiredAppDeps = { ...deps, resolveSubject, hashPassword };

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

    registerBootstrapRoutes(app, wired);
    registerInviteRoutes(app, wired);
    app.register(credentialsPlugin, {
      db: wired.db,
      pepper: wired.pepper,
      resolveSubject: wired.resolveSubject,
      now: wired.credentials?.now,
      maxCredentialsPerEmployee: wired.credentials?.maxCredentialsPerEmployee,
      maxTokenLifetimeDays: wired.credentials?.maxTokenLifetimeDays,
    });
  }
  return app;
}
