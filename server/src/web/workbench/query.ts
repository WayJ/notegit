import type { DatabaseSync } from 'node:sqlite';
import { execGit } from '../../publish/git-exec.ts';
import { vaultRepoPath } from '../../vaults/repo-path.ts';
import type { RunGit } from '../browse/tree.ts';

/**
 * 工作台聚合查询面（S14-T1；DOD-E4-03 工作台查询面 / DOD-E4-04 路径级文档流）。
 *
 * 三个能力（纯查询、只读）：`workbenchSummary` 概览三卡数据、`vaultCards`
 * 库卡片、`recentDocuments` 路径级最近文档。本模块不产出 HTML、不写任何表
 * （延续 D7/D18 派生纪律：一切数据可从 Git 与审计全量重建，零新表、零 schema
 * 变更、零写操作）。
 *
 * ## 成员过滤（D26——聚合面安全不变量，D-IC-06 的延伸）
 *
 * 三个能力**全部**实时 JOIN `vault_members`，与 `search/query.ts`、
 * `activity/query.ts` 同一张表、同一判定面、无任何缓存：撤权 = DELETE 成员行，
 * 下一次查询立即消失（无缓存原则 D7/D-IC-05）。
 *
 * 关键约束：**统计数字与库卡片必须同源同过滤**——`workbenchSummary.publishedDocCount`
 * 就是 `vaultCards[].docCount` 的和，二者出自同一句成员 JOIN。若统计走另一条口径
 * （例如全库计数再按可见性呈现），无权库的存在性会由数字差值泄露（侧信道）。
 * 本模块以独立测试锁定该不变量。
 *
 * ## 排序与数据源（D25）
 *
 * `recentDocuments` 的排序键**只能是服务端审计时间 `audit_events.occurred_at`**
 * （可信身份、服务端时钟；occurred_at DESC, id DESC 决胜插入序）——**禁止**用
 * git 提交时间排序：git 的 author/committer 时间是客户端可填元数据（DOD-03），
 * 用它排序等于让客户端决定知识流次序。
 *
 * 路径**从每条事件的 `new_commit` 经 git 派生**（`git log --name-only -z`）——
 * 审计 `detail` 不写路径（当前发布面没有该字段，见 `activity/query.ts` 注），
 * 故路径级文档流不可能由事件行直接读出。
 *
 * ## 维护者字段语义（DOD-03 红线，reference-analysis §4.3 第 2 条）
 *
 * `RecentDocumentRow.author` / `authorIso` 来自 git 提交者（`%an` / `%aI`），
 * **是客户端可填的元数据，不是身份**。真正的操作主体是审计行的 `employee_id`
 * （服务端认证员工）。本模块的任何权限判定都不消费 author/authorIso——
 * 成员过滤只经 `vault_members` JOIN 完成，两者代码路径完全无交集。
 *
 * ## 取数口径自择（S14 计划「实现前自择并在报告说明」）
 *
 * - `docCount` / `publishedDocCount` = **`search_index` 行数**。选它而非 git tree
 *   计数：与 `/search` 命中面同一数据源（同一「已发布知识文档」口径）、纯 SQL 零
 *   spawn、且统计与卡片天然同源（同表同 JOIN，D26 结构性成立）。代价是索引存在延迟
 *   （架构 §9：索引延迟可观测，`search_index_state` 承载）——如实呈现由 S15 W05
 *   的索引新鲜度位承担，本模块不美化。
 * - `lastCommitAt` / `lastContentUpdateAt` = **成功发布审计事件的 MAX(occurred_at)**。
 *   未选 git 派生（`web/browse/tree.ts` LastCommitInfo 面）是因为：(a) 那需要按库
 *   逐个 spawn git 并把本模块改为 async，与任务卡给定的 `vaultCards(db, employeeId)`
 *   签名不符；(b) `%aI` 是客户端可填时间，用作「最后更新」会把客户端元数据升格为
 *   权威时间，与 D25/DOD-03 相悖；(c) 服务端审计时钟与本模块其余时间字段同源同可信。
 *   无提交/无发布事件的库如实为 `null`，不虚构。
 */

/** 最近文档表默认条数（呈现层可传别的上限；如实标注「最近 N 条」，不承诺分页） */
export const WORKBENCH_RECENT_DOC_LIMIT = 20;

/** 概览三卡数据（三个数字同出一句成员 JOIN——D26） */
export interface WorkbenchSummary {
  /** 可访问文库数 = 成员行数（无权库不计入） */
  readonly vaultCount: number;
  /** 已发布文档总数 = 成员库 search_index 行数之和（无权库的文档数绝不计入） */
  readonly publishedDocCount: number;
  /** 最近一次内容更新 = 成功发布事件 MAX(occurred_at)；无则 null（不虚构） */
  readonly lastContentUpdateAt: string | null;
}

/** 我的文库卡片数据（呈现层渲染用；查询面不含 HTML） */
export interface VaultCard {
  readonly slug: string;
  readonly name: string;
  /** 当前员工在该库的角色（vault_members.role，实时行） */
  readonly role: string;
  /** 该库已发布文档数（search_index 行数；与 publishedDocCount 同源） */
  readonly docCount: number;
  /** 最近一次成功发布时间（审计 occurred_at）；无提交/无发布为 null */
  readonly lastCommitAt: string | null;
}

/** 路径级最近文档行（跨库；D25） */
export interface RecentDocumentRow {
  readonly vaultSlug: string;
  readonly vaultName: string;
  /** 库内路径（从事件 new_commit 的 git 触及路径派生，非审计 detail） */
  readonly path: string;
  /** frontmatter title（派生索引；无 title 如实为 null，不用文件名伪造） */
  readonly title: string | null;
  readonly tags: readonly string[];
  /** 触发本次触及的发布事件 new_commit（锚点，与 /cite 同语义） */
  readonly commitOid: string;
  /**
   * Git 提交者名（`%an`）——**客户端可填元数据，不是身份**（DOD-03）。
   * 操作主体是审计行的认证员工；本字段不参与任何权限判定。
   */
  readonly author: string;
  /**
   * Git 提交者时间（`%aI`）——**客户端可填元数据，不是可信时间**（DOD-03）。
   * 可信排序/呈现时间是 `occurredAt`。本字段不参与任何权限判定。
   */
  readonly authorIso: string;
  /** 服务端审计时间（排序键；架构 §4.4 服务端时钟） */
  readonly occurredAt: string;
}

/** recentDocuments 的执行面参数（git 读取所需；测试以 runGit 注入） */
export interface RecentDocumentsOptions {
  /** 仓库根目录（→ vaultRepoPath 映射库 ID 到磁盘路径） */
  readonly dataDir: string;
  /** git 执行面注入缝（缺省 execGit；与 browse/tree.ts 同一缝，便于测试计数/伪造） */
  readonly runGit?: RunGit;
}

/**
 * 成员 JOIN 子句（三个能力共用的**唯一**过滤面）。
 *
 * `JOIN vault_members m ON m.<别名> = <库列> AND m.employee_id = ?` ——实时查表、
 * 无缓存（撤权下一次查询即消失，D-IC-05 精神）。
 *
 * @param vaultAlias 被过滤库的表别名（`v` 或 `i`/`a` 侧已 JOIN 的库）
 */
const MEMBER_JOIN = (alias: string): string => `
  JOIN vault_members m ON m.vault_id = ${alias}.id AND m.employee_id = ?`;

/** 发布事件成功终态子句（与 activity/query.ts 同一口径：只取 succeeded 发布行） */
const PUBLISH_SUCCESS = `a.event_kind IN ('vault.push','vault.web_submit') AND a.status = 'succeeded'`;

/**
 * 概览三卡数据：可访问库数 / 已发布文档总数 / 最近一次内容更新。
 *
 * 三个数字出自**同一次查询**（同一句成员 JOIN 聚合 + 逐库标量子查询），因此统计
 * 与库卡片结构性同源同过滤（D26）——无权库的库数与文档数都不计入，数字差值无法
 * 反推无权库的存在。
 *
 * 文档数与最近发布时间是**标量子查询**而非第二个 JOIN：同层 JOIN `search_index`
 * 与 `audit_events` 会产生笛卡尔积，`COUNT(i.path)` 会被放大（虚假的安全违规
 * 呈现数字）。标量子查询逐库独立求值，与 `vaultCards` 的同款语义恒等。
 */
export function workbenchSummary(db: DatabaseSync, employeeId: number): WorkbenchSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS vault_count,
              COALESCE(SUM((
                SELECT COUNT(*) FROM search_index i WHERE i.vault_id = v.id
              )), 0) AS doc_count,
              MAX((
                SELECT MAX(a.occurred_at) FROM audit_events a
                 WHERE a.vault_id = v.id AND ${PUBLISH_SUCCESS}
              )) AS last_update
       FROM vaults v
       ${MEMBER_JOIN('v')}`,
    )
    .get(employeeId) as
    | { vault_count: number; doc_count: number; last_update: string | null }
    | undefined;
  return {
    vaultCount: row?.vault_count ?? 0,
    publishedDocCount: row?.doc_count ?? 0,
    lastContentUpdateAt: row?.last_update ?? null,
  };
}

/**
 * 我的文库卡片：当前员工有权库的 slug/name/role/文档计数/最后提交时间。
 *
 * - 成员过滤实时 JOIN `vault_members`（无权库零出现，D26）。
 * - `docCount` 与 `workbenchSummary.publishedDocCount` 同源同过滤（同一
 *   search_index 计数语义），二者之和恒等（有独立测试锁定）。
 * - 排序按 slug 升序（确定性呈现；不是安全判定）。
 */
export function vaultCards(db: DatabaseSync, employeeId: number): VaultCard[] {
  const rows = db
    .prepare(
      `SELECT v.slug AS slug, v.name AS name, m.role AS role,
              (SELECT COUNT(*) FROM search_index i WHERE i.vault_id = v.id) AS doc_count,
              (SELECT MAX(a.occurred_at) FROM audit_events a
                WHERE a.vault_id = v.id AND ${PUBLISH_SUCCESS}) AS last_commit_at
       FROM vaults v
       ${MEMBER_JOIN('v')}
       ORDER BY v.slug`,
    )
    .all(employeeId) as unknown as {
    slug: string;
    name: string;
    role: string;
    doc_count: number;
    last_commit_at: string | null;
  }[];
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    role: r.role,
    docCount: r.doc_count,
    lastCommitAt: r.last_commit_at,
  }));
}

interface EventRow {
  vault_id: number;
  vault_slug: string;
  vault_name: string;
  occurred_at: string;
  new_commit: string | null;
}

interface TouchedCommit {
  readonly author: string;
  readonly authorIso: string;
  readonly paths: readonly string[];
}

/**
 * `git log --no-walk -1 -z --name-only --diff-filter=d --format=… <oid>` 输出解析。
 *
 * 沿用 `browse/tree.ts` 的 -z 记录/字段分隔手法：记录头以 `\x1e` 起、字段以 `\x1f`
 * 分隔、路径由 `-z` 以 NUL 终止（路径可含换行，不转义不歧义）。首个 NUL 之前是
 * 记录头（author/iso），其后是路径名单。
 *
 * `--diff-filter=d` 排除删除：被删除的路径不是「最近更新的文档」，呈现它会失真。
 * `--no-walk -1` 只看这一个提交（不遍历历史）。合并提交默认无路径名单，自然产出
 * 空集（发布面无合并提交——与 browse/tree.ts 同语义）。
 */
function parseTouched(out: string): TouchedCommit | null {
  const record = out.indexOf('\x1e');
  if (record === -1) return null;
  const rest = out.slice(record + 1);
  const headEnd = rest.indexOf('\0');
  // 无 NUL = 该提交无路径名单（合并提交/空提交）；仍取记录头以便如实区分
  const head = headEnd === -1 ? rest : rest.slice(0, headEnd);
  const [author, authorIso] = head.split('\x1f');
  if (author === undefined || author === '' || authorIso === undefined || authorIso === '') return null;
  const paths = headEnd === -1 ? [] : rest.slice(headEnd + 1).replace(/^\n/, '').split('\0');
  return {
    author,
    authorIso,
    paths: paths.filter((p) => p !== ''),
  };
}

/** git 已运行但退出非零（OID 不存在等）；spawn 层失败（仓库目录缺失）为 false */
function isGitExitFailure(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('git ');
}

/**
 * 路径级最近文档流（D25）：跨库最近发布事件所触及的**文档行**，按服务端审计
 * 时间新→旧，取最近 `limit` 条。
 *
 * - **排序键**：审计 `occurred_at DESC, id DESC`（服务端时钟；git 时间绝不参与排序）。
 * - **成员过滤**：查询实时 JOIN `vault_members`（无权库事件零出现）——**在取事件
 *   之前**过滤，因此无权库的提交路径根本不会被 git 读取（不过早求值、不泄露）。
 * - **路径派生**：每条事件的 `new_commit` 经 `git log --name-only -z` 解析触及路径；
 *   一个提交触达多路径即产出多行（同事件同 commitOid），直到凑满 `limit` 为止。
 * - **降级**：`new_commit` 为 NULL、OID 解析不到、仓库缺失/不可读、提交无路径
 *   名单——一律跳过该事件（或该事件零行），如实少呈现，不虚构、不崩溃。
 * - 事件扫描**上限**（`EVENT_SCAN_LIMIT`）：limit 是行数而非事件数，一个提交可能
 *   触及很多路径；为避免无界 spawn，事件扫描有界——超出上限即停止并如实少呈现
 *   （呈现层标注「最近 N 条」，不承诺分页）。
 */
const EVENT_SCAN_LIMIT = 200;

export async function recentDocuments(
  db: DatabaseSync,
  employeeId: number,
  limit: number = WORKBENCH_RECENT_DOC_LIMIT,
  opts: RecentDocumentsOptions,
): Promise<RecentDocumentRow[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];

  // 成员 JOIN 在取事件时就收窄：无权库事件不进候选，git 也不被调用
  const events = db
    .prepare(
      `SELECT a.vault_id AS vault_id, v.slug AS vault_slug, v.name AS vault_name,
              a.occurred_at AS occurred_at, a.new_commit AS new_commit
       FROM audit_events a
       JOIN vaults v ON v.id = a.vault_id
       ${MEMBER_JOIN('v')}
       WHERE ${PUBLISH_SUCCESS} AND a.new_commit IS NOT NULL
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(employeeId, Math.min(EVENT_SCAN_LIMIT, Math.max(limit * 20, limit))) as unknown as EventRow[];

  const runGit = opts.runGit ?? execGit;
  const rows: RecentDocumentRow[] = [];
  const indexCache = new Map<string, Map<string, { title: string | null; tags: readonly string[] }>>();

  for (const ev of events) {
    if (rows.length >= limit) break;
    let touched: TouchedCommit | null = null;
    try {
      const out = await runGit(
        [
          'log', '--no-walk', '-1', '-z', '--name-only',
          '--diff-filter=d', '--format=\x1e%an\x1f%aI', ev.new_commit as string,
        ],
        { cwd: vaultRepoPath(opts.dataDir, ev.vault_id) },
      );
      touched = parseTouched(out);
    } catch {
      touched = null; // OID 不存在 / 仓库缺失——如实跳过该事件
    }
    if (touched === null || touched.paths.length === 0) continue;

    let meta = indexCache.get(String(ev.vault_id));
    if (meta === undefined) {
      meta = new Map();
      for (const r of db
        .prepare('SELECT path, title, tags FROM search_index WHERE vault_id = ?')
        .all(ev.vault_id) as unknown as { path: string; title: string | null; tags: string }[]) {
        let tags: readonly string[] = [];
        try {
          const parsed: unknown = JSON.parse(r.tags);
          if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
        } catch {
          tags = []; // 畸形 tags 如实降级为空数组（不用字符串伪造）
        }
        meta.set(r.path, { title: r.title, tags });
      }
      indexCache.set(String(ev.vault_id), meta);
    }

    for (const p of touched.paths) {
      if (rows.length >= limit) break;
      const doc = meta.get(p);
      rows.push({
        vaultSlug: ev.vault_slug,
        vaultName: ev.vault_name,
        path: p,
        // 索引未命中（如尚未派生）时 title/tags 如实为空——不用文件名伪造 title
        title: doc?.title ?? null,
        tags: doc?.tags ?? [],
        commitOid: ev.new_commit as string,
        author: touched.author,
        authorIso: touched.authorIso,
        occurredAt: ev.occurred_at,
      });
    }
  }
  return rows;
}

/** 供测试与呈现层判定「git 执行失败 vs 空结果」的导出（语义说明面） */
export { isGitExitFailure };
