import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { tryGit } from './git.ts';
import { vaultRepoDirName, parseVaultRepoDirName } from '../vaults/repo-path.ts';
import {
  REQUIRED_MANIFEST_FIELDS,
  type BackupManifest,
  type BackupManifestFileEntry,
} from './manifest.ts';

export type { BackupManifest };

/**
 * 离线验证（S8-T4；backup-recovery §4 步骤 8「manifest 在、件数齐、抽样哈希核对」
 * ——契约「备份件校验命令」待定项（§10）随本任务固化；D5 演练与 S8-T5 恢复前置
 * 消费同一命令）。
 *
 * 离线形态：**不起服务、不连实例**——全部核对只落在备份产物本身（文件复算 +
 * 快照库只读打开 + git 复制件）。核对项：
 *
 * 1. manifest-present：数据件内 manifest.json 在且可解析（第一核对项，缺即止）；
 * 2. manifest-fields：REQUIRED_MANIFEST_FIELDS 逐项在（防字段漂移）；
 * 3. items-present：两件齐备（数据件三域 + 密钥件；密钥件缺位即败——D-BR-04）；
 * 4. key-item-perms：密钥件文件 0600、件根/keys 目录 0700（备份 §6）；
 * 5. file-count：实际文件集合 == manifest 文件清单（两件；多/少/被换都算不齐）；
 * 6. file-hashes：清单逐文件复算字节与 SHA-256（覆盖两件全部内容文件——比契约
 *    要求的「抽样」更强）；
 * 7. item-bytes：各件/各域字节合计 == manifest（「各件字节数」字段核对）；
 * 8. db-integrity：快照库只读打开 + PRAGMA integrity_check = ok；
 * 9. vault-match：快照库 vaults 行（数/slug/默认分支）与 manifest 互证；
 * 10. head-oid：每库复制件 rev-parse == manifest 记录（unborn ⇔ null 互证；
 *     D-BR-03 每库 HEAD OID 的恢复核对前置）；
 * 11. git-fsck（可选 --fsck）：全量复制件 fsck（快照时抽样的离线全量复核）。
 *
 * 结果聚合：除 1（缺 manifest 无法继续）外全部核对尽力执行并逐项呈现——一次给
 * 出完整核对单，便于演练留档与故障定位。
 */

export interface VerifyCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly checks: readonly VerifyCheck[];
}

export interface VerifyOptions {
  /** 数据件目录（含 manifest.json） */
  readonly dataItemDir: string;
  /** 密钥件目录（缺省按 manifest.items.keys.dir_name 在数据件同级解析；分置跨介质时显式传） */
  readonly keysItemDir?: string;
  /** 全量复制件 fsck（缺省 false） */
  readonly fsck?: boolean;
}

function ok(name: string, detail?: string): VerifyCheck {
  return { name, ok: true, ...(detail !== undefined ? { detail } : {}) };
}
function fail(name: string, detail?: string): VerifyCheck {
  return { name, ok: false, ...(detail !== undefined ? { detail } : {}) };
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** 递归列举相对路径（与 snapshot.listContentFiles 同排序语义，独立实现防循环依赖） */
async function listContentFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
  await walk(root);
  return out.sort();
}

function dig(obj: unknown, fieldPath: string): boolean {
  let cur: unknown = obj;
  for (const seg of fieldPath.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return true;
}

async function hashSetMismatch(
  itemRoot: string,
  entries: readonly BackupManifestFileEntry[],
): Promise<string | null> {
  const diffs: string[] = [];
  for (const entry of entries) {
    const abs = path.join(itemRoot, entry.path);
    if (!existsSync(abs)) {
      diffs.push(`${entry.path} 缺失`);
      continue;
    }
    const size = (await stat(abs)).size;
    const hash = await sha256File(abs);
    if (size !== entry.bytes || hash !== entry.sha256) {
      diffs.push(`${entry.path} 复算不一致（bytes ${size}≠${entry.bytes} 或 sha256 不符）`);
    }
  }
  return diffs.length === 0 ? null : diffs.slice(0, 5).join('；');
}

/** 清单内文件的字节合计（合计口径与 snapshot 一致：内容文件，不含 manifest.json） */
async function treeBytes(root: string, rels: readonly string[]): Promise<number> {
  let total = 0;
  for (const rel of rels) {
    total += (await stat(path.join(root, rel))).size;
  }
  return total;
}

export async function verifyBackupSet(opts: VerifyOptions): Promise<VerifyResult> {
  const checks: VerifyCheck[] = [];

  // 1. manifest 在且可解析（第一核对项——缺即止，后续无从谈起）
  const manifestPath = path.join(opts.dataItemDir, 'manifest.json');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
  } catch (err) {
    checks.push(fail('manifest-present', `manifest.json 不可读/不可解析：${err instanceof Error ? err.message : String(err)}`));
    return { ok: false, checks };
  }
  checks.push(ok('manifest-present', `backup_id=${manifest.backup_id}`));

  // 2. 必填字段逐项在
  const missing = REQUIRED_MANIFEST_FIELDS.filter((f) => !dig(manifest, f));
  checks.push(
    missing.length === 0
      ? ok('manifest-fields', `${REQUIRED_MANIFEST_FIELDS.length} 项必填字段齐`)
      : fail('manifest-fields', `缺字段：${missing.join('、')}`),
  );

  // 3. 两件齐备（D-BR-04：缺密钥件 = 恢复后 token/会话全断——必须在此暴露）
  const keysItemDir =
    opts.keysItemDir ?? path.join(path.dirname(path.resolve(opts.dataItemDir)), manifest.items.keys.dir_name);
  const domainsOk =
    existsSync(path.join(opts.dataItemDir, 'db', 'notegit.sqlite')) &&
    existsSync(path.join(opts.dataItemDir, 'git')) &&
    existsSync(path.join(opts.dataItemDir, 'config'));
  const keysOk = existsSync(keysItemDir) && existsSync(path.join(keysItemDir, 'keys'));
  checks.push(
    domainsOk && keysOk
      ? ok('items-present', `data=${manifest.items.data.dir_name} keys=${manifest.items.keys.dir_name}`)
      : fail(
          'items-present',
          `${domainsOk ? '' : '数据件三域（db/git/config）不齐；'}${keysOk ? '' : `密钥件缺位（找过 ${keysItemDir}；分置跨介质请显式传 keysItemDir）`}`,
        ),
  );

  // 4. 密钥件权限（backup §6：文件 0600、目录 0700）
  if (keysOk) {
    const keyFiles = await listContentFiles(keysItemDir);
    let permBad: string[] = [];
    const rootMode = (await stat(keysItemDir)).mode & 0o777;
    if (rootMode !== 0o700) permBad.push(`件根 ${rootMode.toString(8)}≠700`);
    const keysDirMode = (await stat(path.join(keysItemDir, 'keys'))).mode & 0o777;
    if (keysDirMode !== 0o700) permBad.push(`keys 目录 ${keysDirMode.toString(8)}≠700`);
    for (const rel of keyFiles) {
      const mode = (await stat(path.join(keysItemDir, rel))).mode & 0o777;
      if (mode !== 0o600) permBad.push(`${rel} ${mode.toString(8)}≠600`);
    }
    checks.push(permBad.length === 0 ? ok('key-item-perms', `${keyFiles.length} 个文件 0600`) : fail('key-item-perms', permBad.slice(0, 5).join('；')));
  } else {
    checks.push(fail('key-item-perms', '密钥件缺位，无法核对权限'));
  }

  // 5–7. 文件清单、哈希与字节合计（两件）
  if (existsSync(opts.dataItemDir) && keysOk) {
    const actualData = (await listContentFiles(opts.dataItemDir)).filter((p) => p !== 'manifest.json');
    const manifestData = manifest.items.data.files.map((f) => f.path).sort();
    const actualKeys = await listContentFiles(keysItemDir);
    const manifestKeys = manifest.items.keys.files.map((f) => f.path).sort();
    const extra = [...actualData, ...actualKeys].length - (manifestData.length + manifestKeys.length);
    const listBad: string[] = [];
    if (actualData.length !== manifestData.length || extra !== 0) {
      listBad.push(`件内文件数与清单不符（data 实际 ${actualData.length} vs 清单 ${manifestData.length}）`);
    }
    const onlyActual = actualData.filter((p) => !manifestData.includes(p)).slice(0, 3);
    const onlyManifest = manifestData.filter((p) => !actualData.includes(p)).slice(0, 3);
    if (onlyActual.length > 0) listBad.push(`多出清单外文件：${onlyActual.join('、')}`);
    if (onlyManifest.length > 0) listBad.push(`清单文件缺位：${onlyManifest.join('、')}`);
    checks.push(listBad.length === 0 ? ok('file-count', `${manifestData.length + manifestKeys.length} 个文件齐`) : fail('file-count', listBad.join('；')));

    const dataDiffs = await hashSetMismatch(opts.dataItemDir, manifest.items.data.files);
    const keysDiffs = await hashSetMismatch(keysItemDir, manifest.items.keys.files);
    checks.push(
      dataDiffs === null && keysDiffs === null
        ? ok('file-hashes', `data ${manifest.items.data.files.length} + keys ${manifest.items.keys.files.length} 个文件复算一致`)
        : fail('file-hashes', [dataDiffs, keysDiffs].filter((d): d is string => d !== null).join('；')),
    );

    const dataSize = await treeBytes(path.join(opts.dataItemDir), actualData);
    const keysSize = await treeBytes(keysItemDir, actualKeys);
    const bytesBad: string[] = [];
    if (dataSize !== manifest.items.data.bytes) bytesBad.push(`data 件 ${dataSize}≠${manifest.items.data.bytes}`);
    if (keysSize !== manifest.items.keys.bytes) bytesBad.push(`keys 件 ${keysSize}≠${manifest.items.keys.bytes}`);
    checks.push(bytesBad.length === 0 ? ok('item-bytes', `data ${manifest.items.data.bytes}B / keys ${manifest.items.keys.bytes}B`) : fail('item-bytes', bytesBad.join('；')));
  } else {
    checks.push(fail('file-count', '件缺位，跳过'));
    checks.push(fail('file-hashes', '件缺位，跳过'));
    checks.push(fail('item-bytes', '件缺位，跳过'));
  }

  // 8–9. 快照库完整性 + 库行互证
  const snapDbPath = path.join(opts.dataItemDir, 'db', 'notegit.sqlite');
  if (existsSync(snapDbPath)) {
    let snap: DatabaseSync | null = null;
    try {
      snap = new DatabaseSync(snapDbPath, { readOnly: true });
      const integrity = (snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      checks.push(integrity === 'ok' ? ok('db-integrity') : fail('db-integrity', `integrity_check=${integrity}`));

      const rows = snap.prepare('SELECT id, slug, default_branch FROM vaults ORDER BY id').all() as {
        id: number;
        slug: string;
        default_branch: string;
      }[];
      const manifestMap = new Map(manifest.vaults.map((v) => [v.id, v]));
      const rowDiffs: string[] = [];
      if (rows.length !== manifest.vaults.length || manifest.vault_count !== manifest.vaults.length) {
        rowDiffs.push(`库数 ${rows.length} vs manifest ${manifest.vaults.length}`);
      }
      for (const row of rows) {
        const m = manifestMap.get(row.id);
        if (m === undefined) {
          rowDiffs.push(`快照库 ${row.id}(${row.slug}) 不在 manifest`);
          continue;
        }
        if (m.slug !== row.slug || m.default_branch !== row.default_branch) {
          rowDiffs.push(`库 ${row.id} slug/分支不符（${m.slug}/${m.default_branch} vs ${row.slug}/${row.default_branch}）`);
        }
      }
      for (const v of manifest.vaults) {
        if (!rows.some((r) => r.id === v.id)) rowDiffs.push(`manifest 库 ${v.id}(${v.slug}) 不在快照`);
      }
      checks.push(rowDiffs.length === 0 ? ok('vault-match', `${rows.length} 库互证一致`) : fail('vault-match', rowDiffs.slice(0, 5).join('；')));
    } catch (err) {
      checks.push(fail('db-integrity', `快照库只读打开失败：${err instanceof Error ? err.message : String(err)}`));
      checks.push(fail('vault-match', '快照库不可打开'));
    } finally {
      snap?.close();
    }
  } else {
    checks.push(fail('db-integrity', '快照库缺位'));
    checks.push(fail('vault-match', '快照库缺位'));
  }

  // 10. HEAD OID 互证（复制件 rev-parse vs manifest；unborn ⇔ null）
  const gitRoot = path.join(opts.dataItemDir, 'git');
  if (existsSync(gitRoot) && Array.isArray(manifest.vaults)) {
    const headDiffs: string[] = [];
    for (const v of manifest.vaults) {
      const repo = path.join(gitRoot, vaultRepoDirName(v.id));
      if (!existsSync(repo)) {
        headDiffs.push(`库 ${v.id} 复制件缺位`);
        continue;
      }
      const r = await tryGit([
        '--git-dir',
        repo,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${v.default_branch}^{commit}`,
      ]);
      const actual = r.code === 0 ? r.stdout.trim() : null;
      if (actual !== v.head_oid) {
        headDiffs.push(`库 ${v.id}(${v.slug}) HEAD 实际 ${actual ?? 'unborn'} vs manifest ${v.head_oid ?? 'unborn'}`);
      }
    }
    checks.push(headDiffs.length === 0 ? ok('head-oid', `${manifest.vaults.length} 库互证一致`) : fail('head-oid', headDiffs.slice(0, 5).join('；')));

    // 逆核对：git/ 下不得有 manifest 不认识的库目录（防拼接库目录混入）
    for (const e of await readdir(gitRoot, { withFileTypes: true })) {
      const id = parseVaultRepoDirName(e.name);
      if (id !== undefined && !manifest.vaults.some((v) => v.id === id)) {
        checks.push(fail('head-oid', `复制件含 manifest 外库目录：${e.name}`));
      }
    }
  } else {
    checks.push(fail('head-oid', 'git 复制域缺位'));
  }

  // 11. 可选：全量复制件 fsck（快照抽样之外的离线全量复核）
  if (opts.fsck === true) {
    if (existsSync(gitRoot) && Array.isArray(manifest.vaults)) {
      const fsckBad: string[] = [];
      for (const v of manifest.vaults) {
        const r = await tryGit(['--git-dir', path.join(gitRoot, vaultRepoDirName(v.id)), 'fsck', '--no-progress']);
        if (r.code !== 0) fsckBad.push(`库 ${v.id}(${v.slug}) fsck 失败：${r.stderr.trim().split('\n')[0] ?? ''}`);
      }
      checks.push(fsckBad.length === 0 ? ok('git-fsck', `${manifest.vaults.length} 库全量 fsck 通过`) : fail('git-fsck', fsckBad.slice(0, 5).join('；')));
    } else {
      checks.push(fail('git-fsck', 'git 复制域缺位'));
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
