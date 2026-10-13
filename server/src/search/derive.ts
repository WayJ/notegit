import { execGit } from '../publish/git-exec.ts';
import { extractFrontmatter } from 'notegit-validation';

/**
 * 派生面（S5-T3；架构 §3.1 派生数据、§9 内容搜索基于已发布分支派生索引）：
 * 从库的已发布默认分支读出 .md 全集，逐文件提取 frontmatter title/tags 与正文
 * 首段摘要。纯函数面——不写库、不记状态；索引器（indexer.ts）消费本面落表。
 *
 * 输入消费面（breakdown 行：「消费 packages/validation 的解析或 git 读取面」）：
 * - frontmatter 块提取 = notegit-validation 的 extractFrontmatter（三入口同一
 *   解析面——暂存区/服务端/网页怎么切 frontmatter，索引就怎么切，不另写一套
 *   边界语义）；
 * - 内容读取 = execGit（publish/git-exec.ts，与 web/history、browse 同一 git
 *   执行面）：rev-parse（分支头）→ ls-tree -r（已发布 tree 快照）→ cat-file
 *   （按 oid 读 blob——与分支头一致的一致性快照，不受并发推送影响）。
 *
 * title/tags 的字段解析是保守行式解析（不引 YAML 依赖）：已发布内容先经
 * E-FM 校验（title 必为标量、tags 必为字符串序列），块式/流式序列与引号标量
 * 全覆盖；折叠多行标量等罕见合法形态退化为 title=NULL/tags=[]（行仍入索引，
 * path/commit/摘要仍在——派生面如实少记，不伪造；全量重建同口径）。
 */

/** 单文件的派生行（search_index 表的值域；commit_oid 由调用方按头统一填） */
export interface DerivedDoc {
  readonly path: string;
  /** frontmatter title；README 等 frontmatter 豁免文件为 null（不用文件名伪造） */
  readonly title: string | null;
  /** frontmatter tags（缺失/不可解析 = 空数组） */
  readonly tags: readonly string[];
  /** 正文首段摘要（段内换行合并为空格；超长截断） */
  readonly summary: string;
}

/** 一次派生结果：默认分支头 + 逐路径文档行 */
export interface DerivedIndex {
  /** NULL = 分支不存在（尚无提交的空库）——索引空集 */
  readonly headCommit: string | null;
  readonly docs: readonly DerivedDoc[];
}

/** 摘要存储上界（字节）：首段超长截断（架构只要求「摘要片段」，不承诺全文） */
export const SUMMARY_MAX_CHARS = 500;

/** 去除成对包裹引号（YAML 双/单引号标量的常见形态） */
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

/** 行式解析 frontmatter 的 title（标量行）。多行折叠等形态返回 null（如实少记） */
function parseTitle(blockText: string): string | null {
  for (const rawLine of blockText.split('\n')) {
    const m = /^title:[ \t]*(.*)$/.exec(rawLine);
    if (m === null) continue;
    const value = m[1]!.trim();
    if (value === '' || value === '|' || value === '>') return null; // 块标量形态——保守放弃
    return unquote(value);
  }
  return null;
}

/** 行式解析 frontmatter 的 tags（块式序列 / 流式序列）。其余形态返回空数组 */
function parseTags(blockText: string): string[] {
  const lines = blockText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^tags:[ \t]*(.*)$/.exec(lines[i]!);
    if (m === null) continue;
    const inline = m[1]!.trim();
    if (inline !== '') {
      if (inline === '|' || inline === '>') return []; // 块标量形态——保守放弃
      if (inline.startsWith('[') && inline.endsWith(']')) {
        // 流式序列 [a, b, "c d"]
        const inner = inline.slice(1, -1).trim();
        if (inner === '') return [];
        return inner.split(',').map((item) => unquote(item.trim())).filter((item) => item !== '');
      }
      return []; // 非序列形态（已发布内容不应出现；防御）
    }
    // 块式序列：后续缩进行 `- item`
    const tags: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^[\t ]+-[ \t]+(.*)$/.exec(lines[j]!);
      if (item === null) break;
      const value = unquote(item[1]!.trim());
      if (value !== '') tags.push(value);
    }
    return tags;
  }
  return [];
}

/** 正文首段摘要：跳过前导空行，取首个非空段落（至空行止），段内换行合并为空格 */
function parseSummary(body: string): string {
  const lines = body.split('\n');
  const paragraph: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (paragraph.length > 0) break; // 段落结束
      continue; // 前导空行
    }
    paragraph.push(line.trim());
  }
  const joined = paragraph.join(' ');
  return [...joined].slice(0, SUMMARY_MAX_CHARS).join('');
}

/** 单文档解析（消费 notegit-validation 的 extractFrontmatter 切块） */
export function parseDerivedDoc(text: string): Omit<DerivedDoc, 'path'> {
  const extracted = extractFrontmatter(text);
  if (extracted.kind !== 'block') {
    // 无 frontmatter / 未闭合：README 等豁免文件走无 title 形态；
    // 正文仍从头取首段（未闭合块按无 frontmatter 对待——已发布面不该出现）
    return { title: null, tags: [], summary: parseSummary(text) };
  }
  const blockText = extracted.blockText ?? '';
  const body = text.split('\n').slice(extracted.closeLine).join('\n');
  return { title: parseTitle(blockText), tags: parseTags(blockText), summary: parseSummary(body) };
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly path: string;
}

/** ls-tree -r -z 解析（NUL 分隔；mode SP type SP oid TAB path） */
function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    if (meta.length !== 3) continue;
    entries.push({ mode: meta[0]!, type: meta[1]!, oid: meta[2]!, path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * 从已发布默认分支派生索引行（纯读面）：
 * rev-parse 分支头（不存在 → 空集）→ ls-tree -r 头快照 → 逐 .md blob 解析。
 */
export async function deriveVaultIndex(repoPath: string, branch: string): Promise<DerivedIndex> {
  let headCommit: string;
  try {
    headCommit = (await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath })).trim();
  } catch {
    return { headCommit: null, docs: [] }; // 分支不存在（空库）——派生空集
  }
  const entries = parseLsTree(await execGit(['ls-tree', '-r', '-z', '--full-tree', headCommit], { cwd: repoPath }));
  const docs: DerivedDoc[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob' || !entry.path.endsWith('.md')) continue; // 只索引 Markdown 知识文件
    const text = await execGit(['cat-file', 'blob', entry.oid], { cwd: repoPath });
    docs.push({ path: entry.path, ...parseDerivedDoc(text) });
  }
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { headCommit, docs };
}
