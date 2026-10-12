import type { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';
import { readSidCookie } from './subject.ts';

/**
 * CSRF 同源校验（identity §4 + api.md §1 定稿；E-AUTH-006）：
 * 凡**会话 Cookie 认证的状态改变请求**（非 GET/HEAD/OPTIONS 且携带 ngt_sid）校验
 * 同源头——`Origin`（缺失时回退 `Referer` 的 origin 部分）与请求目标
 * （scheme + host + port，默认端口归一）同源，否则 403。
 *
 * 回退链（api.md §1「缺失回退链明确」，S2-T5 定稿）：
 *   Origin 在场 → 以 Origin 判定（无论 Referer）；
 *   Origin 缺失 → Referer 在场 → 以 Referer 的 origin 部分判定；
 *   两者皆缺失 → 无法确立同源 → 403（同源浏览器对非安全方法必带 Origin；
 *   程序化客户端应改用 Bearer——豁免面见下）。
 *
 * 豁免（api.md §1「Bearer 认证的请求不依赖环境凭据」）：
 *   - 安全方法（GET/HEAD/OPTIONS）；
 *   - 携带 `Authorization` 头（显式头凭据，跨站页面无法注入自定义头，CORS 预检拦截）；
 *   - 未携带 ngt_sid 的请求（非会话 Cookie 认证，如登录、口令重置消费端点）。
 *
 * 判定依据是「请求呈现了会话 Cookie」而非「会话有效」——跨站请求带的是受害者的
 * 有效 Cookie，校验先于（且独立于）会话有效性。
 */

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;

/** URL/头值的 origin 归一：scheme://host[:port]，http:80 / https:443 视同省略；
 *  不可解析 → null（无法确立同源）。 */
function normalizedOriginOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const defaultPort = (u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443');
  const port = u.port === '' || defaultPort ? '' : `:${u.port}`;
  return `${u.protocol}//${u.hostname}${port}`;
}

/** 请求目标 origin：protocol + Host 头（Fastify inject 默认 http + localhost:80） */
function targetOriginOf(req: FastifyRequest): string | null {
  const host = req.headers.host;
  if (host === undefined) return null;
  return normalizedOriginOf(`${req.protocol}://${host}`);
}

/** 请求声称的来源：Origin 优先，缺失回退 Referer 的 origin 部分；皆缺失 → null */
function claimedOriginOf(req: FastifyRequest): string | null {
  const origin = req.headers.origin;
  if (origin !== undefined) return normalizedOriginOf(origin);
  const referer = req.headers.referer;
  if (referer !== undefined) return normalizedOriginOf(referer);
  return null;
}

/** onRequest 钩子本体（buildApp 于初始化态闸门之后挂载——api.md §10 组装序） */
export async function csrfGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if ((SAFE_METHODS as readonly string[]).includes(req.method)) return;
  if (req.headers.authorization !== undefined) return; // 显式头凭据豁免（Bearer/Basic…）
  if (readSidCookie(req) === null) return; // 未呈现会话 Cookie
  const target = targetOriginOf(req);
  const claimed = claimedOriginOf(req);
  if (target === null || claimed === null || claimed !== target) {
    return reply.code(403).send({
      error: { code: 'E-AUTH-006', message: 'CSRF 同源校验失败：Origin/Referer 与请求目标不同源或缺失' },
    });
  }
}

/** 注册便捷面（独立实例或测试直接挂载用；buildApp 内以 addHook 挂同一钩子） */
export function registerCsrfGuard(app: FastifyInstance): void {
  app.addHook('onRequest', csrfGuard);
}
