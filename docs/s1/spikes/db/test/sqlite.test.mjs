// S1-T1 DB spike — SQLite (node:sqlite, built into Node 24) behavior probes.
// THROWAWAY spike code per S1-T1 brief; not product code.
//
// Probes (architecture v0.2 §10 backup consistency, §9 single instance):
//  S1  concurrent multi-process writers, NO busy_timeout -> SQLITE_BUSY hazard
//  S2  concurrent multi-process writers, WAL + busy_timeout=5000 -> both succeed
//  S3  VACUUM INTO backup WHILE a writer is committing -> consistent, restorable
//  S4  backup restored copy passes integrity_check and serves reads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER = join(HERE, '..', 'writer.mjs');

function makeDb(dir) {
  const dbPath = join(dir, 'app.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, who TEXT, body TEXT)');
  db.exec("INSERT INTO notes (who, body) VALUES ('seed', 'base')");
  db.close();
  return dbPath;
}

test('S1: without busy_timeout, a concurrent writer fails SQLITE_BUSY (hazard)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-s1-'));
  try {
    const dbPath = makeDb(dir);
    // writer A holds the write lock for 600ms (BEGIN IMMEDIATE, sleep, commit);
    // writer B starts 150ms in and must fail fast with SQLITE_BUSY.
    const a = execFileP(process.execPath, [WRITER, dbPath, '0', '600', 'a']);
    await new Promise(r => setTimeout(r, 150));
    const b = execFileP(process.execPath, [WRITER, dbPath, '0', '0', 'b']);
    const results = await Promise.allSettled([a, b]);
    const bOutcome = results[1];
    assert.equal(bOutcome.status, 'rejected', 'writer B should fail without busy_timeout');
    assert.match(String(bOutcome.reason?.stderr || bOutcome.reason?.message || ''),
      /SQLITE_BUSY|database is locked/,
      'failure must be SQLITE_BUSY, got: ' + JSON.stringify(String(bOutcome.reason)));
    // and A committed fine
    assert.equal(results[0].status, 'fulfilled');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S2: WAL + busy_timeout=5000 -> both concurrent writers succeed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-s2-'));
  try {
    const dbPath = makeDb(dir);
    const a = execFileP(process.execPath, [WRITER, dbPath, '5000', '600', 'a']);
    await new Promise(r => setTimeout(r, 150));
    const b = execFileP(process.execPath, [WRITER, dbPath, '5000', '0', 'b']);
    const [ra, rb] = await Promise.allSettled([a, b]);
    assert.equal(ra.status, 'fulfilled', 'writer A ok: ' + String(ra.reason || ''));
    assert.equal(rb.status, 'fulfilled', 'writer B ok: ' + String(rb.reason || ''));
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT who, COUNT(*) n FROM notes WHERE who != 'seed' GROUP BY who").all();
    db.close();
    const byWho = Object.fromEntries(rows.map(r => [r.who, r.n]));
    assert.equal(byWho.a, 1);
    assert.equal(byWho.b, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S3+S4: VACUUM INTO while writer commits -> consistent backup, passes integrity_check, serves reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-s3-'));
  try {
    const dbPath = makeDb(dir);
    const backupPath = join(dir, 'backup.db');
    // churn writer: 30 tiny transactions of 30ms each (~900ms of concurrent writes)
    const churn = execFileP(process.execPath, [WRITER, dbPath, '5000', '30x30', 'churn']);
    await new Promise(r => setTimeout(r, 120));
    const backup = new DatabaseSync(dbPath);
    backup.exec('PRAGMA busy_timeout=5000');
    backup.exec(`VACUUM INTO '${backupPath}'`);   // must not throw under concurrent WAL writers
    const chk = backup.prepare('PRAGMA integrity_check').get();
    backup.close();
    // await throws on writer failure — subprocess stderr surfaces in the test output
    await churn;
    // S4: open the restored copy standalone
    const restored = new DatabaseSync(backupPath, { readOnly: true });
    const ic = restored.prepare('PRAGMA integrity_check').get();
    assert.equal(ic.integrity_check, 'ok');
    const count = restored.prepare('SELECT COUNT(*) n FROM notes').get();
    restored.close();
    assert.ok(count.n >= 2, 'backup must contain seed + at least one concurrent commit: ' + count.n);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
