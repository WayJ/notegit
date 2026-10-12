import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db/connection.ts';
import { migrate } from './db/migrate.ts';
import { MIGRATIONS } from './db/migrations.ts';
import { buildApp, type PasswordHasher } from './app.ts';
import type { RequestAuthenticator } from './auth/lifecycle.ts';
import { loadOrCreatePepper } from './bootstrap/pepper.ts';
import { ensureBootstrapToken } from './bootstrap/token.ts';
import { isUninitialized } from './bootstrap/state.ts';
import { sweepOrphanedPending } from './audit/reconciliation.ts';
import { sweepVaultResidue } from './gitrepo/hygiene.ts';

/**
 * 启动接线（S2-T1 交接，architecture-notes §3）：open → pragmas（openDatabase 内）→
 * migrate → （首次初始化：pepper K1 自动生成 + 空库时 bootstrap token 落盘）→ listen。
 * 数据目录默认 /data（容器持久卷布局，backup §2），可用 NOTEGIT_DATA_DIR 覆盖（测试用 tmp）。
 */

export const DEFAULT_DATA_DIR = '/data';

export interface StartOptions {
  readonly dataDir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly authenticateRequest?: RequestAuthenticator;
  readonly hashPassword?: PasswordHasher;
}

export interface StartedApp {
  readonly app: FastifyInstance;
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly bootstrapTokenFile: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startApp(opts: StartOptions = {}): Promise<StartedApp> {
  const dataDir = opts.dataDir ?? process.env.NOTEGIT_DATA_DIR ?? DEFAULT_DATA_DIR;
  const dbFile = path.join(dataDir, 'db', 'notegit.sqlite');
  await mkdir(path.dirname(dbFile), { recursive: true });

  const db = openDatabase(dbFile); // open + pragmas（WAL / busy_timeout / foreign_keys）
  try {
    migrate(db, MIGRATIONS);

    // S3-T6 启动清扫（storage-model §6 步骤 4 的运行侧锚点）：单进程假设（架构 §9、
    // backup §3）下启动时不存在在途写——残留 pending 发布行皆上次进程崩溃所留，标
    // 待核对（unresolved），由 S8 恢复对账按引用实际 OID 定终态（backup §7 步骤 7）。
    const swept = sweepOrphanedPending(db, { reason: 'startup-orphan' });
    if (swept > 0) {
      console.warn(`[notegit] 启动清扫：${swept} 行残留 pending 审计已标待核对（unresolved）`);
    }

    // S3-T8 库目录残留清理（listen 前——单进程假设下启动无在途写，三类残留
    // 皆上次进程生命周期所留：notegit-push-*.bytes 计数文件 / objects/incoming-*
    // 隔离目录 / 拒绝发布残留的无引用松对象 git prune——E-LIMIT-005 容量口径回收）
    const hygiene = await sweepVaultResidue(dataDir);
    if (hygiene.bytesFiles + hygiene.quarantineDirs + hygiene.prunedRepos > 0) {
      console.warn(
        `[notegit] 启动清理：${hygiene.bytesFiles} 个推送计量残留、${hygiene.quarantineDirs} 个隔离目录、${hygiene.prunedRepos} 个库执行松对象 prune`,
      );
    }

    const pepperFile = path.join(dataDir, 'keys', 'token-pepper.key');
    if (!isUninitialized(db) && !existsSync(pepperFile)) {
      // 已有账号却无 pepper：重生成会静默废掉全部已存哈希——大声失败，走备份恢复（identity §6.1）
      throw new Error(`pepper missing on initialized instance: ${pepperFile} — restore /data/keys from the key backup`);
    }
    const pepper = await loadOrCreatePepper(pepperFile);

    const bootstrapTokenFile = path.join(dataDir, 'config', 'admin-bootstrap.token');
    await ensureBootstrapToken(db, pepper, bootstrapTokenFile, new Date());

    const app = buildApp({
      db,
      pepper,
      bootstrapTokenFile,
      dataDir, // S3-T1：建库端点真实 init bare 于 <dataDir>/git/<id>.git
      dbFile, // S3-T2：/git 入口透传 NOTEGIT_DB 给 pre-receive hook 直连
      authenticateRequest: opts.authenticateRequest,
      hashPassword: opts.hashPassword,
    });
    const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
    const port = opts.port ?? Number(process.env.PORT ?? 3000);
    await app.listen({ host, port }); // listen 最后
    const bound = app.addresses()[0];
    if (bound === undefined) throw new Error('listen returned no bound address');
    return {
      app,
      db,
      dataDir,
      bootstrapTokenFile,
      port: bound.port,
      close: async () => {
        await app.close();
        db.close();
      },
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      // 启动失败路径：句柄可能未就绪
    }
    throw err;
  }
}

// CLI 入口（npm start）：仅当作为主模块执行时启动
if (import.meta.url === `file://${process.argv[1]}`) {
  const inst = await startApp();
  console.log(`notegit listening on http://${inst.app.addresses()[0]?.address}:${inst.port} (data: ${inst.dataDir})`);
}
