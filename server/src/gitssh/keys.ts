/**
 * SSH 公钥登记册（Git SSH 传输面）：员工公钥 → 员工身份的映射与吊销。
 *
 * - 权威在 notegit 侧：SSH 会话只认登记册里的公钥（指纹白名单），公钥文本本身
 *   由登记册持有（吊销即刻生效，无需重启、无需重签）。
 * - 指纹取 OpenSSH 形态 `SHA256:<base64(sha256(公钥 wire blob))>`（无 padding）——
 *   与 `ssh-keygen -lf` 同款，成员可自行比对。
 * - 公钥文本只经管理面登记（dshent 平台代成员登记），员工无自助签发面。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import ssh2 from 'ssh2';

const { utils: sshUtils } = ssh2;

/** 登记册行（wire blob 以 base64 存；明文私钥永不进此表）。 */
export interface SshKeyRecord {
  readonly id: number;
  readonly employeeId: number;
  readonly keyType: string;
  readonly fingerprint: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

/** 公钥解析结果（wire blob 为 SSH wire 形态，可直接与认证时 offered key 比对）。 */
export interface ParsedPublicKey {
  readonly keyType: string;
  readonly blob: Buffer;
  readonly fingerprint: string;
}

/** OpenSSH 指纹：SHA256:base64(sha256(blob))（无 padding）。 */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/**
 * 解析公钥文本——接受两种常见形态：
 * 1. 完整 authorized_keys 行（`ssh-ed25519 AAAA... comment`）；
 * 2. 裸 base64 公钥 blob。
 * 指纹行（`SHA256:...`）不是公钥，登记面拒收。
 */
export function parsePublicKey(text: string): ParsedPublicKey | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('SHA256:')) return null;
  const fields = trimmed.split(/\s+/);
  const blobCandidate = fields.length >= 2 ? fields[1]! : fields[0]!;
  const parsed = sshUtils.parseKey(Buffer.from(blobCandidate, 'base64'));
  if (parsed instanceof Error) return null;
  const blob = parsed.getPublicSSH();
  if (blob === null) return null;
  return { keyType: parsed.type, blob, fingerprint: fingerprintOf(blob) };
}

export interface SshKeyRegistryOptions {
  readonly db: DatabaseSync;
  readonly now?: () => string;
}

/** 公钥登记册（DB 真源）。 */
export class SshKeyRegistry {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: SshKeyRegistryOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 登记公钥；同指纹已登记（未吊销）返回既有行——重复登记幂等。 */
  register(employeeId: number, parsed: ParsedPublicKey, label: string | null): SshKeyRecord {
    const existing = this.resolve(parsed.fingerprint);
    if (existing !== null) {
      if (existing.employeeId !== employeeId) {
        throw new Error('ssh key already registered by another employee');
      }
      return existing;
    }
    const createdAt = this.now();
    const info = this.db
      .prepare(
        `insert into ssh_keys (employee_id, key_type, key_fingerprint, key_blob, label, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        employeeId,
        parsed.keyType,
        parsed.fingerprint,
        parsed.blob.toString('base64'),
        label,
        createdAt,
      );
    return {
      id: Number(info.lastInsertRowid),
      employeeId,
      keyType: parsed.keyType,
      fingerprint: parsed.fingerprint,
      label,
      createdAt,
      revokedAt: null,
    };
  }

  /** 指纹 → 活登记行（吊销即不可见）。 */
  resolve(fingerprint: string): SshKeyRecord | null {
    const rows = this.db
      .prepare(
        `select id, employee_id, key_type, key_fingerprint, label, created_at, revoked_at
         from ssh_keys where key_fingerprint = ? and revoked_at is null`,
      )
      .all(fingerprint) as {
      id: number;
      employee_id: number;
      key_type: string;
      key_fingerprint: string;
      label: string | null;
      created_at: string;
      revoked_at: string | null;
    }[];
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      employeeId: row.employee_id,
      keyType: row.key_type,
      fingerprint: row.key_fingerprint,
      label: row.label,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  /** 员工的登记清单（含已吊销——管理面要能看见「曾登记过」）。 */
  list(employeeId: number): SshKeyRecord[] {
    const rows = this.db
      .prepare(
        `select id, employee_id, key_type, key_fingerprint, label, created_at, revoked_at
         from ssh_keys where employee_id = ? order by id`,
      )
      .all(employeeId) as {
      id: number;
      employee_id: number;
      key_type: string;
      key_fingerprint: string;
      label: string | null;
      created_at: string;
      revoked_at: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      keyType: row.key_type,
      fingerprint: row.key_fingerprint,
      label: row.label,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  /** 吊销（软删——审计留痕）；不存在或非本人则 false。 */
  revoke(employeeId: number, id: number): boolean {
    const info = this.db
      .prepare(
        `update ssh_keys set revoked_at = ? where id = ? and employee_id = ? and revoked_at is null`,
      )
      .run(this.now(), id, employeeId);
    return Number(info.changes) > 0;
  }
}
