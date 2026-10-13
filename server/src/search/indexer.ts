import type { DatabaseSync } from 'node:sqlite';
import { execGit } from '../publish/git-exec.ts';
import { vaultRepoPath } from '../vaults/repo-path.ts';
import { deriveVaultIndex, type DerivedIndex } from './derive.ts';

/**
 * 索引器（S5-T3；架构 §9「内容搜索基于已发布分支派生索引，按权限过滤；索引延迟
 * 可观测，写入完成不以索引成功作为唯一依据」、sprint D5 索引=派生数据 / D7 索引
 * 更新与发布解耦）。
 *
 * 实现形态选型（breakdown 第 5 点，记录于 docs/s1/search-index-amendments.md）：
 * **进程内异步**（单进程现实——架构 §9 初版单实例；不引外部队列服务）。触发面
 * 统一走审计尾随（audit tail）：
 * - push：T6 审计 settle 钩子（post-receive / 管线 settle 步）置 succeeded 行后，
 *   本索引器尾随该行触发（「push（T6 审计 settle 钩子）」的消费面实现——settle
 *   即触发锚点，索引器与其异步解耦，hook 子进程与服务器进程经 WAL 相互可见）；
 * - 网页发布：管线 settle 置 vault.web_submit succeeded 行，同一尾随面触发
 *   （「web 发布后异步更新」——不另在发布路径插通知缝，发布组件零改动）；
 * - 崩溃兜底：启动对账（reconcile）逐库比对 state.head_commit 与默认分支实际头，
 *   漂移即重索引，并清理已删库的孤儿行——最终一致的恢复边界。
 *
 * 失败语义（D7）：单库索引失败不阻断任何发布（索引器与发布路径无同步依赖），
 * 只记 state 告警字段（consecutive_failures/last_error/last_error_at）+ 告警日志
 * （[notegit search] 前缀）；旧索引行原样保留（stale 可观测），成功后计数清零。
 *
 * 延迟可观测：lag_ms = indexed_at − 触发审计行 occurred_at（发布→已索引）；
 * duration_ms = 单次派生耗时；时间戳与指标存 search_index_state（管理端点消费）。
 *
 * 并发形态：逐库串行（同库合并触发——重索引总是取当前头，重复触发幂等收敛）；
 * 定时器 unref（不独自维持进程事件循环）；失败永不向上抛（fire-and-forget 面）。
 */

/** 告警日志最小面（测试注入收集；生产 = console） */
export interface SearchLog {
  error(...args: unknown[]): void;
}

export interface SearchIndexerOptions {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  /** 尾随轮询间隔（默认 250ms；NOTEGIT_SEARCH_POLL_MS 可配——最终一致的构成上界之一） */
  readonly pollMs?: number;
  /** 时钟注入（测试控时；缺省服务端当前时钟） */
  readonly now?: () => Date;
  /** 派生面注入（默认真实 git 派生；失败注入/测试缝） */
  readonly derive?: (repoPath: string, branch: string) => Promise<DerivedIndex>;
  /** 日志面注入（默认 console） */
  readonly log?: SearchLog;
}

/**
 * 全量重建运行态（S5-T5；backup §7 步骤 9「应用内触发全量重建，进度与延迟可观测」）：
 * 进程内单实例（与索引器同生命周期；重启后归 idle——启动对账即崩溃兜底）。
 * GET /api/v1/admin/search-index 消费（T3 指标面复用：rebuilding 状态 + 进度计数）。
 */
export interface RebuildStatus {
  /** idle = 从未触发；running = 在途；completed = 本轮全部库已 settle（逐库失败经
   *  vaults 面的 up_to_date/consecutive_failures 可见——D7 失败不阻断，单独可观测） */
  readonly state: 'idle' | 'running' | 'completed';
  readonly total: number;
  readonly done: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export const REBUILD_IDLE: RebuildStatus = { state: 'idle', total: 0, done: 0, started_at: null, finished_at: null };

export interface SearchVaultStatus {
  readonly vault_id: number;
  readonly slug: string;
  readonly branch: string;
  /** 索引已反映的头（NULL = 未索引过或分支空） */
  readonly head_commit: string | null;
  /** 默认分支当前实际头（读失败 null） */
  readonly live_commit: string | null;
  /** state.head_commit === live_commit（实时新鲜度） */
  readonly up_to_date: boolean;
  readonly indexed_at: string | null;
  readonly triggered_by: string | null;
  readonly triggered_at: string | null;
  readonly duration_ms: number | null;
  readonly lag_ms: number | null;
  readonly updates: number | null;
  readonly consecutive_failures: number | null;
  readonly last_error: string | null;
  readonly last_error_at: string | null;
  /** 该库索引行数 */
  readonly rows: number;
}

interface TriggerInfo {
  readonly by: 'vault.push' | 'vault.web_submit' | 'startup-reconcile' | 'manual';
  readonly at: string | null;
}

const STATE_COLUMNS = `vault_id, branch, head_commit, triggered_by, triggered_at, indexed_at, duration_ms, lag_ms, updates, consecutive_failures, last_error, last_error_at` as const;

/** 审计尾随查询：settle 后的默认分支发布行（成功态）——索引触发的唯一常规来源 */
const TAIL_SQL = `
  SELECT a.id AS id, a.vault_id AS vault_id, a.event_kind AS event_kind, a.occurred_at AS occurred_at
  FROM audit_events a JOIN vaults v ON v.id = a.vault_id
  WHERE a.id > ? AND a.id <= ?
    AND a.status = 'succeeded'
    AND a.event_kind IN ('vault.push','vault.web_submit')
    AND a.ref_name = 'refs/heads/' || v.default_branch
  ORDER BY a.id`;

export class SearchIndexer {
  private readonly db: DatabaseSync;
  private readonly dataDir: string;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private readonly derive: (repoPath: string, branch: string) => Promise<DerivedIndex>;
  private readonly log: SearchLog;

  /** 已消费的审计行上界（构造时 = 当前 max(id)：本实例只看启动后的发布） */
  private watermark: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** 启动对账的在途句柄（stop 等待其完成——不留后台未决工作） */
  private reconcilePromise: Promise<void> | null = null;
  /** 全量重建的在途句柄（stop 同款排空语义）与进度面（RebuildStatus 见接口注释） */
  private rebuildPromise: Promise<void> | null = null;
  private rebuildStatus: RebuildStatus = REBUILD_IDLE;
  /** 逐库待重索引标记 + 最近触发信息（合并触发取最新） */
  private readonly dirty = new Map<number, TriggerInfo>();
  /** 逐库串行链（在途/链式排队的重索引 Promise；pollOnce/reconcile await 它们求确定性） */
  private readonly drains = new Map<number, Promise<void>>();

  constructor(opts: SearchIndexerOptions) {
    this.db = opts.db;
    this.dataDir = opts.dataDir;
    const envPoll = Number(process.env.NOTEGIT_SEARCH_POLL_MS);
    this.pollMs = opts.pollMs ?? (Number.isFinite(envPoll) && envPoll > 0 ? envPoll : 250);
    this.now = opts.now ?? (() => new Date());
    this.derive = opts.derive ?? deriveVaultIndex;
    this.log = opts.log ?? console;
    const top = this.db.prepare('SELECT MAX(id) AS m FROM audit_events').get() as { m: number | null };
    this.watermark = top.m ?? 0;
  }

  /** 启动：异步启动对账（崩溃兜底）+ unref 定时尾随（不独自维持事件循环） */
  start(): void {
    // reconcile 内部逐库吞错（reindexLatest 不上抛）；catch 为防御兜底
    this.reconcilePromise = this.reconcile().catch(() => {});
    const timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollMs);
    timer.unref();
    this.timer = timer;
  }

  /** 关停：停定时器并等待在途重索引与启动对账排空（进程内组件可复活——pollOnce 仍可用） */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.reconcilePromise !== null) {
      await this.reconcilePromise;
      this.reconcilePromise = null;
    }
    if (this.rebuildPromise !== null) {
      await this.rebuildPromise;
      this.rebuildPromise = null;
    }
    while (this.drains.size > 0) {
      await Promise.all([...this.drains.values()].map((p) => p.catch(() => {})));
    }
  }

  /** 单次尾随（定时器/测试共用）：扫新 succeeded 发布行 → 触发受影响库重索引 */
  async pollOnce(): Promise<void> {
    if (this.polling) return; // 定时器重入防护（上一轮未完不叠加）
    this.polling = true;
    try {
      // 扫描上界：不越过在途 pending 行——发布审计是「预记 pending → settle 原位
      // 置终态」的生命周期（id 不变），先推进会漏看本轮 pending、settle 后永不再
      // 扫的行。minPending 之下全部留待其 settle 后的下一轮（稳态不变式：
      // watermark < 任何 pending 行 id；崩溃启动越过 pending 的残留漂移由启动
      // 对账兜底）。
      const bounds = this.db
        .prepare(
          `SELECT MAX(id) AS top, (SELECT MIN(id) FROM audit_events WHERE status = 'pending') AS minPending FROM audit_events`,
        )
        .get() as { top: number | null; minPending: number | null };
      const top = bounds.top;
      if (top === null || top <= this.watermark) return;
      const limit = bounds.minPending === null ? top : Math.min(top, bounds.minPending - 1);
      if (limit <= this.watermark) return; // 前方有更低 id 的在途发布——等 settle
      const rows = this.db.prepare(TAIL_SQL).all(this.watermark, limit) as {
        vault_id: number;
        event_kind: 'vault.push' | 'vault.web_submit';
        occurred_at: string;
      }[];
      this.watermark = limit; // 推进至扫描上界（含被过滤行——非默认分支/rejected 不重扫）
      if (rows.length === 0) return;
      for (const row of rows) {
        this.dirty.set(row.vault_id, { by: row.event_kind, at: row.occurred_at });
      }
      await this.drainAll();
    } finally {
      this.polling = false;
    }
  }

  /**
   * 启动对账（崩溃/旁路兜底）：逐库比对 state.head_commit 与默认分支实际头，漂移
   * 即重索引；清理已删库的孤儿派生行（无外键的对应清理面——权威侧删行不被派生
   * 行阻塞，孤儿由这里回收）。T5 全量重建的逐库原语同源。
   */
  async reconcile(): Promise<void> {
    this.db.prepare('DELETE FROM search_index WHERE vault_id NOT IN (SELECT id FROM vaults)').run();
    this.db.prepare('DELETE FROM search_index_state WHERE vault_id NOT IN (SELECT id FROM vaults)').run();
    const vaults = this.db.prepare('SELECT id, default_branch FROM vaults').all() as {
      id: number;
      default_branch: string;
    }[];
    for (const v of vaults) {
      const state = this.db
        .prepare('SELECT head_commit FROM search_index_state WHERE vault_id = ?')
        .get(v.id) as { head_commit: string | null } | undefined;
      const live = await this.headOf(vaultRepoPath(this.dataDir, v.id), v.default_branch);
      if ((state?.head_commit ?? null) !== live) {
        this.dirty.set(v.id, { by: 'startup-reconcile', at: null });
      }
    }
    await this.drainAll();
  }

  /**
   * 管理侧全量重建（S5-T5；backup §7 步骤 9）。与 reconcile 的差别：**无视**
   * state.head_commit 是否与实际头一致，逐库强制重派生 + 单事务全量替换——
   * reconcile 只修「头漂移」，不修「头一致而行丢失/损坏」（删索引数据后 state
   * 也清空时两者恰好同效；state 残留而 index 行被清时只有本面能恢复）。孤儿
   * 清理与 reconcile 同款（无外键的对应清理面）。逐库触发记 {by:'manual',
   * at:null}（DDL CHECK 预留位；lag_ms 重建型为 NULL——C1 建议稿口径）。
   *
   * 重建期间查询降级选型 = 部分结果（不 503）：逐库事务替换（BEGIN IMMEDIATE
   * …COMMIT）保证读者永不见半库状态；鉴权过滤在查询面逐请求实时 JOIN（D7 无
   * 缓存），降级只缺「完整度」不缺「授权」——不存在泄露面，503 只损失读可用性
   * （选型记录 docs/s1/search-index-amendments.md C4）。
   *
   * 幂等选型 = running 中再触发直接拒绝（false → 路由 409）：单进程逐库串行、
   * 重建总取当前头，排队重跑与在跑产出相同——拒绝 + 进度可查比排队诚实。
   *
   * @returns 是否成功启动（false = 已有重建在途）
   */
  rebuild(): boolean {
    if (this.rebuildStatus.state === 'running') return false;
    const vaults = this.db.prepare('SELECT id FROM vaults').all() as { id: number }[];
    this.rebuildStatus = {
      state: 'running',
      total: vaults.length,
      done: 0,
      started_at: this.now().toISOString(),
      finished_at: null,
    };
    this.rebuildPromise = this.runRebuild(vaults.map((v) => v.id)).catch(() => {}); // runRebuild 内部吞错；防御外泄
    return true;
  }

  /** 重建进度面（GET /api/v1/admin/search-index 消费；路由直接读，不触发副作用） */
  rebuildStatusView(): RebuildStatus {
    return this.rebuildStatus;
  }

  /** 重建主体：孤儿清理 → 逐库强制重索引（并行 kick、逐库串行链）→ 进度计数 → 定态 */
  private async runRebuild(vaultIds: readonly number[]): Promise<void> {
    try {
      this.db.prepare('DELETE FROM search_index WHERE vault_id NOT IN (SELECT id FROM vaults)').run();
      this.db.prepare('DELETE FROM search_index_state WHERE vault_id NOT IN (SELECT id FROM vaults)').run();
      await Promise.all(
        vaultIds.map(async (vaultId) => {
          this.dirty.set(vaultId, { by: 'manual', at: null });
          await this.kick(vaultId); // 含在途链：settle 即该库本轮定态（失败也已落 state/日志）
          this.rebuildStatus = { ...this.rebuildStatus, done: this.rebuildStatus.done + 1 };
        }),
      );
    } catch (err) {
      this.log.error(
        `[notegit search] 全量重建异常（进度 ${this.rebuildStatus.done}/${this.rebuildStatus.total}）：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // 逐库失败不阻断重建收口（D7：失败只在 vaults 面/日志可见——up_to_date=false、
      // consecutive_failures 递增）；done 计数如实反映已 settle 的库数
      this.rebuildStatus = { ...this.rebuildStatus, state: 'completed', finished_at: this.now().toISOString() };
    }
  }

  /** 管理端点消费面：逐库状态 + 实时新鲜度 + 索引行数 + 重建进度面（S5-T5） */
  async status(): Promise<{ running: boolean; pollMs: number; rebuild: RebuildStatus; vaults: SearchVaultStatus[] }> {
    const counts = new Map(
      (
        this.db.prepare('SELECT vault_id, COUNT(*) AS n FROM search_index GROUP BY vault_id').all() as {
          vault_id: number;
          n: number;
        }[]
      ).map((r) => [r.vault_id, r.n]),
    );
    const rows = this.db
      .prepare(
        `SELECT v.id AS vault_id, v.slug AS slug, v.default_branch AS default_branch,
                s.branch AS state_branch, s.head_commit AS head_commit, s.triggered_by AS triggered_by,
                s.triggered_at AS triggered_at, s.indexed_at AS indexed_at, s.duration_ms AS duration_ms,
                s.lag_ms AS lag_ms, s.updates AS updates, s.consecutive_failures AS consecutive_failures,
                s.last_error AS last_error, s.last_error_at AS last_error_at
         FROM vaults v LEFT JOIN search_index_state s ON s.vault_id = v.id ORDER BY v.id`,
      )
      .all() as Record<string, unknown>[];
    const vaults: SearchVaultStatus[] = [];
    for (const r of rows) {
      const branch = String(r['state_branch'] ?? r['default_branch']);
      const live = await this.headOf(vaultRepoPath(this.dataDir, Number(r['vault_id'])), branch);
      const head = (r['head_commit'] as string | null) ?? null;
      vaults.push({
        vault_id: Number(r['vault_id']),
        slug: String(r['slug']),
        branch,
        head_commit: head,
        live_commit: live,
        up_to_date: head === live,
        indexed_at: (r['indexed_at'] as string | null) ?? null,
        triggered_by: (r['triggered_by'] as string | null) ?? null,
        triggered_at: (r['triggered_at'] as string | null) ?? null,
        duration_ms: (r['duration_ms'] as number | null) ?? null,
        lag_ms: (r['lag_ms'] as number | null) ?? null,
        updates: (r['updates'] as number | null) ?? null,
        consecutive_failures: (r['consecutive_failures'] as number | null) ?? null,
        last_error: (r['last_error'] as string | null) ?? null,
        last_error_at: (r['last_error_at'] as string | null) ?? null,
        rows: counts.get(Number(r['vault_id'])) ?? 0,
      });
    }
    return { running: this.timer !== null, pollMs: this.pollMs, rebuild: this.rebuildStatus, vaults };
  }

  /** 触发受影响库的串行重索引并等待排空（含在途链——调用方返回即已定态） */
  private async drainAll(): Promise<void> {
    await Promise.all([...this.dirty.keys()].map((vaultId) => this.kick(vaultId)));
  }

  /**
   * 单库重索引入口：链在在途 Promise 之后（同库串行；消费期间的新触发由
   * drainIfDirty 的 while 循环接续）。返回的 Promise 含在途工作——pollOnce/
   * reconcile/stop 等待它即得确定性排空，不存在「调用已返回、库还在后台跑」的
   * 窗口。链节 settle 后从 drains 摘除（未被更新的 kick 替换时）——stop 的
   * 排空循环因此可终止。
   */
  private kick(vaultId: number): Promise<void> {
    const prev = this.drains.get(vaultId) ?? Promise.resolve();
    const next = prev.then(() => this.drainIfDirty(vaultId));
    const guarded = next.catch(() => {}); // reindexLatest 不上抛；防御链节点异常外泄
    this.drains.set(vaultId, guarded);
    void guarded.then(() => {
      if (this.drains.get(vaultId) === guarded) this.drains.delete(vaultId);
    });
    return next;
  }

  private async drainIfDirty(vaultId: number): Promise<void> {
    while (this.dirty.has(vaultId)) {
      const trigger = this.dirty.get(vaultId)!;
      this.dirty.delete(vaultId);
      await this.reindexLatest(vaultId, trigger); // 不上抛（内部吞错）；失败也已落 state/日志
    }
  }

  /** 默认分支当前头（读失败 null——up_to_date 随之为假，stale 可见） */
  private async headOf(repoPath: string, branch: string): Promise<string | null> {
    try {
      return (await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath })).trim();
    } catch {
      return null;
    }
  }

  /**
   * 单库一次重索引（总取当前默认分支头——合并触发幂等收敛）：
   * 派生（可失败）→ 单事务全量替换（search_index 行 + state upsert）。
   * 失败：告警日志 + state 失败字段（DB 也不可写时只剩日志），不抛出。
   */
  private async reindexLatest(vaultId: number, trigger: TriggerInfo): Promise<void> {
    const vault = this.db
      .prepare('SELECT id, default_branch FROM vaults WHERE id = ?')
      .get(vaultId) as { id: number; default_branch: string } | undefined;
    if (vault === undefined) {
      // 库已删（对账竞态）：清本库派生行
      this.db.prepare('DELETE FROM search_index WHERE vault_id = ?').run(vaultId);
      this.db.prepare('DELETE FROM search_index_state WHERE vault_id = ?').run(vaultId);
      return;
    }
    const started = this.now();
    try {
      const derived = await this.derive(vaultRepoPath(this.dataDir, vault.id), vault.default_branch);
      const indexedAt = this.now().toISOString();
      const durationMs = Math.max(0, this.now().getTime() - started.getTime());
      const lagMs =
        trigger.at === null ? null : Math.max(0, this.now().getTime() - Date.parse(trigger.at));
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM search_index WHERE vault_id = ?').run(vaultId);
        const ins = this.db.prepare(
          `INSERT INTO search_index (vault_id, path, commit_oid, title, tags, summary, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const doc of derived.docs) {
          ins.run(vaultId, doc.path, derived.headCommit ?? '', doc.title, JSON.stringify(doc.tags), doc.summary, indexedAt);
        }
        this.db
          .prepare(
            `INSERT INTO search_index_state (${STATE_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL)
             ON CONFLICT(vault_id) DO UPDATE SET
               branch = excluded.branch,
               head_commit = excluded.head_commit,
               triggered_by = excluded.triggered_by,
               triggered_at = excluded.triggered_at,
               indexed_at = excluded.indexed_at,
               duration_ms = excluded.duration_ms,
               lag_ms = excluded.lag_ms,
               updates = search_index_state.updates + 1,
               consecutive_failures = 0,
               last_error = NULL,
               last_error_at = NULL`,
          )
          .run(vaultId, vault.default_branch, derived.headCommit, trigger.by, trigger.at, indexedAt, durationMs, lagMs);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`[notegit search] 索引更新失败（vault=${vaultId}，不阻断发布）：${message}`);
      try {
        this.db
          .prepare(
            `INSERT INTO search_index_state (${STATE_COLUMNS})
             VALUES (?, ?, NULL, ?, NULL, ?, 0, NULL, 0, 1, ?, ?)
             ON CONFLICT(vault_id) DO UPDATE SET
               consecutive_failures = search_index_state.consecutive_failures + 1,
               last_error = excluded.last_error,
               last_error_at = excluded.last_error_at`,
          )
          .run(vaultId, vault.default_branch, trigger.by, this.now().toISOString(), message, this.now().toISOString());
      } catch (dbErr) {
        // state 也不可写（索引失败的极端形态）：日志已是唯一告警面
        this.log.error(
          `[notegit search] 索引失败状态也未能落库（vault=${vaultId}）：${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        );
      }
    }
  }
}
