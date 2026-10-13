/**
 * 每请求 git 子进程并发闸门（S8-T8；架构 §9「Git 接收与校验进程限制时间、内存
 * 和并发」；N2 风险收口——roadmap「每请求 git 子进程的并发上限未量化」→ 量化落
 * 为可配置上限）。
 *
 * 新键 git.maxConcurrentChildren 与 validation.* 键同链不同册：
 * - 覆盖链一致（默认值 ← NOTEGIT_ 环境变量 ← app_settings 行，DB 同键胜环境；
 *   fail-closed：非法值在加载面抛错指名键——闸门消费点拒请求，不静默回退）；
 * - 注册表独立于 LIMIT_KEY_FIELDS（那是 validation-defaults.json 契约键集，
 *   与契约文件双向交叉核对防漂移——本键契约入册走建议稿 G2，由 master 执行）；
 * - 写入面共用 setAppSetting（值域：安全正整数）。
 *
 * 计数对象 = githttp 每请求 spawn 的 `git http-backend` 子进程（每请求一条链，
 * 链内的 upload-pack/receive-pack/hook 是其子进程，随链整体消亡——按链计数即
 * 按请求计数）。每链内存基线 ~17MB（selection §5 实测保守值；S7-T8 同量级
 * 8–12MB）。
 *
 * 超限语义 = FIFO 排队，不拒绝（选型记录见建议稿 G2）：git 客户端对等待透明
 * （排队请求未消费 body，TCP 背压天然停住客户端发送）；503 拒绝会在 clone/push/
 * sync 脚本面产生费解失败。排队期间请求停在 Fastify handler（hijack 之前），
 * 受 Node server.requestTimeout（默认 300s）兜底。
 *
 * 容量热生效：每次 acquire 与每次唤醒实时调 capacity() 读覆盖链（管理员改行，
 * 下一次请求/下一次唤醒即生效）；与 maxConcurrentValidations 的按代次重建不同，
 * 这里是单计数器 + 唤醒时现读容量——容量上调即刻被等待者利用、下调后超出部分
 * 随在途释放自然排干（运维型资源语义，瞬态自愈）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { envNameOf, parseLimitValue } from './keys.ts';

/** git 域配置键注册表（契约键 → 配置面字段） */
export const GIT_LIMIT_KEY_FIELDS = {
  'git.maxConcurrentChildren': 'maxConcurrentChildren',
} as const;

export type GitLimitKey = keyof typeof GIT_LIMIT_KEY_FIELDS;
export const GIT_LIMIT_KEYS = Object.keys(GIT_LIMIT_KEY_FIELDS) as readonly GitLimitKey[];

/** 默认 8。量化依据（S7-T8 负载数据 + selection §5；建议稿 G2）：
 *  - 每链 ~17MB（保守值）× 8 = 136MB 子进程峰值预算，加本体 RSS 基线 232MB
 *    （S7-T8 全功能实测）= 368MB，在 768MB 修正地板（建议稿 G3）内自洽；
 *  - c=4 并发 sync（8 个 git 请求在途）实测无排队塌陷（请求 mean 16→20ms、
 *    max 27→50ms）——8 = 实测无塌陷点 × 2 的保守覆盖；
 *  - 峰值子进程数 ≈ 2×并发（S7-T8 §3.2）——8 链 ≈ 16–24 个 git 进程上限。 */
export const GIT_CHILDREN_DEFAULT = 8;

/** 覆盖链输入（与 engine.ts LimitsSource 结构同型——结构化类型互通，避免环依赖） */
export interface GitLimitsSource {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly db?: DatabaseSync;
}

export interface GitLimits {
  readonly maxConcurrentChildren: number;
}

function envOverride(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = env[envNameOf('git.maxConcurrentChildren')];
  if (raw === undefined || raw === '') return undefined;
  return parseLimitValue('git.maxConcurrentChildren', raw) as number;
}

function dbOverride(db: DatabaseSync | undefined): number | undefined {
  if (db === undefined) return undefined;
  let row: { value: string } | undefined;
  try {
    row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('git.maxConcurrentChildren') as
      | { value: string }
      | undefined;
  } catch {
    return undefined; // 缺表容忍（未迁移形态）：按默认值（与 engine dbOverrides 同语义）
  }
  if (row === undefined) return undefined;
  return parseLimitValue('git.maxConcurrentChildren', row.value) as number;
}

/** 生效上限（每次调用实时读取——热生效；非法值 fail-closed 抛错指名键） */
export function effectiveGitLimits(source: GitLimitsSource = {}): GitLimits {
  const env = source.env ?? process.env;
  const value = dbOverride(source.db) ?? envOverride(env) ?? GIT_CHILDREN_DEFAULT;
  return { maxConcurrentChildren: value };
}

/** 一个已取得的槽位；release 幂等 */
export interface GitChildSlot {
  release(): void;
}

/** 并发闸门（计数对象 = 在途 http-backend 子进程链） */
export interface GitChildGate {
  /** 取槽：容量内即取；超容量 FIFO 排队，容量在每次唤醒时实时重读 */
  acquire(): Promise<GitChildSlot>;
  /** 当前在途链数 */
  activeCount(): number;
  /** 当前排队请求数 */
  queuedCount(): number;
  /** 并发高水位（观察面：验收断言与未来指标接线；不随释放回落） */
  peakActive(): number;
}

export function createGitChildGate(capacity: () => number): GitChildGate {
  let active = 0;
  let peak = 0;
  let waiters: Array<() => void> = [];

  const handOff = (): void => {
    while (waiters.length > 0 && active < capacity()) {
      active += 1; // 槽位在唤醒方同步预留——等待者 resolve 时槽位已到手（无插队竞态）
      if (active > peak) peak = active;
      waiters.shift()!();
    }
  };

  return {
    async acquire(): Promise<GitChildSlot> {
      if (active < capacity()) {
        active += 1;
        if (active > peak) peak = active;
      } else {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          active -= 1;
          handOff();
        },
      };
    },
    activeCount: () => active,
    queuedCount: () => waiters.length,
    peakActive: () => peak,
  };
}
