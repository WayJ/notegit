import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cliConfigPath, readCliConfig, writeCliConfig } from '../src/setup/config.ts'
import { localRootOf } from '../src/ls/local-status.ts'

// S6-T6 setup 的 CLI 配置面：--local-root 持久化 + ls localRootOf 消费（任务条款 4）。
// 优先级契约：环境变量 NOTEGIT_LOCAL_ROOT > CLI 配置 localRoot > 缺省 ~/knowbase。

test('cliConfigPath：NOTEGIT_CONFIG_FILE 显式 > XDG_CONFIG_HOME > HOME/.config', () => {
  assert.equal(cliConfigPath({ NOTEGIT_CONFIG_FILE: '/tmp/x/notegit-config' } as NodeJS.ProcessEnv), '/tmp/x/notegit-config')
  assert.equal(
    cliConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' } as NodeJS.ProcessEnv),
    path.join('/xdg', 'notegit', 'config'),
  )
  assert.equal(
    cliConfigPath({ HOME: '/home/u' } as NodeJS.ProcessEnv),
    path.join('/home/u', '.config', 'notegit', 'config'),
  )
})

test('readCliConfig：文件缺失返回空；key=value 解析；坏行忽略；空值不作为有效配置', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-c1-'))
  try {
    const file = path.join(dir, 'config')
    const env = { NOTEGIT_CONFIG_FILE: file } as NodeJS.ProcessEnv
    assert.deepEqual(readCliConfig(env), {}, '文件缺失 → 空配置')
    await writeFile(file, 'localRoot=/data/vaults\ntheme=dark\n坏行无等号\nempty=\n')
    assert.deepEqual(readCliConfig(env), { localRoot: '/data/vaults', theme: 'dark', empty: '' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeCliConfig：写 0600；合并保留既有其他键；覆盖同键', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-c2-'))
  try {
    const file = path.join(dir, 'config')
    const env = { NOTEGIT_CONFIG_FILE: file } as NodeJS.ProcessEnv
    await writeFile(file, 'theme=dark\n')
    writeCliConfig({ localRoot: '/a' }, env)
    assert.equal((await stat(file)).mode & 0o777, 0o600, '配置文件应 0600')
    assert.deepEqual(readCliConfig(env), { theme: 'dark', localRoot: '/a' }, '应合并保留其他键')
    writeCliConfig({ localRoot: '/b' }, env)
    assert.deepEqual(readCliConfig(env), { theme: 'dark', localRoot: '/b' }, '同键覆盖')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeCliConfig：文件不存在时创建（含目录）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-c3-'))
  try {
    const file = path.join(dir, 'nested', 'd', 'config')
    const env = { NOTEGIT_CONFIG_FILE: file } as NodeJS.ProcessEnv
    writeCliConfig({ localRoot: '/x' }, env)
    assert.ok(existsSync(file), '应创建配置文件')
    assert.deepEqual(readCliConfig(env), { localRoot: '/x' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('localRootOf 优先级：NOTEGIT_LOCAL_ROOT 环境变量 > CLI 配置 localRoot > 缺省 ~/knowbase', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-c4-'))
  try {
    const file = path.join(dir, 'config')
    await writeFile(file, 'localRoot=/cfg/vaults\n')
    const cfgEnv = { NOTEGIT_CONFIG_FILE: file } as NodeJS.ProcessEnv
    assert.equal(localRootOf({ ...cfgEnv, NOTEGIT_LOCAL_ROOT: '/env/vaults' }), '/env/vaults', '环境变量最优先')
    assert.equal(localRootOf(cfgEnv), '/cfg/vaults', '无环境变量时读 CLI 配置')
    assert.equal(localRootOf({ ...cfgEnv, NOTEGIT_LOCAL_ROOT: '  ' }), '/cfg/vaults', '空白环境变量视同未设置')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('localRootOf 回退：无环境变量且无配置文件 → 缺省 ~/knowbase；配置空值也回退', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegit-t6-c5-'))
  try {
    const file = path.join(dir, 'config')
    const env = { NOTEGIT_CONFIG_FILE: file } as NodeJS.ProcessEnv
    assert.equal(localRootOf(env), path.join(await import('node:os').then((os) => os.homedir()), 'knowbase'))
    await writeFile(file, 'localRoot=\n')
    assert.equal(localRootOf(env), path.join(await import('node:os').then((os) => os.homedir()), 'knowbase'), '配置空值回退缺省')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
