/**
 * ls 的服务器/凭据占位面（S6-T3）。
 *
 * 集成点（T2）：S6-T2 的 notegit login（credential helper / OS 安全存储）合并后，
 * 本文件的默认实现应切换为 T2 的凭据获取面；`ServerCredential` 形态即两任务的
 * 接缝契约（server 基址 + Bearer token，api.md §1）。
 */

/** ls 消费的最小凭据面：server 基址（无尾斜杠）+ Bearer token（ngt_ 前缀）。 */
export interface ServerCredential {
  readonly server: string
  readonly token: string
}

/**
 * 环境变量占位实现：NOTEGIT_SERVER 与 NOTEGIT_TOKEN 齐备（非空白）才返回；
 * server 去尾斜杠。返回 undefined = 未配置（ls 以退出码 1 提示，见 index.ts）。
 */
export function credentialSourceFromEnv(env: NodeJS.ProcessEnv): ServerCredential | undefined {
  const server = (env['NOTEGIT_SERVER'] ?? '').trim().replace(/\/+$/, '')
  const token = (env['NOTEGIT_TOKEN'] ?? '').trim()
  if (server === '' || token === '') return undefined
  return { server, token }
}
