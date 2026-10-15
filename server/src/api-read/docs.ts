import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { extractFrontmatter } from 'notegit-validation';
import { authorize, rejectAuth, type AuthSuccess, type RequestAuthenticator, type VaultScope } from '../auth/lifecycle.ts';
import { createDbMembershipSource } from '../vaults/membership.ts';
import { VaultService } from '../vaults/service.ts';
import { vaultRepoPath } from '../vaults/repo-path.ts';
import { readBlobText } from '../web/browse/tree.ts';
import { readEntryAtCommit } from '../web/history/version.ts';
import { resolveRefCommit } from './tree.ts';

/**
 * S18-T2 文档读取端点（agent 读协议 v1 机器面——E6 R01/D36/D38，S18 D2/D3）：
 *
 * GET /api/v1/vaults/{slug}/docs/{path}[?ref=<commit OID>] → 200
 * `{vault, path, ref, commit_oid, frontmatter, body, body_raw, size_bytes, fetched_at}`。
 *
 * - ref 语义与 tree 端点同判（D38，resolveRefCommit 单一实现）：缺省=默认分支
 *   HEAD；只收 commit OID；hex 未知 404 反存在性、分支名 400。历史 blob 走
 *   version 页同一读取面（readEntryAtCommit——同一棵树、鉴权同源）。
 * - 字段（D3）：body=frontmatter 剥离后正文（闭合 --- 之后原文——与 view/
 *   version/search body 同一切面）、body_raw=原文（双字段给全，不预设消费方）；
 *   size_bytes=原始字节数；fetched_at=服务端响应时刻（ISO 8601，不可信为内容
 *   时间——内容时间锚=commit_oid）。
 * - frontmatter 三态如实：闭合块且保守行式解析成功 → 对象（title/tags/…）；
 *   无块（README 等豁免/无 frontmatter）或块未闭合或块解析失败（畸形）→
 *   null + body=原文全量（畸形不阻断读取——读取面不做发布校验）。
 * - 仅 .md（与页面族同判）：其余类型 415 E-RES-009 如实（v1 不提供；码随建议稿
 *   docs/s18/api-amendments.md 提议注册）。目录路径/不存在路径/未知 OID 一律
 *   404 E-RES-001 同信封（D-IC-06）。
 * - 协商缓存（D2）：ETag=`"<commit OID>"` + no-cache，If-None-Match 304；锚定
 *   ref 的 ETag 恒定，HEAD 缺省随提交前进即时失效（S16 热修同构）。
 * - 认证/授权与 tree 端点同构（匿名 401；read 门槛+token scope 收窄；无权=
 *   不存在 404 同信封；GET 免 CSRF；只读无审计行；写通道零变更）。
 *
 * D1 文件所有权：本文件归 S18-T2（与 api-read/vaults.ts、api-read/tree.ts 各自
 * 独立；resolveRefCommit 复用同任务 tree.ts 导出——T2 内部共享面）。
 */

export type DocsReadRouteOptions = {
  readonly db: DatabaseSync;
  readonly authenticateRequest: RequestAuthenticator;
  readonly dataDir?: string;
};

/** 去除成对包裹引号（YAML 双/单引号标量的常见形态——derive.ts 同式） */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]!;
    const last = value[value.length - 1]!;
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** 流式序列 `[a, "b c"]` → 字符串数组；非括号包裹返回 null（调用方按标量处理） */
function parseFlowSeq(inline: string): string[] | null {
  if (!inline.startsWith('[') || !inline.endsWith(']')) return null;
  const inner = inline.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => unquote(item.trim())).filter((item) => item !== '');
}

/**
 * frontmatter 块的保守行式解析（search/derive.ts 同哲学：不引 YAML 依赖、罕见
 * 合法形态如实降级）。块内每行只接受三种形态：`key: 标量`、`key:`（块式序列
 * 起）与其下的缩进 `- 项`；块标量指示符（`|`/`>`）、其他缩进续行（嵌套映射/
 * 折叠标量）、无所属键的序列项——一律返回 null（调用方按「畸形」降级：
 * frontmatter=null + body=原文全量）。
 */
export function parseFrontmatterFields(blockText: string): Record<string, string | string[]> | null {
  const result: Record<string, string | string[]> = {};
  let pendingListKey: string | null = null;
  for (const line of blockText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue; // 空行/注释跳过（不打断块式序列）
    const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (keyMatch !== null) {
      const key = keyMatch[1]!;
      const inline = keyMatch[2]!.trim();
      if (inline === '') {
        pendingListKey = key; // 块式序列起始（值待后续 `- 项` 填充）
        continue;
      }
      if (inline === '|' || inline === '>' || (inline.startsWith('[') && !inline.endsWith(']'))) return null;
      pendingListKey = null;
      const flow = parseFlowSeq(inline);
      result[key] = flow ?? (key === 'tags' ? [] : unquote(inline)); // tags 非序列形态如实空（发布面本不该出现）
      continue;
    }
    const itemMatch = /^[ \t]+-[ \t]+(.*)$/.exec(line);
    if (itemMatch !== null) {
      if (pendingListKey === null) return null; // 序列项无所属键
      const existing = result[pendingListKey];
      if (existing !== undefined && !Array.isArray(existing)) return null;
      const arr = existing ?? [];
      const value = unquote(itemMatch[1]!.trim());
      if (value !== '') arr.push(value);
      result[pendingListKey] = arr;
      continue;
    }
    return null; // 缩进续行（嵌套映射等）或未知形态——保守放弃
  }
  if (pendingListKey !== null && result[pendingListKey] === undefined) result[pendingListKey] = [];
  return result;
}

/** frontmatter 三态切块（畸形/null 态 body=原文全量；合法态 body=闭合 --- 之后） */
function splitFrontmatter(text: string): { frontmatter: Record<string, string | string[]> | null; body: string } {
  const fm = extractFrontmatter(text);
  if (fm.kind !== 'block') return { frontmatter: null, body: text }; // 无块（豁免）/未闭合——原文全量
  const fields = parseFrontmatterFields(fm.blockText ?? '');
  if (fields === null) return { frontmatter: null, body: text }; // 闭合块解析失败（畸形）——原文全量
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).split('\n');
  return { frontmatter: fields, body: lines.slice(fm.closeLine).join('\n') };
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function sendNotFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, 'E-RES-001', '资源不存在或无权访问');
}

export function registerDocsReadRoutes(app: FastifyInstance, opts: DocsReadRouteOptions): void {
  const vaults = new VaultService({ db: opts.db }); // 只读消费（getVaultRow）
  const membershipSource = createDbMembershipSource(opts.db); // 三入口同源成员判定

  /** 认证 + read 门槛（与 tree.ts 同构——D1 各模块自持，避免跨任务共享文件） */
  async function requireReadVault(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<{ who: AuthSuccess; vault: { id: number; slug: string; defaultBranch: string } } | null> {
    const outcome = await opts.authenticateRequest(req);
    if (!outcome.ok) return rejectAuth(reply, outcome), null;
    const who: AuthSuccess = outcome;
    const scope: VaultScope | undefined =
      who.carrier === 'token' && who.token !== undefined
        ? { access: who.token.scopeAccess, vaultIds: who.token.scopeVaultIds }
        : undefined;
    const decision = authorize(membershipSource, who.subject.employee_id, slug, 'read', scope);
    if (!decision.allowed) return sendNotFound(reply), null;
    const row = vaults.getVaultRow(slug);
    if (!row) return sendNotFound(reply), null; // fail-closed
    return { who, vault: { id: row.id, slug: row.slug, defaultBranch: row.default_branch } };
  }

  app.get('/api/v1/vaults/:slug/docs/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const { slug } = req.params as { slug: string };
    const guard = await requireReadVault(req, reply, slug);
    if (!guard) return reply;
    const { vault } = guard;
    if (opts.dataDir === undefined) {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库存储未挂接——仅测试形态会出现）' } });
    }
    const entryPath = (((req.params as Record<string, string>)['*'] ?? '')).replace(/\/+$/, '');
    const rawRef = (req.query as { ref?: unknown }).ref;
    if (rawRef !== undefined && typeof rawRef !== 'string') {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：ref 必须为 commit OID 字符串');
    }
    const ref = typeof rawRef === 'string' && rawRef !== '' ? rawRef : undefined;
    const repoPath = vaultRepoPath(opts.dataDir, vault.id);
    const resolved = await resolveRefCommit(repoPath, vault.defaultBranch, ref);
    if (resolved.kind === 'bad-shape') {
      return sendError(reply, 400, 'E-RES-004', '请求形态错误：ref 只支持 commit OID（分支名等 rev 形态 v1 不支持——D38）');
    }
    if (resolved.kind === 'not-found') return sendNotFound(reply);
    if (resolved.kind === 'unavailable') {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库目录缺失或读取失败）' } });
    }
    // version 页同一读取面（同一棵树——历史 blob 鉴权同源，D38）
    const read = await readEntryAtCommit(opts.dataDir, vault.id, resolved.commitOid, entryPath);
    if (read.kind === 'unavailable') {
      return reply.code(503).send({ error: { message: '内容暂不可用（仓库目录缺失或读取失败）' } });
    }
    if (read.kind !== 'ok' || read.entry.type !== 'blob') return sendNotFound(reply); // 未知 OID 已前置；目录/缺失路径反存在性
    const { entry } = read;
    if (!entry.name.toLowerCase().endsWith('.md')) {
      return sendError(reply, 415, 'E-RES-009', '仅提供 Markdown 知识文档（.md）的读取——其余类型 v1 不提供');
    }
    let text: string;
    try {
      text = await readBlobText(opts.dataDir, vault.id, entry.oid);
    } catch {
      return reply.code(503).send({ error: { message: '内容暂不可用（正文读取失败）' } });
    }
    const { frontmatter, body } = splitFrontmatter(text);
    const etag = `"${read.commitOid}"`;
    reply.header('cache-control', 'no-cache').header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send({
      vault: vault.slug,
      path: entryPath,
      ref: ref ?? vault.defaultBranch,
      commit_oid: read.commitOid,
      frontmatter,
      body,
      body_raw: text,
      size_bytes: entry.size ?? 0,
      fetched_at: new Date().toISOString(),
    });
  });
}
