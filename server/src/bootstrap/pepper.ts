import { randomBytes } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * K1 pepper（identity §6.1）：32B 随机、/data/keys/token-pepper.key（0600）、首次初始化自动生成。
 * 文件为版本化列表（identity §6.2）：{active, retired[]}；retired 仅校验用，轮换/rehash-on-use
 * 随 S2-T4 落地，本模块当前只消费 active。一次性令牌哈希与其同源（storage-model §3.9 注，
 * D-IC-03 同则）：存储串 `hmac<pepper版本>$<hex>`。
 */

export interface PepperKey {
  readonly version: number;
  readonly key: Buffer;
}

export interface PepperFile {
  readonly active: PepperKey;
  readonly retired: readonly PepperKey[];
}

interface PepperFileJson {
  active: { version: number; key: string };
  retired: { version: number; key: string }[];
}

export async function loadOrCreatePepper(file: string): Promise<PepperFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const fresh: PepperFile = {
      active: { version: 1, key: randomBytes(32) },
      retired: [],
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(toJson(fresh)), { mode: 0o600 });
    return fresh;
  }
  return fromJson(JSON.parse(raw) as PepperFileJson);
}

function toJson(p: PepperFile): PepperFileJson {
  return {
    active: { version: p.active.version, key: p.active.key.toString('hex') },
    retired: p.retired.map((r) => ({ version: r.version, key: r.key.toString('hex') })),
  };
}

function fromJson(j: PepperFileJson): PepperFile {
  return {
    active: { version: j.active.version, key: Buffer.from(j.active.key, 'hex') },
    retired: j.retired.map((r) => ({ version: r.version, key: Buffer.from(r.key, 'hex') })),
  };
}

/** 以 active 键计算存储哈希 `hmac<version>$<hex>`（identity §3.2：内嵌 pepper 版本）。 */
export function hmacTokenHash(pepper: PepperFile, token: string): string {
  const digest = createHmac('sha256', pepper.active.key).update(token, 'utf8').digest('hex');
  return `hmac${pepper.active.version}$${digest}`;
}
