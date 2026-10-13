/**
 * sync 并发锁（S7-T4；架构 §7.3「每库 Git 操作和全局状态写入分别加锁，避免并发
 * 命令交叉修改」）。
 *
 * 选型（2026-10-13 记录）：无第三方依赖的排他创建文件锁——open(file,'wx') 原子
 * 创建即持锁、EEXIST 即竞争；等待方短轮询，超时报错（不无限等）。不引入
 * flock(2) 原生模块或 proper-lockfile 依赖（当前 CLI 依赖面仅 yaml，维持零新增）。
 *
 * 崩溃自愈（陈旧抢占）：锁内容 = {pid, token, acquiredAt} 单行 JSON；锁龄超过
 * staleMs 且持有者 pid 已死（kill(pid,0)=ESRH；内容损坏视为不可判定 pid，仅按
 * 锁龄）时，等待者以 tmp+rename 原子覆盖抢占，落地后复读校验 token 归属、
 * 非己则继续等待。复读与 rename 之间仍存在微秒级双重抢占理论窗口（同类设计
 * proper-lockfile 亦然）——CLI 规模（2–4 并发进程，S7-T8 负载场景）接受并在此
 * 记录；如需彻底消除须升级到内核级原语（flock/原生模块）。
 *
 * 锁序约定：runSync 固定「repo 锁 → state 锁」单向获取（见 index.ts），
 * 任何嵌套取锁不得反向。
 */
import { open, mkdir, readFile, rename, writeFile, unlink, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { randomUUID } from 'node:crypto'

/** 获取选项（测试注入小值；缺省见 DEFAULTS）。 */
export interface LockOptions {
  /** 最长等待（毫秒）；超时抛错。 */
  readonly timeoutMs?: number
  /** 轮询间隔（毫秒）。 */
  readonly retryMs?: number
  /** 锁龄超过此值且持有者已死 → 可抢占（毫秒）。 */
  readonly staleMs?: number
}

/** 已获得的锁；release 幂等且只释放自己 token 的锁文件。 */
export interface FileLock {
  readonly path: string
  release(): Promise<void>
}

/** 缺省：repo 级等待上限 600s（> 最长单库操作 clone 超时 300s + 判定面）；陈旧阈值同。 */
const DEFAULTS = { timeoutMs: 600_000, retryMs: 50, staleMs: 600_000 } as const

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code
}

/** pid 是否存活（EPERM=存在但属他人，视为存活）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errCode(err) === 'EPERM'
  }
}

interface LockContent {
  readonly pid: number
  readonly token: string
  readonly acquiredAt: string
}

async function writeLockContent(file: string, content: LockContent): Promise<void> {
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(content)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

async function readLockContent(file: string): Promise<LockContent | null> {
  try {
    const doc: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof doc !== 'object' || doc === null) return null
    const { pid, token, acquiredAt } = doc as Record<string, unknown>
    if (typeof pid !== 'number' || typeof token !== 'string' || typeof acquiredAt !== 'string') return null
    return { pid, token, acquiredAt }
  } catch {
    return null
  }
}

function makeLock(file: string, token: string): FileLock {
  let released = false
  return {
    path: file,
    release: async () => {
      if (released) return
      released = true
      // 只删自己的锁：内容 token 不符 = 已被抢占/替换，不动他人文件
      const current = await readLockContent(file)
      if (current !== null && current.token === token) await unlink(file).catch(() => undefined)
    },
  }
}

/**
 * 陈旧抢占：锁龄超 staleMs 且持有者不存活（或内容不可判定）时，tmp+rename 原子
 * 覆盖。抢占后复读校验 token 归属，非己（他者竞速先落）则返回 false 继续等待。
 */
async function trySteal(file: string, staleMs: number, mine: LockContent): Promise<boolean> {
  const st = await stat(file).catch(() => null)
  if (st === null || Date.now() - st.mtimeMs < staleMs) return false
  const holder = await readLockContent(file)
  if (holder !== null && pidAlive(holder.pid)) return false // 活持有者：只等待
  const claim = `${file}.steal-${process.pid}-${randomUUID()}`
  await writeFile(claim, `${JSON.stringify(mine)}\n`, 'utf8')
  try {
    await rename(claim, file) // 原子替换（覆盖陈旧锁）
  } catch {
    await unlink(claim).catch(() => undefined)
    return false
  }
  const landed = await readLockContent(file)
  return landed !== null && landed.token === mine.token
}

/** 获得锁或超时抛错（错误信息含锁路径与处置指引）。 */
export async function acquireFileLock(file: string, opts: LockOptions = {}): Promise<FileLock> {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs
  const retryMs = opts.retryMs ?? DEFAULTS.retryMs
  const staleMs = opts.staleMs ?? DEFAULTS.staleMs
  await mkdir(path.dirname(file), { recursive: true })
  const mine: LockContent = { pid: process.pid, token: `${process.pid}-${randomUUID()}`, acquiredAt: new Date().toISOString() }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let created = false
    try {
      await writeLockContent(file, mine)
      created = true
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err
    }
    if (created) return makeLock(file, mine.token)
    if (await trySteal(file, staleMs, mine)) return makeLock(file, mine.token)
    if (Date.now() >= deadline) {
      throw new Error(`并发锁等待超时：${file}（另一同步进程持有中；若确认无 sync 在运行，可删除该锁文件后重试）`)
    }
    await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())))
  }
}

/** 持锁执行 fn（任意返回值透传）；无论成败都释放。 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
  const lock = await acquireFileLock(file, opts)
  try {
    return await fn()
  } finally {
    await lock.release()
  }
}

/** 每库 Git 操作锁路径：<root>/.notegit/locks/<slug>.lock（与 state 文件同住 .notegit，整体可弃）。 */
export function repoLockPath(root: string, slug: string): string {
  return path.join(root, '.notegit', 'locks', `${slug}.lock`)
}

/** 全局状态写锁路径：= <root>/.notegit/sync-state.json.lock（与 state.ts 的 stateFilePath 成对——一致性由测试钉死）。 */
export function stateLockPath(root: string): string {
  return path.join(root, '.notegit', 'sync-state.json.lock')
}
