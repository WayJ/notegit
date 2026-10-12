// THROWAWAY spike: indicative SQLite vs PostgreSQL write throughput for S1-T1.
// NOT a rigorous benchmark — single machine (Apple M4), localhost TCP for pg,
// warm caches, medians of 3. Labeled indicative on purpose.
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileP = promisify(execFile);
const median = a => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function sqliteProbe() {
  const db = new DatabaseSync('/tmp/s1-t1-db-perf.db');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('DROP TABLE IF EXISTS p'); db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY, body TEXT)');
  const txTimes = [], acTimes = [];
  for (let run = 0; run < 3; run++) {
    db.exec('DELETE FROM p');
    let t = performance.now();
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO p (body) VALUES (?)');
    for (let i = 0; i < 1000; i++) ins.run('x'.repeat(64));
    db.exec('COMMIT');
    txTimes.push(performance.now() - t);
    db.exec('DELETE FROM p');
    t = performance.now();
    for (let i = 0; i < 200; i++) ins.run('y'.repeat(64));   // autocommit = own tx each
    acTimes.push(performance.now() - t);
  }
  db.close();
  return { tx1k: median(txTimes), ac200: median(acTimes) };
}

async function pgProbe() {
  const pool = new pg.Pool({ host: '127.0.0.1', port: 55432, user: 'spike', password: 'spike-pw', database: 'spike', max: 1 });
  await pool.query('DROP TABLE IF EXISTS p');
  await pool.query('CREATE TABLE p (id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY, body TEXT)');
  const txTimes = [], acTimes = [];
  const c = await pool.connect();
  for (let run = 0; run < 3; run++) {
    await c.query('DELETE FROM p');
    let t = performance.now();
    await c.query('BEGIN');
    for (let i = 0; i < 1000; i++) await c.query('INSERT INTO p (body) VALUES ($1)', ['x'.repeat(64)]);
    await c.query('COMMIT');
    txTimes.push(performance.now() - t);
    await c.query('DELETE FROM p');
    t = performance.now();
    for (let i = 0; i < 200; i++) await c.query('INSERT INTO p (body) VALUES ($1)', ['y'.repeat(64)]);
    acTimes.push(performance.now() - t);
  }
  c.release(); await pool.end();
  return { tx1k: median(txTimes), ac200: median(acTimes) };
}

const s = await sqliteProbe();
let p = null;
try { p = await pgProbe(); } catch (e) { console.log('postgres probe skipped:', e.message); }
console.log(`sqlite (node:sqlite, WAL, synchronous=NORMAL):
  1000 inserts one tx : median ${s.tx1k.toFixed(1)} ms  (${(1000 / s.tx1k * 1000).toFixed(0)} rows/s)
  200 autocommit       : median ${s.ac200.toFixed(1)} ms  (${(200 / s.ac200 * 1000).toFixed(0)} rows/s)`);
if (p) console.log(`postgres 17 (docker, localhost TCP, 1 conn):
  1000 inserts one tx : median ${p.tx1k.toFixed(1)} ms  (${(1000 / p.tx1k * 1000).toFixed(0)} rows/s)
  200 autocommit       : median ${p.ac200.toFixed(1)} ms  (${(200 / p.ac200 * 1000).toFixed(0)} rows/s)`);
console.log('note: sqlite autocommit fsyncs per tx (WAL+NORMAL); pg over TCP pays ~round-trip per statement — single-user knowledge-base write load is far below both.');
