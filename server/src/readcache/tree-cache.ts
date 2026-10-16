import { execGit, type GitExecOptions } from '../publish/git-exec.ts';

/**
 * S24-T1 跨请求 HEAD 树缓存（单源缓存层——S24 D1、E8 D48/D49）：browse 树
 * （web/browse/tree.ts）、agent 读端点 tree/docs（api-read/tree.ts、
 * web/history/version.ts）、工作台 HEAD 求交（web/workbench/display.ts）共用的
 * 读缓存。此前四个面各自每请求 spawn git（capacity.md 瓶颈 2：tree 族读端点的
 * 主要 CPU 成本）；本层以「同一 (仓库, 命令) → 同一 stdout」的透传缓存消除重复
 * spawn——解析逻辑仍留在各消费面（缓存的是 ls-tree/rev-parse 原始输出，读端点
 * 响应构造逐字节不变——只变服务方式）。
 *
 * 有效性设计（E8 D48：失效钩子优先 + 短 TTL 兜底 + fail-closed）：
 *
 * - **失效两路径**：① web publish 提交点（publish/pipeline.ts update-ref 成功后
 *   直调 invalidateVaultTreeCache——进程内同步，发布返回即生效）；② git push 后端
 *   钩子链（githttp/hooks.ts 安装的 post-receive settle 置审计行 →
 *   search/indexer.ts pollOnce 审计尾随——与既有索引派生同触发点，同路失效）。
 *   失效清该仓库全部键（前缀扫），commit OID 锚定键虽不可变，一并清除无害。
 * - **TTL 兜底 ≤5 秒**：钩子之外的移动（在途读回填竞界、旁路写）以 TREE_CACHE_TTL_MS
 *   为上界；条目过期即当作未命中重新 spawn。
 * - **fail-closed**：git 调用失败绝不缓存——错误原样上抛（与无缓存直读同一失败
 *   形态），后续读取重新 spawn，不返回缓存旧值。
 * - **在途合并**：同键并发未命中共享同一次 spawn（burst 扇出去重）；该在途读
 *   完成时若期间发生过本仓库失效（inflight 登记已被清除），结果不再回填缓存
 *   （失效后不落失效前启动的旧读）。
 *
 * 键形：`<repoPath>\u0000<args 以 NUL 连接>`（argv 不含 NUL——无碰撞）；仅
 * args[0] ∈ {ls-tree, rev-parse} 且无 stdin/env 注入的调用入缓存（读面族白名单，
 * 其余命令直通 execGit，杜绝误用面）。条目数达阈值时清扫过期项（读面键基数
 * = 目录×OID×仓库，5 秒窗内有界；清扫是防长尾，不做硬驱逐）。
 */

/** TTL 兜底上界（E8 D48：秒级；S24 D2 锁定 ≤5s——行为测试断言该值） */
export const TREE_CACHE_TTL_MS = 5_000;

/** 入缓存命令白名单（读面 plumbing——其余一律直通不缓存） */
const CACHEABLE_COMMANDS = new Set(['ls-tree', 'rev-parse']);

/** 过期清扫阈值（条目数达到即扫一遍过期——防长尾增长，见文件头注） */
const SWEEP_THRESHOLD = 128;

interface CacheEntry {
  readonly out: string;
  readonly expiresAt: number;
}

const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();

let spawns = 0;
let hits = 0;

/** 可观测计数（S24 验收 S1「spawn 次数下降」的观测面；测试断言所依） */
export interface TreeCacheStats {
  readonly entries: number;
  readonly inflight: number;
  readonly spawns: number;
  readonly hits: number;
}

export function treeCacheStats(): TreeCacheStats {
  return { entries: store.size, inflight: inflight.size, spawns, hits };
}

function keyOf(repoPath: string, args: readonly string[]): string {
  return `${repoPath}\u0000${args.join('\u0000')}`;
}

function sweepExpired(now: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

/**
 * 缓存面 git 读（与 execGit 同签同义——可直接作各读面的缺省执行器/注入缺省值）：
 * 命中返回缓存 stdout；未命中 spawn 并在成功后回填（失败上抛不缓存）。
 */
export async function readTreeCached(args: readonly string[], options: GitExecOptions): Promise<string> {
  const cacheable = options.stdin === undefined && options.env === undefined && CACHEABLE_COMMANDS.has(args[0] ?? '');
  if (!cacheable) return execGit(args, options); // 白名单外/带注入直通（不缓存）
  const key = keyOf(options.cwd, args);
  const now = Date.now();
  const hit = store.get(key);
  if (hit !== undefined) {
    if (now < hit.expiresAt) {
      hits += 1;
      return hit.out;
    }
    store.delete(key); // 过期=未命中（TTL 兜底）
  }
  const running = inflight.get(key);
  if (running !== undefined) {
    hits += 1; // 在途合并：与首发者共享同一次 spawn
    return running;
  }
  spawns += 1;
  const p = execGit(args, options).then(
    (out) => {
      // 登记仍在（期间无本仓库失效）才回填：失效会清 inflight，失效前启动的旧读
      // 不落缓存（把「提交点失效后读到旧树」的窗口收窄到真正与写并发的在途读）
      if (inflight.get(key) === p) {
        inflight.delete(key);
        store.set(key, { out, expiresAt: Date.now() + TREE_CACHE_TTL_MS });
        if (store.size >= SWEEP_THRESHOLD) sweepExpired(Date.now());
      }
      return out;
    },
    (err) => {
      if (inflight.get(key) === p) inflight.delete(key);
      throw err; // fail-closed：错误不缓存、原样上抛（与直读同失败形态）
    },
  );
  inflight.set(key, p);
  return p;
}

/**
 * 失效一个仓库的全部树缓存（web publish 提交点与审计尾随两路径的消费面）。
 * 同时清除在途登记：失效后到达的读取不再并入失效前启动的旧 spawn。
 */
export function invalidateVaultTreeCache(repoPath: string): void {
  const prefix = `${repoPath}\u0000`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

/** 测试隔离用：清空全部缓存态（生产代码不得调用） */
export function clearTreeCacheForTests(): void {
  store.clear();
  inflight.clear();
}
