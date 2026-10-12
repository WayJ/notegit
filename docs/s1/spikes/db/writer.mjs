// THROWAWAY spike: SQLite concurrent-writer child process for S1-T1 DB probes.
// argv: <dbPath> <busyTimeoutMs> <holdSpec> <who>
//   holdSpec: '<ms>'    -> BEGIN IMMEDIATE; INSERT; sleep ms; COMMIT  (holds write lock)
//            '30x30'    -> 30 autocommit INSERTs, 30ms apart           (churn)
import { DatabaseSync } from 'node:sqlite';

const [dbPath, timeoutMs, holdSpec, who] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA busy_timeout=${Number(timeoutMs)}`);

if (holdSpec.includes('x')) {
  const [n, gap] = holdSpec.split('x').map(Number);
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO notes (who, body) VALUES (?, ?)').run(who, `note-${i}`);
    await new Promise(r => setTimeout(r, gap));
  }
} else {
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO notes (who, body) VALUES (?, ?)').run(who, 'held');
  await new Promise(r => setTimeout(r, Number(holdSpec)));
  db.exec('COMMIT');
}
db.close();
console.log(`writer ${who} done`);
