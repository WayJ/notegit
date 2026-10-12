import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  credentialsFilePath,
  storeCredential,
  lookupCredential,
  eraseCredential,
  readCredentials,
  parseCredentialQuery,
  formatCredentialForGet,
} from '../src/credentials.ts'

// 凭据存储模块（S6-T2）：0600 文件存储 + git credential-helper 协议读写。
// 「凭据文件权限受限」= breakdown S6-T2 完成标准；泄漏红线（不入 URL/仓库/日志）由 login 与集成测试断言。

const dirs: string[] = []
let storeFile: string

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ngt-credtest-'))
  dirs.push(dir)
  storeFile = path.join(dir, 'credentials')
  process.env.NOTEGIT_CREDENTIALS_FILE = storeFile
})

afterEach(() => {
  delete process.env.NOTEGIT_CREDENTIALS_FILE
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TOKEN_A = `ngt_${'a'.repeat(43)}`
const TOKEN_B = `ngt_${'b'.repeat(43)}`

test('credentialsFilePath：优先 NOTEGIT_CREDENTIALS_FILE，其次 XDG_CONFIG_HOME，最后 ~/.config', () => {
  assert.equal(credentialsFilePath(), storeFile)
  delete process.env.NOTEGIT_CREDENTIALS_FILE
  const xdg = path.join(path.dirname(storeFile), 'xdg')
  process.env.XDG_CONFIG_HOME = xdg
  assert.equal(credentialsFilePath(), path.join(xdg, 'notegit', 'credentials'))
  delete process.env.XDG_CONFIG_HOME
  const home = path.dirname(storeFile)
  process.env.HOME = home
  assert.equal(credentialsFilePath(), path.join(home, '.config', 'notegit', 'credentials'))
})

test('storeCredential：创建凭据文件且权限 0600、父目录 0700（breakdown「凭据文件权限受限」）', () => {
  storeCredential({ protocol: 'https', host: 'notegit.example.com', username: 'alice', password: TOKEN_A })
  assert.ok(existsSync(storeFile), '凭据文件应被创建')
  const fileMode = statSync(storeFile).mode & 0o777
  const dirMode = statSync(path.dirname(storeFile)).mode & 0o777
  assert.equal(fileMode, 0o600, `凭据文件权限应为 0600，实际 ${fileMode.toString(8)}`)
  assert.equal(dirMode, 0o700, `凭据目录权限应为 0700，实际 ${dirMode.toString(8)}`)
})

test('lookupCredential：按 protocol+host 命中返回完整条目；未命中与他 host 返回 null', () => {
  storeCredential({ protocol: 'https', host: 'notegit.example.com', username: 'alice', password: TOKEN_A })
  assert.deepEqual(
    lookupCredential({ protocol: 'https', host: 'notegit.example.com' }),
    { protocol: 'https', host: 'notegit.example.com', username: 'alice', password: TOKEN_A },
  )
  assert.equal(lookupCredential({ protocol: 'https', host: 'other.example.com' }), null)
  assert.equal(lookupCredential({ protocol: 'http', host: 'notegit.example.com' }), null, 'protocol 不同不算命中')
})

test('storeCredential：同 protocol+host+username 覆盖旧 token（upsert），条目数不增', () => {
  storeCredential({ protocol: 'https', host: 'notegit.example.com', username: 'alice', password: TOKEN_A })
  storeCredential({ protocol: 'https', host: 'notegit.example.com', username: 'alice', password: TOKEN_B })
  assert.equal(readCredentials().length, 1)
  assert.equal(lookupCredential({ protocol: 'https', host: 'notegit.example.com' })?.password, TOKEN_B)
})

test('同 host 不同 username 共存；lookup 带 username 过滤精确返回', () => {
  storeCredential({ protocol: 'https', host: 'notegit.example.com', username: 'alice', password: TOKEN_A })
  storeCredential({ protocol: 'https', host: 'notegit.example.com', username: 'bob', password: TOKEN_B })
  assert.equal(readCredentials().length, 2)
  assert.equal(lookupCredential({ protocol: 'https', host: 'notegit.example.com', username: 'bob' })?.password, TOKEN_B)
  assert.equal(lookupCredential({ protocol: 'https', host: 'notegit.example.com', username: 'carol' }), null)
})

test('eraseCredential：删除指定条目、保留其他条目', () => {
  storeCredential({ protocol: 'https', host: 'notegit.example.com', username: 'alice', password: TOKEN_A })
  storeCredential({ protocol: 'https', host: 'notegit.example.com', username: 'bob', password: TOKEN_B })
  eraseCredential({ protocol: 'https', host: 'notegit.example.com', username: 'alice' })
  assert.equal(lookupCredential({ protocol: 'https', host: 'notegit.example.com', username: 'alice' }), null)
  assert.equal(lookupCredential({ protocol: 'https', host: 'notegit.example.com', username: 'bob' })?.password, TOKEN_B)
})

test('parseCredentialQuery：解析 git credential 协议的多行 k=v 输入（空行之后忽略）', () => {
  const input = ['protocol=http', 'host=127.0.0.1:8080', 'username=alice', 'password=secret', '', 'noise=1'].join('\n')
  assert.deepEqual(parseCredentialQuery(input), {
    protocol: 'http',
    host: '127.0.0.1:8080',
    username: 'alice',
    password: 'secret',
  })
})

test('formatCredentialForGet：输出 protocol/host/username/password 四行（git helper get 响应格式）', () => {
  const out = formatCredentialForGet({ protocol: 'https', host: 'notegit.example.com', username: 'alice', password: TOKEN_A })
  assert.equal(out, `protocol=https\nhost=notegit.example.com\nusername=alice\npassword=${TOKEN_A}\n`)
})
