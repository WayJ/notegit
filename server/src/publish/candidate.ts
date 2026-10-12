import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileInput } from 'notegit-validation';
import { execGit } from './git-exec.ts';

/**
 * 候选提交构造（S3-T7；架构 §5.4「根据 base commit 构造的完整候选提交」、§9
 * 「Web 编辑使用候选 Git tree / commit……不能在服务端全局 checkout」）：
 * base commit + 变更清单 → 候选 tree/commit，全 git plumbing、全异步：
 *
 *   ls-tree（基线路径）→ hash-object -w --stdin（blob）→ 请求级临时 index
 *   （GIT_INDEX_FILE=os.tmpdir 独立文件——请求间互不覆盖）read-tree/update-index
 *   → write-tree → commit-tree -F -（身份/时间戳经 env 注入——服务端归因）。
 *
 * 语义裁决：
 * - **mode 不预过滤**：非常规 mode（120000 symlink/160000 gitlink）原样进 tree，
 *   由共享校验器按 E-PATH-002/003 拒绝——判定唯一来源在校验器（sprint D7），
 *   且与 push 入口同构（push 的 tree 条目同样到达校验器才被拒）。
 * - **删除不进 changedFiles**（validation.md §2.5：删除不做元数据校验）；
 *   但删除不存在的基线路径 = 变更清单与基线不一致，构造期拒绝（push 无此形态
 *   ——git 客户端不可能产生；web 输入需要显式防护）。
 * - **失败留痕形态**：blob/tree/commit 经 -w 落库后才校验；校验拒绝时对象成为
 *   无引用松对象（git gc 域，非半写——单对象原子写入），refs 不动。与 push 的
 *   quarantine 语义差异：push 由 receive-pack 隔离，web 无在途批量对象。
 * - **确定性**：committedAt 注入 GIT_AUTHOR_DATE/GIT_COMMITTER_DATE——同输入
 *   同时间 → 同 OID（审计可复现）；缺省服务端时钟。
 * - 临时 index 放 os.tmpdir（不进库目录——E-LIMIT-005 的库容量口径不因发布
 *   在途而虚增），finally 删除。
 */

export interface WebSubmitUpsert {
  readonly kind: 'upsert';
  readonly path: string;
  /** Git tree 条目 mode（八进制字符串）——非常规 mode 交由校验器拒绝（见文件头） */
  readonly mode: string;
  readonly content: string | Uint8Array;
}

export interface WebSubmitDelete {
  readonly kind: 'delete';
  readonly path: string;
}

/** web 提交变更清单（S4 草稿的可提交投影：新增/修改/删除） */
export type WebSubmitChange = WebSubmitUpsert | WebSubmitDelete;

/** 提交身份（服务端注入；审计主体=认证员工不信 commit author——identity §8） */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface CandidateInput {
  /** bare 仓库目录（经 vaultRepoPath 映射；不拼接用户输入） */
  readonly repoPath: string;
  /** 预期旧 commit（null = 空库根提交） */
  readonly baseCommit: string | null;
  readonly changes: readonly WebSubmitChange[];
  readonly message: string;
  readonly identity: CommitIdentity;
  /** 提交时间（ISO；缺省服务端当前时钟） */
  readonly committedAt?: string;
}

export interface CandidateResult {
  readonly commitOid: string;
  readonly treeOid: string;
  /** 基线 tree 全路径（变更前） */
  readonly baseTreePaths: readonly string[];
  /** 候选 tree 全路径（变更后）——E-PATH-004 基线与链接存在性（knownPaths）输入 */
  readonly candidateTreePaths: readonly string[];
  /** 相对基线的新增/修改（校验器 FileInput；删除不进） */
  readonly changedFiles: readonly FileInput[];
  /** 删除的路径 */
  readonly deletedPaths: readonly string[];
}

interface TreeLine {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

/** `ls-tree -r -z` 解析：`<mode> SP <type> SP <oid>\t<path>` NUL 分隔记录 */
function parseLsTree(out: string): TreeLine[] {
  const entries: TreeLine[] = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) throw new Error(`ls-tree 记录缺少路径分隔：${record.slice(0, 80)}`);
    const meta = record.slice(0, tab).split(' ');
    if (meta.length !== 3) throw new Error(`ls-tree 记录元数据畸形：${record.slice(0, 80)}`);
    entries.push({ mode: meta[0]!, type: meta[1]!, oid: meta[2]!, path: record.slice(tab + 1) });
  }
  return entries;
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

/**
 * 候选提交构造（异步；任何 git 失败/输入畸形 reject——调用方 fail-closed，
 * 不发布、草稿保留）。base commit 对象不在库内同样拒绝（不信任客户端声明的基线）。
 */
export async function buildCandidateCommit(input: CandidateInput): Promise<CandidateResult> {
  const repo = { cwd: input.repoPath };

  // ── 基线解析 ─────────────────────────────────────────────────────────────
  let baseTreeLines: TreeLine[] = [];
  if (input.baseCommit !== null) {
    // rev-parse --verify：base commit 对象须真实存在于库内（防客户端伪造基线）
    await execGit(['rev-parse', '--verify', '--quiet', `${input.baseCommit}^{commit}`], repo).catch(() => {
      throw new Error(`base commit ${input.baseCommit} 不在库内（候选构造拒绝——不信任客户端声明的基线）`);
    });
    baseTreeLines = parseLsTree(await execGit(['ls-tree', '-r', '-z', input.baseCommit], repo));
  }
  const basePaths = new Set(baseTreeLines.map((e) => e.path));

  // ── 变更清单一致性（构造期防护，见文件头语义裁决）────────────────────────
  if (input.changes.length === 0) throw new Error('变更清单为空（web 提交至少一条变更）');
  const seen = new Set<string>();
  for (const change of input.changes) {
    if (seen.has(change.path)) throw new Error(`变更清单路径重复：${change.path}（同路径多条命令）`);
    seen.add(change.path);
    if (change.kind === 'delete' && !basePaths.has(change.path)) {
      throw new Error(`删除路径不在基线 tree 中：${change.path}（变更清单与基线不一致）`);
    }
  }

  // ── blob 写入（hash-object -w --stdin：字节精确，二进制安全）──────────────
  const blobOf = new Map<string, string>(); // path → blob OID
  for (const change of input.changes) {
    if (change.kind !== 'upsert') continue;
    const oid = (await execGit(['hash-object', '-w', '--stdin'], { ...repo, stdin: toBuffer(change.content) })).trim();
    blobOf.set(change.path, oid);
  }

  // ── 请求级临时 index → write-tree（§9：请求间隔离，不共享 checkout）──────
  const indexPath = path.join(tmpdir(), `notegit-web-index-${randomUUID()}`);
  const idxEnv = { GIT_INDEX_FILE: indexPath };
  try {
    if (input.baseCommit === null) {
      await execGit(['read-tree', '--empty'], { ...repo, env: idxEnv });
    } else {
      await execGit(['read-tree', input.baseCommit], { ...repo, env: idxEnv });
    }
    for (const change of input.changes) {
      // --index-info 是 bare 库可用的 plumbing 形态（--cacheinfo 需工作树）；
      // 删除记录 mode=0 + 全零 OID（git-update-index 文档格式）
      const record = change.kind === 'upsert'
        ? `${change.mode} ${blobOf.get(change.path)!}\t${change.path}`
        : `0 ${'0'.repeat(40)}\t${change.path}`;
      await execGit(
        ['update-index', '-z', '--index-info'],
        { ...repo, env: idxEnv, stdin: Buffer.concat([Buffer.from(record, 'utf8'), Buffer.alloc(1)]) },
      );
    }
    const treeOid = (await execGit(['write-tree'], { ...repo, env: idxEnv })).trim();

    // ── commit-tree（消息经 stdin -F -；身份/时间戳经 env——服务端归因）─────
    const when = (input.committedAt ?? new Date().toISOString());
    const stamp = `${Math.floor(Date.parse(when) / 1000)} +0000`;
    const identEnv = {
      GIT_INDEX_FILE: indexPath,
      GIT_AUTHOR_NAME: input.identity.name,
      GIT_AUTHOR_EMAIL: input.identity.email,
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_NAME: input.identity.name,
      GIT_COMMITTER_EMAIL: input.identity.email,
      GIT_COMMITTER_DATE: stamp,
    };
    const commitArgs = input.baseCommit === null
      ? ['commit-tree', treeOid, '-F', '-']
      : ['commit-tree', treeOid, '-p', input.baseCommit, '-F', '-'];
    const commitOid = (await execGit(commitArgs, { ...repo, env: identEnv, stdin: Buffer.from(`${input.message}\n`, 'utf8') })).trim();

    // ── 候选 tree 全路径（变更后基线）───────────────────────────────────────
    const candidateLines = parseLsTree(await execGit(['ls-tree', '-r', '-z', commitOid], repo));

    const changedFiles = input.changes.flatMap((change) => {
      if (change.kind !== 'upsert') return [];
      // content 原样回传（string/Uint8Array 不转换）——校验器两形态都收，
      // 草稿保留语义（draft 回传）与提交输入逐字一致
      return [{ path: change.path, mode: change.mode, content: change.content }];
    });

    return {
      commitOid,
      treeOid,
      baseTreePaths: baseTreeLines.map((e) => e.path),
      candidateTreePaths: candidateLines.map((e) => e.path),
      changedFiles,
      deletedPaths: input.changes.filter((c) => c.kind === 'delete').map((c) => c.path),
    };
  } finally {
    await rm(indexPath, { force: true }); // 请求级 index 生命周期=本次构造
  }
}
