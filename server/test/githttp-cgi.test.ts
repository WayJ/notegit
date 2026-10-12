import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitSmartRequest, buildRemoteUser, parseRemoteUser, buildCgiEnv } from '../src/githttp/cgi.ts';
import { vaultRepoDirName } from '../src/vaults/repo-path.ts';

// S3-T2 单元测试：CGI 环境组装、Smart HTTP 请求解析、REMOTE_USER 透传格式
// （行为级闭环见 githttp-behavior.test.ts；逐 ref 判定自 S3-T5 起见
//  githttp-ref-rules.test.ts）。

const sp = (qs: string) => new URLSearchParams(qs);

// ── URL/端点解析：白名单化的 Smart HTTP 面 ─────────────────────────────────

test('parseGitSmartRequest：四个 Smart HTTP 端点正确解析出 slug/service/action', () => {
  assert.deepEqual(parseGitSmartRequest('GET', '/git/docs.git/info/refs', sp('service=git-upload-pack')), {
    slug: 'docs',
    suffix: '/info/refs',
    service: 'git-upload-pack',
    action: 'read',
  });
  assert.deepEqual(parseGitSmartRequest('GET', '/git/docs.git/info/refs', sp('service=git-receive-pack')), {
    slug: 'docs',
    suffix: '/info/refs',
    service: 'git-receive-pack',
    action: 'write',
  });
  assert.deepEqual(parseGitSmartRequest('POST', '/git/docs.git/git-upload-pack', sp('')), {
    slug: 'docs',
    suffix: '/git-upload-pack',
    service: 'git-upload-pack',
    action: 'read',
  });
  assert.deepEqual(parseGitSmartRequest('POST', '/git/docs.git/git-receive-pack', sp('')), {
    slug: 'docs',
    suffix: '/git-receive-pack',
    service: 'git-receive-pack',
    action: 'write',
  });
  // .git 后缀可选（clone URL 惯例兼容；slug 字符集不含点，无歧义）
  assert.deepEqual(parseGitSmartRequest('GET', '/git/docs/info/refs', sp('service=git-upload-pack'))?.slug, 'docs');
});

test('parseGitSmartRequest：白名单外的请求一律 null（不进入 CGI 转发）', () => {
  const cases: Array<[string, string, URLSearchParams]> = [
    ['GET', '/git/docs.git/info/refs', sp('')], // 无 service（哑协议形态）
    ['GET', '/git/docs.git/info/refs', sp('service=git-upload-archive')], // 未知 service
    ['GET', '/git/docs.git/info/refs', sp('service=not-a-service')],
    ['POST', '/git/docs.git/info/refs', sp('service=git-upload-pack')], // 方法错配
    ['GET', '/git/docs.git/git-upload-pack', sp('')],
    ['PUT', '/git/docs.git/git-receive-pack', sp('')],
    ['GET', '/git/docs.git/objects/info/packs', sp('')], // 哑协议对象端点
    ['GET', '/git/docs.git', sp('')], // 无端点后缀
    ['GET', '/git/docs.git/', sp('service=git-upload-pack')], // 尾斜杠不在白名单
    ['GET', '/git/../../etc.git/info/refs', sp('service=git-upload-pack')], // 路径穿越
    ['GET', '/git/..%2f..%2fetc.git/info/refs', sp('service=git-upload-pack')], // 编码穿越（slug 字符集拒绝）
    ['GET', '/git/Docs.git/info/refs', sp('service=git-upload-pack')], // slug 仅小写
    ['GET', '/git/do cs.git/info/refs', sp('service=git-upload-pack')],
    ['GET', '/git/docs.git/../other/info/refs', sp('service=git-upload-pack')],
    ['GET', '/api/v1/vaults/docs', sp('')],
  ];
  for (const [method, pathname, query] of cases) {
    assert.equal(parseGitSmartRequest(method, pathname, query), null, `${method} ${pathname} 应被拒`);
  }
});

// ── REMOTE_USER 透传格式（api.md §8.4：认证员工标识 + 凭据 id）──────────────

test('buildRemoteUser/parseRemoteUser：employeeId:credentialId 往返；畸形输入 null', () => {
  assert.equal(buildRemoteUser(7, 11), '7:11');
  assert.deepEqual(parseRemoteUser('7:11'), { employeeId: 7, credentialId: 11 });
  assert.equal(parseRemoteUser('7'), null);
  assert.equal(parseRemoteUser('7:'), null);
  assert.equal(parseRemoteUser('a:b'), null);
  assert.equal(parseRemoteUser(''), null);
  assert.equal(parseRemoteUser('7:11:12'), null);
});

// ── CGI 环境组装 ───────────────────────────────────────────────────────────

test('buildCgiEnv：PATH_INFO 用稳定 ID（不含 slug）；协议/转发头逐项注入', () => {
  const env = buildCgiEnv({
    method: 'POST',
    pathInfo: `/${vaultRepoDirName(12)}/info/refs`,
    queryString: 'service=git-upload-pack',
    projectRoot: '/srv/gitroot',
    remoteUser: buildRemoteUser(3, 9),
    remoteAddr: '10.0.0.9',
    contentType: 'application/x-git-upload-pack-request',
    contentLength: '1234',
    acceptEncoding: 'gzip',
    gitProtocol: 'version=2',
    extra: { NOTEGIT_DB: '/srv/db.sqlite', NOTEGIT_VAULT_ID: '12', NOTEGIT_VAULT_SLUG: 'docs' },
  });
  assert.equal(env['PATH_INFO'], '/12.git/info/refs');
  assert.ok(!env['PATH_INFO']!.includes('docs'), 'PATH_INFO 不得含 slug（路径仅经稳定 ID 映射）');
  assert.equal(env['GIT_PROJECT_ROOT'], '/srv/gitroot');
  assert.equal(env['GIT_HTTP_EXPORT_ALL'], '1');
  assert.equal(env['REMOTE_USER'], '3:9');
  assert.equal(env['GATEWAY_INTERFACE'], 'CGI/1.1');
  assert.equal(env['REQUEST_METHOD'], 'POST');
  assert.equal(env['QUERY_STRING'], 'service=git-upload-pack');
  assert.equal(env['CONTENT_TYPE'], 'application/x-git-upload-pack-request');
  assert.equal(env['CONTENT_LENGTH'], '1234');
  assert.equal(env['HTTP_ACCEPT_ENCODING'], 'gzip');
  assert.equal(env['HTTP_GIT_PROTOCOL'], 'version=2');
  assert.equal(env['NOTEGIT_DB'], '/srv/db.sqlite');
  assert.equal(env['NOTEGIT_VAULT_ID'], '12');
  assert.equal(env['SERVER_PROTOCOL'], 'HTTP/1.1');
});

test('buildCgiEnv：缺省的可选头不注入对应变量（chunked 推送无 CONTENT_LENGTH）', () => {
  const env = buildCgiEnv({
    method: 'GET',
    pathInfo: '/3.git/info/refs',
    queryString: '',
    projectRoot: '/srv/gitroot',
    remoteUser: '1:2',
  });
  assert.equal('CONTENT_LENGTH' in env, false);
  assert.equal('CONTENT_TYPE' in env, false);
  assert.equal('HTTP_CONTENT_ENCODING' in env, false);
  assert.equal('HTTP_GIT_PROTOCOL' in env, false);
});

// ── vaultRepoDirName（repo-path.ts 正映射的段形式）──────────────────────────

test('vaultRepoDirName：正整数 → `<id>.git`；注入域与 vaultRepoPath 同防线', () => {
  assert.equal(vaultRepoDirName(42), '42.git');
  for (const bad of [0, -1, 1.5, NaN, Infinity, 2 ** 53, '7', null, undefined, {}]) {
    assert.throws(() => vaultRepoDirName(bad as number), RangeError, `id=${String(bad)} 应被拒绝`);
  }
});

// ── pre-receive 逐 ref 授权判定已移驻 githttp/ref-rules.ts（S3-T5 单一判定源，
//    pre-receive 与 update hook 共用）——判定测试见 githttp-ref-rules.test.ts ──
