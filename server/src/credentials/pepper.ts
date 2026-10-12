import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * token/session HMAC pepper（identity §3.2/§6.1 K1）：32B 随机文件、权限 0600、
 * 首次初始化自动生成。文件为版本化列表（D-IC-09）：active（新 HMAC 计算用）
 * + retired[]（仅校验用，各带退役日期）——轮换操作文档留 S2-T8，本模块只提供
 * 存储格式与按版本取键。
 */

export interface PepperKey {
  readonly id: number;
  readonly key: Buffer;
}

export interface PepperSet {
  readonly active: PepperKey;
  readonly retired: readonly PepperKey[];
  /** 按版本取键（active 或 retired）；未知版本 undefined（identity §6.2 校验按版本选键） */
  pepperFor(version: number): PepperKey | undefined;
}

export const DEFAULT_PEPPER_PATH = '/data/keys/token-pepper.key'; // identity §6.1 K1（master 2026-10-12 裁定以此为准）
export const PEPPER_PATH_ENV = 'NOTEGIT_PEPPER_PATH';

/** 部署路径解析：env 覆盖优先，否则契约默认路径 */
export function resolvePepperPath(env: Record<string, string | undefined>): string {
  return env[PEPPER_PATH_ENV] || DEFAULT_PEPPER_PATH;
}

interface StoredKey {
  id: number;
  key: string;
}

interface PepperFile {
  format: number;
  active: StoredKey;
  retired: (StoredKey & { retired_at: string })[];
}

function parseKey(entry: StoredKey, label: string): PepperKey {
  if (!Number.isSafeInteger(entry.id) || entry.id < 1) {
    throw new Error(`pepper ${label} 版本号须为正整数：${String(entry.id)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(entry.key)) {
    throw new Error(`pepper ${label} key 须为 32 字节的 64 位小写 hex`);
  }
  return { id: entry.id, key: Buffer.from(entry.key, 'hex') };
}

/** 加载 pepper 文件；不存在则生成（32B CSPRNG、0600）并写入。单进程假设下无并发竞争。 */
export function loadOrCreatePepper(filePath: string): PepperSet {
  if (!existsSync(filePath)) {
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const fresh: PepperFile = {
      format: 1,
      active: { id: 1, key: randomBytes(32).toString('hex') },
      retired: [],
    };
    writeFileSync(filePath, JSON.stringify(fresh), { mode: 0o600 });
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PepperFile;
  if (parsed.format !== 1) {
    throw new Error(`pepper 文件 format 不支持：${String(parsed.format)}`);
  }
  const active = parseKey(parsed.active, 'active');
  const retired = parsed.retired.map((r, i) => parseKey(r, `retired[${i}]`));
  const ids = new Set<number>();
  for (const k of [active, ...retired]) {
    if (ids.has(k.id)) throw new Error(`pepper 版本号冲突：${k.id}`);
    ids.add(k.id);
  }
  const byId = new Map<number, PepperKey>([[active.id, active], ...retired.map((k) => [k.id, k] as const)]);
  return {
    active,
    retired,
    pepperFor(version: number): PepperKey | undefined {
      return byId.get(version);
    },
  };
}
