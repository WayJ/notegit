import { DatabaseSync } from 'node:sqlite';

/**
 * 打开文件数据库并应用连接级约定（selection §4：WAL + busy_timeout=5000 必须显式，
 * 否则并发写立即 SQLITE_BUSY；busy_timeout 为每连接属性，WAL 为文件持久属性）。
 * foreign_keys 显式置 ON 以钉住 node:sqlite（RC API）的默认行为。
 * 注意：`:memory:` 库的 journal_mode 恒为 memory，WAL 对其无效。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
