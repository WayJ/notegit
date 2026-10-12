import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createDbMembershipSource } from '../vaults/membership.ts';
import type { VaultRole } from '../auth/lifecycle.ts';
import { parseRemoteUser } from './cgi.ts';
import { runGit } from './git-spawn.ts';
import { findFrontmatterViolations, type GitQuery } from './placeholder-validation.ts';

/**
 * pre-receive hook（S3-T2；git receive-pack 在更新任何 ref 之前、全部命令已读入
 * 之后调用；拒绝即整包回滚——多 ref 全有或全无的原生语义）。
 *
 * 认证主体经 CGI 层透传的 REMOTE_USER 取得（api.md §8.4；不信任 commit author，
 * 架构 §4.4）；成员/角色与库配置实时直连库文件查询（NOTEGIT_DB 透传——与
 * Web/API 入口同一 vaults/vault_members 源，D-IC-05 无缓存；在途撤权在
 * HTTP 授权之后、执行点之前发生时在此 fail-closed 拒绝）。
 *
 * 判定层次：
 * 1. 逐 ref 授权（refCommandRejection，架构 §4.3）：tag 命名空间一律拒；默认
 *    分支删除全员拒；main_admin_only 开启时仅库管理员可写默认分支；reader
 *    任何写拒；非默认分支编辑者创建/更新/删除放行。
 * 2. 占位内容校验（placeholder-validation.ts，T4 换装点）：推送范围内全部新
 *    提交逐个检查，先写坏后删不可绕过。
 *
 * 本文件既被 git 作为子进程执行（entry guard），也被单元测试导入其纯判定面
 * （refCommandRejection）——导入不触发 hook 行为。
 */

/** 全零 OID（ref 删除命令的 new 值） */
export const ZERO_OID = '0'.repeat(40);

const isZero = (oid: string) => /^0+$/.test(oid);

export interface RefCommand {
  readonly ref: string;
  readonly oldOid: string;
  readonly newOid: string;
}

export interface RefAuthzConfig {
  readonly defaultBranch: string;
  readonly mainAdminOnly: boolean;
  readonly role: VaultRole;
}

/** 逐 ref 授权判定（架构 §4.3）；返回 null = 放行，否则拒绝原因（hook stderr）。 */
export function refCommandRejection(cmd: RefCommand, cfg: RefAuthzConfig): string | null {
  if (cmd.ref.startsWith('refs/tags/')) {
    return `${cmd.ref}：第一版不支持客户端写入 tag（架构 §4.3）`;
  }
  const isDefault = cmd.ref === `refs/heads/${cfg.defaultBranch}`;
  if (isDefault && isZero(cmd.newOid)) {
    return `${cmd.ref}：不允许删除默认分支（架构 §4.3）`;
  }
  if (cfg.role === 'reader') {
    return `${cmd.ref}：只读成员不可推送`;
  }
  if (isDefault && cfg.mainAdminOnly && cfg.role !== 'admin') {
    return `${cmd.ref}：main_admin_only 已开启，仅库管理员可写默认分支`;
  }
  return null;
}

// ── hook 进程入口（仅当 git 以本文件为可执行脚本调用时运行）────────────────

const invokedAsHook =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsHook) {
  void main();
}

async function main(): Promise<void> {
  let code = 1;
  try {
    code = await check();
  } catch (err) {
    console.error(`[notegit pre-receive] 异常拒绝：${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(code);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', () => resolve(input)); // stdin 不可读不挂死 hook
  });
}

async function check(): Promise<number> {
  const parsed = parseRemoteUser(process.env['REMOTE_USER'] ?? '');
  const dbFile = process.env['NOTEGIT_DB'];
  const slug = process.env['NOTEGIT_VAULT_SLUG'];
  if (parsed === null || dbFile === undefined || slug === undefined) {
    console.error('[notegit pre-receive] 环境缺失（REMOTE_USER/NOTEGIT_DB/NOTEGIT_VAULT_SLUG）——fail-closed 拒绝');
    return 1;
  }
  const commands = (await readStdin())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [oldOid = '', newOid = '', ref = ''] = line.split(' ');
      return { ref, oldOid, newOid } satisfies RefCommand;
    });

  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const membership = createDbMembershipSource(db).lookup(slug, parsed.employeeId);
    if (membership === undefined) {
      console.error(`[notegit pre-receive] employee=${parsed.employeeId} 于 ${slug} 无成员关系（或授权后已撤权）——拒绝`);
      return 1;
    }
    const vault = db
      .prepare('SELECT default_branch, main_admin_only FROM vaults WHERE id = ?')
      .get(membership.vaultId) as { default_branch: string; main_admin_only: number } | undefined;
    if (vault === undefined) {
      console.error(`[notegit pre-receive] vault id=${membership.vaultId} 配置缺失——fail-closed 拒绝`);
      return 1;
    }
    const cfg: RefAuthzConfig = {
      defaultBranch: vault.default_branch,
      mainAdminOnly: vault.main_admin_only === 1,
      role: membership.role,
    };
    const query: GitQuery = (args) => runGit(args, { cwd: process.env['GIT_DIR'] ?? '.' });

    const rejections: string[] = [];
    for (const cmd of commands) {
      const rejection = refCommandRejection(cmd, cfg);
      if (rejection !== null) {
        rejections.push(rejection);
        continue;
      }
      if (isZero(cmd.newOid)) continue; // 删除类命令无新提交可校验
      rejections.push(...(await findFrontmatterViolations(query, cmd.newOid, cmd.oldOid)));
    }
    if (rejections.length > 0) {
      for (const rejection of rejections) console.error(`[notegit pre-receive] 拒绝：${rejection}`);
      return 1;
    }
    console.error(
      `[notegit pre-receive] employee=${parsed.employeeId} ${slug}：${commands.length} 个 ref 命令全部通过`,
    );
    return 0;
  } finally {
    db.close();
  }
}
