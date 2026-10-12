# S2-T1 工程脚手架与数据基座 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Subagent-driven development is not applicable: this is a dispatched single-worker Orca task; the brief fixes native execution.)

**Goal:** Land the monorepo scaffold and data foundation: npm-workspaces layout, Fastify v5 skeleton with `/healthz`, node:sqlite connection layer (WAL + busy_timeout=5000), reentrant `schema_version` forward-migration mechanism, `inject()` test framework, and the process-model/layout decision records.

**Architecture:** npm workspaces at repo root; `server/` is the only concrete package this sprint (`packages/validation/` arrives S3, `cli/` S6 — both anticipated by the workspace globs, not stubbed). Zero test-framework dependencies: Node 24 native TS type-stripping + `node --test` + `node:assert/strict`; Fastify's built-in `inject()` for route tests. Migration runner owns the `schema_version` tracking table (contract §3.1 shape); the shipped migration list carries an empty v1 baseline — the 10-table contract DDL lands with S2-T2…T7.

**Tech Stack:** Node 24 (native type stripping), TypeScript 5.x (`tsc --noEmit` only — no build step in this task), Fastify v5, `node:sqlite` (built-in), npm workspaces with exact-pinned versions.

**Spec:** `docs/s1/implementation-breakdown.md` §1.3 + §2.1 (S2-T1 row); `docs/s1/selection.md` §4–§5 + §7 (D10); `docs/contracts/storage-model.md` §3.1 (DDL sole source); `docs/contracts/backup-recovery.md` §3/§9 (maintenance gate T_gate=0, migration discipline); sprint plan D6 (module boundary finalized by this task).

## Global Constraints

- Stack locked to D10: Node 24 + TypeScript + Fastify v5 + `node:sqlite`. No other runtime deps; npm only, versions exact-pinned (`--save-exact`), `package-lock.json` committed.
- `docs/contracts/`, `docs/superpowers/`, `architecture.md`, `AGENTS.md` are read-only; no `git push`; all commits land on the current branch `WayJ/s2-t1-scaffold` with evidence in the message; never claim E1 DoD.
- DDL content comes solely from `storage-model.md` `-- @schema` blocks; this task builds mechanism only — **no business tables**.
- TDD mandatory: pragma assertions, migration reentrancy, health route — failing tests written first.
- `npm test` at repo root, no arguments, runs the full test suite (this command is proposed to master for AGENTS.md gates registration; AGENTS.md itself is not touched).
- TS is restricted to erasable syntax (no enums/namespaces/parameter properties) and `.ts`-suffixed relative imports — both required by Node native type stripping.
- Ownership: new files at repo root, under `server/`, and under `docs/dev/` only.

## Review Focus

1. **busy_timeout is per-connection** — a second connection to the same file must also report 5000 (WAL alone is persistent; busy_timeout is not). → Task 1 test: two sequential `openDatabase` calls both assert `timeout=5000`.
2. **A failing migration mid-list leaves partial state** — the failed migration must roll back fully (no version row, no half-applied statements) while earlier ones stay committed. → Task 2 test: v2 with invalid SQL throws; v1 row present, v2 row and v2 probe table absent.
3. **Duplicate or unordered versions misapply silently** — the runner must reject non-strictly-ascending lists. → Task 2 tests: duplicate version throws; unsorted list throws.
4. **The empty v1 baseline must still record and re-run skip** — mechanism smoke on the real shipped list. → Task 2 test: `migrate(db, MIGRATIONS)` on fresh DB yields schema_version row v1; second call applies nothing.
5. **Routes outside the skeleton contract** — unknown paths 404 rather than crash. → Task 3 test: `GET /nope` → 404.

---

### Task 1: Workspace scaffold + node:sqlite connection layer

**Files:**
- Create: `package.json` (root), `tsconfig.base.json` (root), `.gitignore` (root), `server/package.json`, `server/tsconfig.json`
- Create: `server/src/db/connection.ts`
- Test: `server/test/connection.test.ts`

**Interfaces:**
- Produces: `openDatabase(path: string): DatabaseSync` (from `server/src/db/connection.ts`) — opens a file DB, applies `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, returns the handle. Root `npm test` = `npm test --workspaces --if-present`; server `npm test` = `tsc --noEmit && node --test`.
- Root `package.json`: name `notegit-monorepo` (the bare name `notegit` stays reserved for the S6 CLI package), private, `workspaces: ["server", "packages/*"]` — explicit `cli` is added only when S6 creates that directory (npm errors on listed-but-missing explicit paths; globs matching nothing are fine).

- [ ] **Step 1: Scaffold workspace files**

Root `package.json`: scripts `{"test": "npm test --workspaces --if-present"}`, private, no deps. `tsconfig.base.json`: `ES2023` / `NodeNext` / `strict` / `noEmit` / `allowImportingTsExtensions` / `verbatimModuleSyntax` / `isolatedModules` / `skipLibCheck` / `types: ["node"]`. `server/package.json`: name `notegit-server`, `"type": "module"`, private, `engines: {"node": ">=24 <25"}`, scripts `{"test": "tsc --noEmit && node --test"}`. `server/tsconfig.json`: extends base, includes `src/**/*` + `test/**/*`. `.gitignore`: `node_modules/`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.log`.

- [ ] **Step 2: Install deps exact-pinned**

Run: `npm install -w server --save-exact fastify` and `npm install -w server --save-exact -D typescript @types/node`, then `npm install` at root. Commit `package-lock.json`.

- [ ] **Step 3: Write the failing test** (`server/test/connection.test.ts`)

Tests (each on a fresh temp file via `fs.mkdtemp(os.tmpdir())` + `path.join(dir, 't.sqlite')`):
- `openDatabase` → `PRAGMA journal_mode` returns `{journal_mode: 'wal'}`
- → `PRAGMA busy_timeout` returns `{timeout: 5000}`
- → `PRAGMA foreign_keys` returns `{foreign_keys: 1}`
- a second `openDatabase` on the same file → journal still `wal`, timeout still `5000` (Review Focus 1)

- [ ] **Step 4: Run test to verify it fails**

Run: `cd server && node --test test/connection.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/db/connection.ts`.

- [ ] **Step 5: Implement `openDatabase` in `server/src/db/connection.ts`**

`new DatabaseSync(path)`; apply the three pragmas via `db.exec()` in the order WAL → busy_timeout → foreign_keys; return db. One JSDoc line citing selection §4 (busy_timeout must be explicit; WAL required) and noting `:memory:` DBs ignore WAL (journal stays `memory`).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && node --test test/connection.test.ts` → PASS; then root `npm test` → PASS (typecheck + tests).

- [ ] **Step 7: Commit** — message includes the test summary line as evidence.

### Task 2: schema_version reentrant forward-migration mechanism

**Files:**
- Create: `server/src/db/migrations.ts`, `server/src/db/migrate.ts`
- Test: `server/test/migrate.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync` handles (Task 1's `openDatabase` for file DBs; plain `new DatabaseSync(':memory:')` for tests that don't assert WAL).
- Produces: `interface Migration { readonly version: number; readonly description: string; readonly statements: readonly string[] }`; `const MIGRATIONS: readonly Migration[]` (shipped list: v1, empty statements, description marks the S2-T2…T7 DDL landing); `migrate(db: DatabaseSync, migrations: readonly Migration[]): { applied: number[]; skipped: number[] }`.

- [ ] **Step 1: Write the failing test** (`server/test/migrate.test.ts`)

Uses synthetic migrations on `:memory:` DBs plus one file-DB case for the shipped list:
1. **order**: list `[v1 creates probe table + inserts 1 row, v2 inserts a second row]` on fresh DB → both rows present, v2's insert succeeded only because v1's table exists (order enforced); result reports `applied=[1,2]`.
2. **skip applied** (reentry): re-run same list → `applied=[]`, `skipped=[1,2]`, probe still has exactly the same rows — no re-execution of non-idempotent statements.
3. **run new in order**: on a DB that applied `[v1]`, run `[v1, v2]` → only v2 executes.
4. **no duplicates**: second full run of `[v1, v2]` → row counts unchanged.
5. **failure rollback** (Review Focus 2): `[v1 ok, v2 invalid SQL]` → migrate throws; v1 row present, v2 row absent, v2's table absent.
6. **guards** (Review Focus 3): duplicate versions throw; descending versions throw — before any statement executes.
7. **shipped baseline** (Review Focus 4): file DB via `openDatabase`, `migrate(db, MIGRATIONS)` → `schema_version` has exactly row v1; re-run → `applied=[]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/migrate.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `migrations.ts` then `migrate.ts`**

`migrate.ts`: validate list strictly ascending + unique (throw `Error` naming the offender); bootstrap `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL, description TEXT NOT NULL) STRICT` (shape = contract §3.1; the append-only triggers arrive with the contract DDL in T2+); read applied versions into a `Set`; per new migration: `BEGIN` → exec statements in order → `INSERT INTO schema_version VALUES (?, ?, ?)` with `applied_at = new Date().toISOString()` → `COMMIT`, `ROLLBACK` on any throw (re-throw).

- [ ] **Step 4: Run test to verify it passes**

`cd server && node --test test/migrate.test.ts` → PASS; root `npm test` → PASS.

- [ ] **Step 5: Commit** — message includes test summary evidence.

### Task 3: Fastify v5 skeleton + health route (inject test)

**Files:**
- Create: `server/src/app.ts`
- Test: `server/test/app.test.ts`

**Interfaces:**
- Produces: `buildApp(): FastifyInstance` (from `server/src/app.ts`) — Fastify v5 instance, `logger` off by default, one route `GET /healthz → 200 { status: 'ok' }`. Later tasks wire DB/migrations into startup (open → pragmas → migrate → listen), so `buildApp` stays DB-free for now.

- [ ] **Step 1: Write the failing test** (`server/test/app.test.ts`)

- `GET /healthz` via `app.inject()` → 200, `content-type` JSON, body `{ status: 'ok' }`; `await app.close()` after.
- `GET /nope` → 404 (Review Focus 5).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/app.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `buildApp` in `server/src/app.ts`**

`fastify()` + `app.get('/healthz', async () => ({ status: 'ok' }))` + return. Endpoint name per selection §5 (`/healthz` liveness).

- [ ] **Step 4: Run test to verify it passes**

`cd server && node --test test/app.test.ts` → PASS; root `npm test` → PASS (all three test files).

- [ ] **Step 5: Commit** — message includes test summary evidence.

### Task 4: Process model + layout decision records

**Files:**
- Create: `docs/dev/process-model.md`, `docs/dev/architecture-notes.md`

**Interfaces:**
- Consumes: D10 (selection §2/§7), backup §3 (T_gate=0 for single process), storage-model §3.1 (schema_version shape), breakdown §1.3 (boundary assumption), sprint plan D6.

- [ ] **Step 1: Write `docs/dev/process-model.md`**

Content: single app process per container (no internal supervisor); per-Git-request `git http-backend` CGI child spawn, **async spawn mandatory** (S1 spike: sync spawn self-deadlocks against own HTTP server); child processes are request-scoped and hold no authority state — the app process is the sole coordinator (SQLite via WAL + busy_timeout). Consequence for backup §3: single process ⇒ maintenance gate = in-process synchronous flag ⇒ propagation upper bound **T_gate = 0**, so the §4 drain check may start immediately after the gate opens; any future multi-process/multi-container form must move the gate to shared storage and define an explicit T_gate (per backup §3). State clearly: this task records the model; the gate itself is S2-T7 code.

- [ ] **Step 2: Write `docs/dev/architecture-notes.md`**

Content: (a) layout decision — root npm workspaces; `server/` (Fastify app, deployable), `packages/validation/` (S3, shared validator, single source with docs/contracts), `cli/` (S6, npm-published as `notegit`), `docs/` read-only; rejected alternatives (single flat package, pnpm — npm is mandated, monorepo tools nx/turborepo — YAGNI); naming convention `notegit-*`, bare `notegit` reserved for CLI. (b) tooling decisions — node --test + native type stripping (zero test deps; erasable-TS-only constraint, `.ts` import extensions), `tsc --noEmit` chained before tests in `npm test`, exact-pinned versions, production TS execution strategy (strip-at-runtime vs compile-in-image) deferred to S8 packaging. (c) DB decisions — connection pragmas incl. why `foreign_keys=ON` is pinned explicitly despite node:sqlite's default (RC API, pin behavior); runner-owned `schema_version` bootstrap shape = contract §3.1; empty v1 baseline now and the two options for T2+ (grow v1 pre-release, or start DDL at v2) left to T2+ with master review. (d) handoff notes for wave-2 workers: where code goes in `server/src/`, `npm test` from root, TDD requirement.

- [ ] **Step 3: Verify constraints held**

Run: `git diff --stat` shows only owned paths (root files, `server/`, `docs/dev/`); `git status` clean after commit; `git diff -- docs/contracts/ docs/superpowers/ architecture.md AGENTS.md` empty. Root `npm test` green one final time; paste summary into commit message.

- [ ] **Step 4: Commit** — message notes both docs and the final `npm test` evidence + the gates proposal (`npm test` at repo root) for master to register into AGENTS.md.
