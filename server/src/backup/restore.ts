import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/connection.ts';
import { MIGRATIONS } from '../db/migrations.ts';
import { vaultRepoDirName } from '../vaults/repo-path.ts';
import { listPendingReconciliation, auditChain, type PendingReconciliationRow } from '../audit/reconciliation.ts';
import { tryGit } from './git.ts';
import { BackupError, readAppVersion } from './snapshot.ts';
import { verifyBackupSet, type VerifyCheck } from './verify.ts';
import type { BackupManifest } from './manifest.ts';
import { httpMaintenanceControl, type MaintenanceControl } from './run.ts';

/**
 * 全新环境恢复（S8-T5；backup-recovery §7 十步的两相位落地 + §5 不变量核对）。
 *
 * **离线相位 restoreOffline（§7 步骤 2–6）**——应用未启动、只落目标 /data：
 *
 * 1. pre-verify：装载前先复用 T4 离线验证（verify.ts）复算产物——manifest 在、
 *   件数齐、逐文件哈希、HEAD 互证、快照库完整性。篡改产物在此被拒（恢复侧复用
 *   离线验证负路径），目标不被触碰；
 * 2. target-fresh：目标四域（db/git/config/keys）必须全新——恢复不得覆盖既有
 *   实例（覆盖 = 半恢复混合态，无核对语义）；
 * 3. version-compat（§7 步骤 6）：manifest schema 版本 **高于**当前镜像 → 拒绝
 *   （D-BR-05 不支持降级）；低于等于 → 放行（前向迁移由应用启动自动执行，§9）；
 *   app 版本不同 → 放行并注记（数据面恢复不因 app 版本阻断，升级走 §9）；
 * 4. 装载顺序 = §7：config → keys（0600/0700 强制，不信任来源权限）→ db → git；
 * 5. post-load：装载后逐文件复算哈希 + 每库 HEAD == manifest + 目标库完整性
 *   （「恢复后完整性核对」——装载环节自身的损坏可检）。
 *
 * 失败语义：装载开始后失败 → 清扫已建域并上抛（目标回到全新态）；**不触碰任何
 * 运行实例**（离线相位本就无实例）。
 *
 * **对账相位 restoreReconcile（§7 步骤 7 的 S8-T5 落地面）**——只读核对：
 * 残留 pending/待核对发布行为零（排空保证的恢复侧复核）+ 全部 ref 当前 OID 与
 * 审计 old→new 成链（§5 不变量 1–2，含「ref 越过审计链」的半应用写点名）。
 * 异常态（残留行存在）的**处置**——按 new_commit vs ref 实际值标终态——属
 * S8-T6 恢复对账任务（audit/reconciliation 域）：本模块报告并拒绝放行，是 T6
 * 的衔接缝（T6 交付后由其处置后再经本核对放行）。
 *
 * **finalize 相位 restoreFinalize（§7 步骤 7/9 的实例侧触发）**——应用已以
 * NOTEGIT_MAINTENANCE_ON_START=1 启动（§7 步骤 1「保持维护模式启动」；gate.ts
 * 初态机制）：健康检查 → 复核维护态（fail-closed：非维护态执行恢复核对 = §7
 * 违序）→ restoreReconcile（直连目标库只读）→ 经实例端点触发 S5-T5 全量重建
 * （allowlist 已裁，维护内放行）并等待完成。**结构性不退出维护**：§7 步骤 10
 * 属 §8 清单全绿后的显式操作（与 run.ts 排空超时不半退出同一保守姿态）。
 */

export { BackupError };
export type { VerifyCheck };

/** 当前镜像的 schema 版本（迁移链最大版本——§9 前向迁移的终点） */
export function currentSchemaVersion(): number {
  return Math.max(...MIGRATIONS.map((m) => m.version));
}

export interface RestoreOfflineOptions {
  /** 数据件目录（含 manifest.json） */
  readonly dataItemDir: string;
  /** 密钥件目录（显式必传——分置两件，不猜测同级） */
  readonly keysItemDir: string;
  /** 目标实例数据目录（须四域全新） */
  readonly dataDir: string;
  /** 当前应用版本（缺省 server 包 package.json——与快照侧同源） */
  readonly appVersion?: string;
  /** 当前 schema 版本（缺省迁移链最大版本） */
  readonly schemaVersion?: number;
}

export interface RestoreOfflineResult {
  readonly manifest: BackupManifest;
  /** 恢复核对单（逐项呈现——演练留档消费） */
  readonly checks: readonly VerifyCheck[];
}

function ok(name: string, detail?: string): VerifyCheck {
  return { name, ok: true, ...(detail !== undefined ? { detail } : {}) };
}
function fail(name: string, detail?: string): VerifyCheck {
  return { name, ok: false, ...(detail !== undefined ? { detail } : {}) };
}

/** 四域目录名（backup §2） */
const DOMAINS = ['db', 'git', 'config', 'keys'] as const;

/** 目标全新判定：四域任一存在且非空 → 非全新（恢复不得覆盖既有实例） */
async function targetFresh(dataDir: string): Promise<boolean> {
  for (const domain of DOMAINS) {
    const dir = path.join(dataDir, domain);
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir);
    if (entries.length > 0) return false;
  }
  return true;
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function listFilesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  }
  await walk(root);
  return out;
}

/** 装载后完整性复核（独立导出：目标侧损坏的复查面）——三组核对项 */
export async function postLoadIntegrity(dataDir: string, manifest: BackupManifest): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [];

  // 1. 清单逐文件在目标复算（两件 → 目标同相对路径）
  const diffs: string[] = [];
  for (const entry of [...manifest.items.data.files, ...manifest.items.keys.files]) {
    const abs = path.join(dataDir, entry.path);
    if (!existsSync(abs)) {
      diffs.push(`${entry.path} 缺失`);
      continue;
    }
    const size = (await stat(abs)).size;
    if (size !== entry.bytes || (await sha256File(abs)) !== entry.sha256) {
      diffs.push(`${entry.path} 复算不一致`);
    }
  }
  checks.push(
    diffs.length === 0
      ? ok('post-load-hashes', `两件 ${manifest.items.data.files.length + manifest.items.keys.files.length} 文件装载复算一致`)
      : fail('post-load-hashes', diffs.slice(0, 5).join('；')),
  );

  // 2. 每库 rev-parse == manifest（装载环节的 git 域核对；unborn ⇔ null）
  const headDiffs: string[] = [];
  for (const v of manifest.vaults) {
    const r = await tryGit([
      '--git-dir',
      path.join(dataDir, 'git', vaultRepoDirName(v.id)),
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${v.default_branch}^{commit}`,
    ]);
    const actual = r.code === 0 ? r.stdout.trim() : null;
    if (actual !== v.head_oid) headDiffs.push(`库 ${v.id}(${v.slug}) 装载后 ${actual ?? 'unborn'} vs manifest ${v.head_oid ?? 'unborn'}`);
  }
  checks.push(
    headDiffs.length === 0
      ? ok('post-load-head-oid', `${manifest.vaults.length} 库装载后与 manifest 一致`)
      : fail('post-load-head-oid', headDiffs.slice(0, 5).join('；')),
  );

  // 3. 目标库只读打开：完整性 + 库行互证
  const dbPath = path.join(dataDir, 'db', 'notegit.sqlite');
  let db: DatabaseSync | null = null;
  try {
    db = new (await import('node:sqlite')).DatabaseSync(dbPath, { readOnly: true });
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    const rows = db.prepare('SELECT id, slug FROM vaults ORDER BY id').all() as { id: number; slug: string }[];
    const slugDiff =
      rows.length !== manifest.vaults.length || rows.some((r, i) => r.slug !== manifest.vaults[i]?.slug)
        ? `库行 ${rows.map((r) => r.slug).join(',')} vs manifest ${manifest.vaults.map((v) => v.slug).join(',')}`
        : null;
    checks.push(
      integrity === 'ok' && slugDiff === null
        ? ok('post-load-db-integrity', `integrity ok；${rows.length} 库行互证一致`)
        : fail('post-load-db-integrity', `${integrity !== 'ok' ? `integrity_check=${integrity}` : ''}${slugDiff ?? ''}`),
    );
  } catch (err) {
    checks.push(fail('post-load-db-integrity', `目标库只读打开失败：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    db?.close();
  }
  return checks;
}

/** §7 步骤 2–6 离线装载（无实例参与） */
export async function restoreOffline(opts: RestoreOfflineOptions): Promise<RestoreOfflineResult> {
  const checks: VerifyCheck[] = [];

  // 1. 恢复前核验：T4 离线验证全量复算（篡改必拒——恢复侧复用同一命令的断言）
  const pre = await verifyBackupSet({ dataItemDir: opts.dataItemDir, keysItemDir: opts.keysItemDir });
  if (!pre.ok) {
    const bad = pre.checks.filter((c) => !c.ok).map((c) => `${c.name}：${c.detail ?? ''}`).join('；');
    throw new BackupError(`恢复前核验未过（产物不可信，拒绝装载）：${bad}`, 'pre-verify');
  }
  checks.push(ok('pre-verify', `T4 离线验证 ${pre.checks.length} 项全过（恢复侧复用）`));

  const manifest = JSON.parse(
    await readFile(path.join(opts.dataItemDir, 'manifest.json'), 'utf8'),
  ) as BackupManifest;

  // 2. 目标全新（§7 前置「持久卷可写」的落地面：恢复不得覆盖既有实例）
  if (!(await targetFresh(opts.dataDir))) {
    throw new BackupError(
      `目标数据目录非全新（${opts.dataDir} 下 db/git/config/keys 存在内容）——全新环境恢复不得覆盖既有实例；如确需重做，请清空目标后重试`,
      'target-fresh',
    );
  }
  checks.push(ok('target-fresh', opts.dataDir));

  // 3. 版本兼容（§7 步骤 6；D-BR-05）
  const schemaNow = opts.schemaVersion ?? currentSchemaVersion();
  const appNow = opts.appVersion ?? (await readAppVersion());
  if (manifest.db.schema_version > schemaNow) {
    throw new BackupError(
      `版本兼容失败：manifest schema 版本 ${manifest.db.schema_version} 高于当前镜像 ${schemaNow}——不支持降级（D-BR-05）；请以不低于备份版本的镜像重试（§9 升级路径）`,
      'version-compat',
    );
  }
  const notes: string[] = [`schema ${manifest.db.schema_version}→${schemaNow === manifest.db.schema_version ? '同版' : `${schemaNow}（启动时前向迁移，§9）`}`];
  if (manifest.app_version !== appNow) {
    notes.push(`app ${manifest.app_version}→${appNow}（不同版：升级/兼容矩阵走 §9，数据面恢复不阻断）`);
  }
  checks.push(ok('version-compat', notes.join('；')));

  // 4. §7 顺序装载：config → keys → db → git（失败清扫已建域，目标回到全新态）
  const created: string[] = [];
  try {
    await cp(path.join(opts.dataItemDir, 'config'), path.join(opts.dataDir, 'config'), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    checks.push(ok('config-restored', '§7 步骤 2（K3/K4 属部署层记录，随密钥件同置保管——B6 口径）'));

    await cp(path.join(opts.keysItemDir, 'keys'), path.join(opts.dataDir, 'keys'), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    // 权限强制（identity §6.1：keys 目录 0700、文件 0600——不信任来源/umask）
    await chmod(path.join(opts.dataDir, 'keys'), 0o700);
    for (const f of await listFilesUnder(path.join(opts.dataDir, 'keys'))) {
      await chmod(f, 0o600);
    }
    checks.push(ok('keys-restored', '§7 步骤 3（含迁移期 retired 条目；0600/0700 已强制）'));

    await mkdir(path.join(opts.dataDir, 'db'), { recursive: true });
    await cp(
      path.join(opts.dataItemDir, 'db', 'notegit.sqlite'),
      path.join(opts.dataDir, 'db', 'notegit.sqlite'),
      { force: false, errorOnExist: true, preserveTimestamps: true },
    );
    checks.push(ok('db-restored', '§7 步骤 4（引擎快照回灌——VACUUM INTO 产物为独立文件，无 WAL 伴生）'));

    await cp(path.join(opts.dataItemDir, 'git'), path.join(opts.dataDir, 'git'), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    checks.push(ok('git-restored', `§7 步骤 5（${manifest.vault_count} 库，保留权限与时间戳）`));
  } catch (err) {
    for (const domain of [opts.dataDir, ...created]) {
      await rm(domain, { recursive: true, force: true }).catch(() => {});
    }
    for (const domain of DOMAINS) {
      await rm(path.join(opts.dataDir, domain), { recursive: true, force: true }).catch(() => {});
    }
    throw new BackupError(
      `装载失败（已清扫，目标回到全新态）：${err instanceof Error ? err.message : String(err)}`,
      'load',
    );
  }

  // 5. 装载后完整性（「恢复后完整性核对」）
  const post = await postLoadIntegrity(opts.dataDir, manifest);
  checks.push(...post);
  if (post.some((c) => !c.ok)) {
    for (const domain of DOMAINS) {
      await rm(path.join(opts.dataDir, domain), { recursive: true, force: true }).catch(() => {});
    }
    const bad = post.filter((c) => !c.ok).map((c) => `${c.name}：${c.detail ?? ''}`).join('；');
    throw new BackupError(`装载后完整性核对未过（已清扫）：${bad}`, 'post-load');
  }

  return { manifest, checks };
}

// ───────────────────────── §7 步骤 7：只读对账（T6 衔接缝） ─────────────────────────

export interface ReconcileResult {
  readonly ok: boolean;
  /** 残留 pending/待核对发布行（异常态——处置属 S8-T6，本核对拒绝放行） */
  readonly residue: readonly PendingReconciliationRow[];
  /** 成链差异（ref 实际 OID vs 审计 old→new 链尾；空 = 一致） */
  readonly chainDiffs: readonly string[];
  readonly refsChecked: number;
}

/** unborn 起点（DDL 注释：首推 old 为 NULL；全零 OID 同态） */
function isGenesisOid(oid: string | null): boolean {
  return oid === null || oid === '0'.repeat(40);
}

/**
 * 恢复对账核对（§7 步骤 7 / §5 不变量 1–2，只读）：
 * - 残留：pending/unresolved 发布行 = 排空保证的恢复侧复核（异常态处置属 T6）；
 * - 成链：每库每 ref 的成功事件 old→new 有序相邻，链尾 == ref 当前 OID——
 *   「审计成功但 ref 未更新」与「ref 越过审计链」（半应用写两向）均点名。
 */
export async function restoreReconcile(db: DatabaseSync, gitRoot: string): Promise<ReconcileResult> {
  const residue = listPendingReconciliation(db);
  const chainDiffs: string[] = [];
  let refsChecked = 0;

  const vaults = db.prepare('SELECT id, slug FROM vaults ORDER BY id').all() as { id: number; slug: string }[];
  for (const v of vaults) {
    const chain = auditChain(db, v.id);
    const repo = path.join(gitRoot, vaultRepoDirName(v.id));
    const refsRes = await tryGit([
      '--git-dir',
      repo,
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads',
    ]);
    const actualRefs = new Map<string, string>();
    if (refsRes.code === 0) {
      for (const line of refsRes.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        const [ref, oid] = trimmed.split(/\s+/);
        if (ref !== undefined && oid !== undefined) actualRefs.set(ref, oid);
      }
    }

    for (const [ref, oid] of actualRefs) {
      refsChecked += 1;
      const rows = chain.filter((r) => r.ref_name === ref);
      if (rows.length === 0) {
        chainDiffs.push(`库 ${v.slug} ${ref} 实际 ${oid.slice(0, 10)}… 无成功发布记录（refs-审计一致破缺）`);
        continue;
      }
      let prev: string | null = null;
      let adjacencyOk = true;
      for (const row of rows) {
        if (prev !== null && row.old_commit !== prev) adjacencyOk = false;
        prev = row.new_commit;
      }
      if (!adjacencyOk) {
        chainDiffs.push(`库 ${v.slug} ${ref} 成功事件 old→new 不相邻成链`);
      }
      if (prev !== oid) {
        chainDiffs.push(
          `库 ${v.slug} ${ref} 实际 ${oid.slice(0, 10)}… ≠ 链尾 ${prev?.slice(0, 10) ?? 'unborn'}…（半应用写）`,
        );
      }
    }
    // 逆核对：审计有成功记录的 ref 已不存在（v1 禁删 ref——出现即差异）
    const refNames = new Set(actualRefs.keys());
    for (const row of chain) {
      if (row.ref_name !== null && !refNames.has(row.ref_name)) {
        chainDiffs.push(`库 ${v.slug} ${row.ref_name} 有成功记录但 ref 不存在`);
      }
    }
  }

  return { ok: residue.length === 0 && chainDiffs.length === 0, residue, chainDiffs, refsChecked };
}

// ───────────────────────── §7 步骤 7/9：finalize（实例侧触发） ─────────────────────────

export interface FinalizeOptions {
  /** 恢复实例基地址（应用已以 NOTEGIT_MAINTENANCE_ON_START=1 启动） */
  readonly baseUrl: string;
  /** 实例管理员 Bearer 凭据（恢复的管理员令牌——同库同 pepper 即有效） */
  readonly token: string;
  /** 目标实例数据目录（直连库做只读对账——backup CLI 同款直连形态） */
  readonly dataDir: string;
  /** 维护控制缝（缺省 httpMaintenanceControl；测试可注入） */
  readonly control?: MaintenanceControl;
  /** 重建等待上限（缺省 120 秒） */
  readonly rebuildTimeoutMs?: number;
  /** 重建轮询间隔（缺省 500ms） */
  readonly pollMs?: number;
}

export interface FinalizeResult {
  readonly reconcile: ReconcileResult;
  /** 重建终态面（state/total/done/finished_at） */
  readonly rebuild: { state: string; total: number; done: number; finished_at: string | null };
}

/** §7 步骤 7（对账）+ 步骤 9（重建）的实例侧触发——不退出维护（步骤 10 属显式操作） */
export async function restoreFinalize(opts: FinalizeOptions): Promise<FinalizeResult> {
  const control = opts.control ?? httpMaintenanceControl({ baseUrl: opts.baseUrl, token: opts.token });

  await control.healthCheck();
  if (!(await control.isEnabled())) {
    throw new BackupError(
      'finalize 必须在维护模式内执行（§7 步骤 1/7：恢复核对与重建在维护内完成）——请以 NOTEGIT_MAINTENANCE_ON_START=1 启动实例后重试',
      'maintenance',
    );
  }

  // §7 步骤 7：只读对账（直连目标库；异常态残留由 S8-T6 处置后再来）
  const db = openDatabase(path.join(opts.dataDir, 'db', 'notegit.sqlite'));
  let reconcile: ReconcileResult;
  try {
    reconcile = await restoreReconcile(db, path.join(opts.dataDir, 'git'));
  } finally {
    db.close();
  }
  if (!reconcile.ok) {
    const residueMsg = reconcile.residue
      .slice(0, 5)
      .map((r) => `#${r.id} ${r.status} ${r.ref_name ?? ''} new=${r.new_commit?.slice(0, 10) ?? '—'}`)
      .join('；');
    throw new BackupError(
      `恢复对账未过（§5 不变量 1–2）——残留 ${reconcile.residue.length} 行：${residueMsg}；成链差异 ${reconcile.chainDiffs.length} 条：${reconcile.chainDiffs.slice(0, 5).join('；')}。异常态处置（pending/待核对标终态）属恢复对账任务（S8-T6），处置后重跑 finalize`,
      'reconcile',
    );
  }

  // §7 步骤 9：S5-T5 全量重建（实例端点触发——allowlist 已裁，维护内放行）
  const headers = { authorization: `Bearer ${opts.token}` };
  const trigger = await fetch(`${opts.baseUrl}/api/v1/admin/search-index/rebuild`, {
    method: 'POST',
    headers,
  });
  if (trigger.status !== 202 && trigger.status !== 409) {
    const body = await trigger.text();
    throw new BackupError(
      `触发全量重建失败：POST /api/v1/admin/search-index/rebuild → ${trigger.status} ${body.slice(0, 120)}`,
      'rebuild',
    );
  }
  const deadline = Date.now() + (opts.rebuildTimeoutMs ?? 120_000);
  const pollMs = opts.pollMs ?? 500;
  for (;;) {
    const face = await fetch(`${opts.baseUrl}/api/v1/admin/search-index`, { headers });
    if (face.status !== 200) {
      throw new BackupError(`重建进度面不可达：GET → ${face.status}`, 'rebuild');
    }
    const parsed = (await face.json()) as { rebuild?: { state?: string; total?: number; done?: number; finished_at?: string | null } };
    const status = parsed.rebuild;
    if (status?.state === 'completed') {
      return {
        reconcile,
        rebuild: {
          state: status.state,
          total: status.total ?? 0,
          done: status.done ?? 0,
          finished_at: status.finished_at ?? null,
        },
      };
    }
    if (Date.now() > deadline) {
      throw new BackupError(
        `全量重建等待超时（state=${status?.state ?? '未知'}，done=${status?.done ?? 0}/${status?.total ?? '?'}）`,
        'rebuild-timeout',
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
