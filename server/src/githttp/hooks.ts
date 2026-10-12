import path from 'node:path';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runGit } from './git-spawn.ts';

/**
 * receive-pack 服务侧仓库准备（S3-T2）：服务首个推送请求前完成（幂等）——
 *
 * 1. `receive.denyNonFastForwards=true`（架构 §4.3「禁止强制推送」；原生
 *    receive-pack 拦截即 B3 被测实现——非快进整包拒绝且 ref 不变）。
 * 2. pre-receive/update/post-receive 三个挂接点 shim（exec node 指向本目录
 *    服务端脚本）：T4（逐提交校验）/T5（执行点复查）/T6（审计终态）消费。
 *    本任务为 pre-receive 装初始逐 ref 授权 + 占位内容校验；update/post-receive
 *    为直通占位。
 *
 * 惰性安装（而非建库时）：T1 建库无 hook 语义；此前已建的仓库在首个 HTTP 推送
 * 请求（含 refs 广告）时补齐。文件写入用临时名 + rename 原子替换——并发首推
 * 不会执行到半写 shim。
 */

const HOOK_NAMES = ['pre-receive', 'update', 'post-receive'] as const;

export async function ensureReceiveSetup(repoPath: string): Promise<void> {
  await runGit(['--git-dir', repoPath, 'config', 'receive.denyNonFastForwards', 'true']);
  const hooksDir = path.join(repoPath, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  for (const name of HOOK_NAMES) {
    await installHookShim(hooksDir, name, path.join(scriptDir, `${name}.ts`));
  }
}

async function installHookShim(hooksDir: string, name: string, scriptPath: string): Promise<void> {
  const target = path.join(hooksDir, name);
  const shim = `#!/bin/sh\nexec node "${scriptPath}"\n`;
  try {
    if ((await readFile(target, 'utf8')) === shim) return; // 幂等：内容一致不重写
  } catch {
    // 尚未安装——落盘
  }
  const tmp = path.join(hooksDir, `${name}.tmp-${process.pid.toString()}`);
  await writeFile(tmp, shim, { mode: 0o755 });
  await rename(tmp, target);
  await chmod(target, 0o755); // rename 后钉住可执行位（git 只执行可执行 hook）
}
