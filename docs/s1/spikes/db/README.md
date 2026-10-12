# S1-T1 DB spike — SQLite vs PostgreSQL (THROWAWAY)

Evidence-gathering spike for `docs/s1/selection.md`. Not product code.

## Probes

- `test/sqlite.test.mjs` — node:sqlite (built into Node 24, "Release candidate"):
  S1 no-busy_timeout concurrent-writer hazard; S2 WAL+busy_timeout=5000 both
  writers succeed; S3/S4 VACUUM INTO under concurrent writes → consistent,
  integrity_check-ok, restorable backup.
- `test/postgres.test.mjs` — docker postgres:17-alpine (./pg.sh start): P1
  concurrent UPDATEs different rows (MVCC); P2 pg_dump under concurrent writes
  → restores to a consistent copy.
- `perf.mjs` — indicative write throughput (see evidence/db-perf.txt caveat).

## Rerun

    npm install
    node --test test/sqlite.test.mjs
    ./pg.sh start && node --test test/postgres.test.mjs   # ./pg.sh stop after
    node perf.mjs

Node v24.21.0, Apple M4/16GB, Docker 29.5.2, postgres:17-alpine, 2026-10-12.
