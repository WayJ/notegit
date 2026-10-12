// S1-T1 DB spike — PostgreSQL probes via docker postgres:17-alpine on localhost:55432.
// THROWAWAY spike code per S1-T1 brief; not product code.
// Start the container first:  ./pg.sh start   (see pg.sh)
// Probes:
//  P1  two concurrent UPDATE connections, different rows -> both succeed (MVCC, no row elsewhere)
//  P2  pg_dump WHILE a writer churns -> dump restores into a fresh database, integrity + counts consistent
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PG = { host: '127.0.0.1', port: 55432, user: 'spike', password: 'spike-pw', database: 'spike' };
const CONTAINER = 's1-t1-pg-spike';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pool;
before(async () => {
  pool = new pg.Pool({ ...PG, max: 4 });
  await pool.query('DROP TABLE IF EXISTS notes');
  await pool.query('CREATE TABLE notes (id INTEGER PRIMARY KEY, who TEXT, body TEXT)');
  for (let i = 1; i <= 20; i++) await pool.query('INSERT INTO notes (id, who, body) VALUES ($1,$2,$3)', [i, 'seed', `note-${i}`]);
});
after(async () => { if (pool) await pool.end(); });

test('P1: concurrent UPDATEs on different rows both commit (MVCC)', async () => {
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('BEGIN');
    await a.query("UPDATE notes SET body='by-a' WHERE id=1");
    await b.query('BEGIN');
    await b.query("UPDATE notes SET body='by-b' WHERE id=2");
    await Promise.all([a.query('COMMIT'), b.query('COMMIT')]);
    const { rows } = await pool.query('SELECT body FROM notes WHERE id IN (1,2) ORDER BY id');
    assert.deepEqual(rows.map(r => r.body), ['by-a', 'by-b']);
  } finally { a.release(); b.release(); }
});

test('P2: pg_dump under concurrent writes restores to a consistent copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-p2-'));
  const dumpPath = join(dir, 'dump.sql');
  try {
    // churn in background: 25 UPDATEs x 30ms
    const churn = (async () => {
      for (let i = 0; i < 25; i++) {
        await pool.query('UPDATE notes SET body=$1 WHERE id=$2', [`churn-${i}`, 3 + (i % 5)]);
        await sleep(30);
      }
    })();
    await sleep(100);
    // consistent logical dump while churn runs (repeatable-read snapshot inside pg_dump)
    await execFileP('docker', ['exec', CONTAINER, 'pg_dump', '-U', 'spike', '-d', 'spike', '-f', '/tmp/dump.sql']);
    await execFileP('docker', ['cp', `${CONTAINER}:/tmp/dump.sql`, dumpPath]);
    await churn;
    // restore into a fresh database (dump lives at /tmp/dump.sql inside the container)
    await execFileP('docker', ['exec', CONTAINER, 'dropdb', '-U', 'spike', '--if-exists', 'spike_restore']);
    await execFileP('docker', ['exec', CONTAINER, 'createdb', '-U', 'spike', 'spike_restore']);
    await execFileP('docker', ['exec', CONTAINER, 'psql', '-U', 'spike', '-d', 'spike_restore', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '/tmp/dump.sql']);
    const orig = await pool.query('SELECT COUNT(*) n FROM notes');
    const restored = await execFileP('docker', ['exec', CONTAINER, 'psql', '-U', 'spike', '-d', 'spike_restore', '-t', '-A', '-c', 'SELECT COUNT(*) FROM notes']);
    assert.equal(restored.stdout.trim(), String(orig.rows[0].n));
    const bodies = await execFileP('docker', ['exec', CONTAINER, 'psql', '-U', 'spike', '-d', 'spike_restore', '-t', '-A', '-c', 'SELECT body FROM notes WHERE id=1']);
    assert.equal(bodies.stdout.trim(), 'by-a', 'dump must be a transactionally consistent snapshot (committed data only)');
    await execFileP('docker', ['exec', CONTAINER, 'dropdb', '-U', 'spike', 'spike_restore']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
