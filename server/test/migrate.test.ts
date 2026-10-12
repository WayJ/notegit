import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { openDatabase } from '../src/db/connection.ts';

// 契约依据 storage-model §3.1：仅前向、有序、可重入检查，历史行不可改。
// 用例 1–6 用合成迁移驱动机制；用例 7 用真实出厂基线验证端到端（S2-T3 起含业务 DDL）。

function memory(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

function rows(db: DatabaseSync, sql: string): unknown[] {
  return db.prepare(sql).all();
}

test('新库按序执行：v2 依赖 v1 的表，applied=[1,2]', () => {
  const db = memory();
  const list = [
    { version: 1, description: 'probe 表', statements: ['CREATE TABLE probe (v TEXT) STRICT', "INSERT INTO probe VALUES ('one')"] },
    { version: 2, description: '追加行', statements: ["INSERT INTO probe VALUES ('two')"] },
  ];
  const result = migrate(db, list);
  assert.deepEqual(result.applied, [1, 2]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(rows(db, 'SELECT v FROM probe ORDER BY v').map((r) => (r as { v: string }).v), ['one', 'two']);
  db.close();
});

test('重入：已应用版本跳过且不重复执行非幂等语句（Review Focus 前向可重入）', () => {
  const db = memory();
  const list = [
    { version: 1, description: 'probe 表', statements: ['CREATE TABLE probe (v TEXT) STRICT', "INSERT INTO probe VALUES ('one')"] },
    { version: 2, description: '追加行', statements: ["INSERT INTO probe VALUES ('two')"] },
  ];
  migrate(db, list);
  const again = migrate(db, list);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, [1, 2]);
  // CREATE TABLE 无 IF NOT EXISTS：若重执行会抛错；INSERT 若重执行会多一行
  assert.equal((rows(db, 'SELECT COUNT(*) AS n FROM probe')[0] as { n: number }).n, 2);
  db.close();
});

test('增量：已应用 [v1] 的库上执行 [v1,v2]，仅 v2 运行', () => {
  const db = memory();
  migrate(db, [{ version: 1, description: 'probe 表', statements: ['CREATE TABLE probe (v TEXT) STRICT'] }]);
  const result = migrate(db, [
    { version: 1, description: 'probe 表', statements: ['CREATE TABLE probe (v TEXT) STRICT'] },
    { version: 2, description: '追加行', statements: ["INSERT INTO probe VALUES ('two')"] },
  ]);
  assert.deepEqual(result.applied, [2]);
  assert.deepEqual(result.skipped, [1]);
  assert.equal((rows(db, 'SELECT COUNT(*) AS n FROM probe')[0] as { n: number }).n, 1);
  db.close();
});

test('重入不重复：第二次全量运行后行数不变', () => {
  const db = memory();
  const list = [
    { version: 1, description: 'probe 表', statements: ['CREATE TABLE probe (v TEXT) STRICT', "INSERT INTO probe VALUES ('one')"] },
    { version: 2, description: '追加行', statements: ["INSERT INTO probe VALUES ('two')"] },
  ];
  migrate(db, list);
  migrate(db, list);
  assert.equal((rows(db, 'SELECT COUNT(*) AS n FROM probe')[0] as { n: number }).n, 2);
  db.close();
});

test('迁移中途失败整体回滚：v1 保留、v2 无行无表（Review Focus 2）', () => {
  const db = memory();
  const list = [
    { version: 1, description: 'probe 表', statements: ['CREATE TABLE probe (v TEXT) STRICT'] },
    { version: 2, description: '坏 SQL', statements: ['CREATE TABLE bad (v TEXT) STRICT', 'THIS IS NOT SQL'] },
  ];
  assert.throws(() => migrate(db, list));
  assert.equal((rows(db, 'SELECT COUNT(*) AS n FROM schema_version')[0] as { n: number }).n, 1);
  assert.equal((rows(db, 'SELECT version FROM schema_version')[0] as { version: number }).version, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'bad'").get()?.n, 0);
  db.close();
});

test('守卫：重复版本号在执行任何语句前抛错（Review Focus 3）', () => {
  const db = memory();
  const list = [
    { version: 1, description: 'a', statements: ['CREATE TABLE probe (v TEXT) STRICT'] },
    { version: 1, description: 'b', statements: [] },
  ];
  assert.throws(() => migrate(db, list), /version/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'probe'").get()?.n, 0);
  db.close();
});

test('守卫：乱序（降序）版本号抛错且不执行任何语句（Review Focus 3）', () => {
  const db = memory();
  const list = [
    { version: 2, description: 'a', statements: ['CREATE TABLE probe (v TEXT) STRICT'] },
    { version: 1, description: 'b', statements: [] },
  ];
  assert.throws(() => migrate(db, list), /version/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'probe'").get()?.n, 0);
  db.close();
});

test('出厂基线：文件库按出厂列表全量首迁，重入 applied=[]（Review Focus 4；S2-T3 起列表含业务 DDL）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-mig-'));
  try {
    const db = openDatabase(path.join(dir, 't.sqlite'));
    const versions = MIGRATIONS.map((m) => m.version);
    const first = migrate(db, MIGRATIONS);
    assert.deepEqual(first.applied, versions);
    const again = migrate(db, MIGRATIONS);
    assert.deepEqual(again.applied, []);
    assert.deepEqual(again.skipped, versions);
    const all = rows(db, 'SELECT version, description FROM schema_version') as { version: number; description: string }[];
    assert.equal(all.length, versions.length);
    assert.deepEqual(all.map((r) => r.version), versions);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
