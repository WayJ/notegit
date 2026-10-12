import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/connection.ts';

// selection §4: WAL + busy_timeout=5000 必须显式（默认无 busy_timeout 时并发写立即 SQLITE_BUSY）。
// 每个 case 建独立临时文件库，用后清理。

test('openDatabase 启用 WAL（journal_mode=wal）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-conn-'));
  try {
    const db = openDatabase(path.join(dir, 't.sqlite'));
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('openDatabase 设置 busy_timeout=5000', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-conn-'));
  try {
    const db = openDatabase(path.join(dir, 't.sqlite'));
    assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('openDatabase 启用外键约束（foreign_keys=ON）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-conn-'));
  try {
    const db = openDatabase(path.join(dir, 't.sqlite'));
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('第二个连接同一文件库：WAL 持久、busy_timeout 每连接重新生效（Review Focus 1）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-conn-'));
  try {
    const file = path.join(dir, 't.sqlite');
    const first = openDatabase(file);
    first.exec('CREATE TABLE probe (v TEXT) STRICT');
    first.close();
    const second = openDatabase(file);
    assert.equal(second.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(second.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    assert.equal(second.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
