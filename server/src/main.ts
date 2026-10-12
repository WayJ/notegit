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
