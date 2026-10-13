import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  browseHarness,
  seededVault,
  addEmployee,
  addMember,
  gitOut,
  repoPathOf,
  type BrowseHarness,
} from './web-browse-fixtures.ts';
import {
  pushHistorySeries,
  pageCommitSeq,
  pageDiffLines,
  unescapeHtml,
  gitDiffOut,
} from './web-history-fixtures.ts';

// S5-T7 重命名与跨库移动的历史边界（breakdown §2.4 S5-T7 行；架构 §9「重命名
// 历史依据 Git 跟踪，不承诺跨库永久 ID」；DOD-15 边界说明）：
//
// 场景一（库内重命名可追）：S4-T5 rename = upsert(新路径)+delete(旧路径) 单
// 提交走发布组件、内容逐字节保留——git 改名检测（R100）可识别，历史面
// `--follow` 须在新路径追到改名前的提交（一致性对照 = 测试另行直通 spawn 的
// `git log --follow`，不经生产读面）；旧路径历史完整保留（含改名移走提交）。
//
// 场景二（跨库移动不跟随）：移动 = 旧库 Web 删除 + 新库 Web 上传（同内容）。
// 旧库路径历史完整保留；新库历史从新提交起——纵然改名跟随已启用且两库内容
// 逐字节相同，也不发生跨库历史跟随（库间无共享对象存储/无跨库永久 ID）；
// 引用 = 库+路径+commit 三要素，移动后旧引用仍按 commit 解析到旧库历史版本。
//
// 逐提交寻址边界（改名前后）：版本预览/diff 按该提交当时的实际路径寻址——
// 改名前的提交在新路径 404（该版本处无此路径）、旧路径 200 可预览；改名提交
// 在新路径的 diff 如实呈现整文件新增。此为既有语义的边界固化。

/** 边界笔记内容（frontmatter 合法——Web rename/upload 的目标路径重判定可过） */
const NOTE_V1 = '---\ntitle: 边界笔记\n---\n\nv1 正文\n';
const NOTE_V2 = '---\ntitle: 边界笔记\n---\n\nv2 正文\n';

/** 种子：alpha 库 README + docs/note.md 两笔直推历史（c1 建 / c2 改） */
async function seededBoundaryVault() {
  const h = await browseHarness();
  const alice = addEmployee(h.db, { username: 'alice' });
  const vaultId = await seededVault(h, 'alpha', alice, { 'README.md': '# 导航\n' });
  await pushHistorySeries(h, vaultId, [
    { message: 'c1 建笔记', files: { 'docs/note.md': NOTE_V1 } },
    { message: 'c2 改笔记', files: { 'docs/note.md': NOTE_V2 } },
  ]);
  addMember(h.db, vaultId, alice, 'editor', alice);
  return { h, alice, vaultId, headers: h.session(alice) };
}

/** 表单 POST（rename/delete）——同源校验 Origin 头必备（CSRF 面） */
function formPost(
  h: BrowseHarness,
  headers: Record<string, string>,
  method: 'POST',
  url: string,
  payload: string,
) {
  return h.app.inject({
    method,
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...headers },
    payload,
  });
}

/** 直通 `git log --follow`：[shortOid, subject] 序列（路径级历史页一致性对照——
 *  与生产读面同一命令形态；绝不用于种子构造） */
async function gitLogFollowSeq(repoPath: string, filePath: string): Promise<string[][]> {
  const out = await gitOut(['--git-dir', repoPath, 'log', '--follow', '--format=%h%x1f%s', 'refs/heads/main', '--', filePath]);
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const i = l.indexOf('\x1f');
      return [l.slice(0, i), l.slice(i + 1)];
    });
}

/** 历史页 [shortOid, subject] 序列（转义还原——与 git 原文对照） */
function pageSeq(body: string): string[][] {
  return pageCommitSeq(body).map(([oid, , , subject]) => [oid, unescapeHtml(subject)]);
}

/** git diff 原文行序列（去尾空行——对照基线；与 consistency 测试同法） */
function diffRawLines(out: string): string[] {
  const lines = out.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

test('场景一：重命名后历史页 --follow 可追改名前后，旧路径历史完整，改名提交 R100 可检测（S4-T5 语义核对）', async () => {
  const { h, headers } = await seededBoundaryVault();
  try {
    const repo = repoPathOf(h, 1);
    // Web 重命名 docs/note.md → docs/renamed.md（走发布组件：单提交、内容逐字节保留）
    const res = await formPost(
      h,
      headers,
      'POST',
      `/vaults/alpha/rename/${['docs', 'note.md'].map(encodeURIComponent).join('/')}`,
      `to=${encodeURIComponent('docs/renamed.md')}`,
    );
    assert.equal(res.statusCode, 302, res.body);

    // S4-T5 核对：发布组件产生的改名提交对 git 改名检测可识别（R100——
    // upsert 内容与源 blob 逐字节相同），--follow 因此可穿越
    const nameStatus = (await gitOut(['--git-dir', repo, 'diff', '-M', '--name-status', 'refs/heads/main^', 'refs/heads/main'])).trim();
    assert.equal(nameStatus, 'R100\tdocs/note.md\tdocs/renamed.md', '单提交 R100 改名（M 简并可检测）');

    // 新路径历史页：改名提交 + c2 + c1（可追改名前后）——与直通 git log --follow 一致
    const newPage = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/renamed.md', headers });
    assert.equal(newPage.statusCode, 200, newPage.body);
    const newSeq = pageSeq(newPage.body);
    assert.deepEqual(newSeq, await gitLogFollowSeq(repo, 'docs/renamed.md'), '新路径历史 = git log --follow 同序同值');
    assert.equal(newSeq.length, 3, '恰三笔：改名 + c2 + c1（改名前提交可追）');
    assert.ok(newSeq.some(([, s]) => s.includes('c1 建笔记')), '改名前的 c1 出现在新路径历史');

    // 旧路径历史页：完整保留（改名移走提交 + c2 + c1）——不因重命名丢失
    const oldPage = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/note.md', headers });
    assert.equal(oldPage.statusCode, 200, oldPage.body);
    assert.deepEqual(pageSeq(oldPage.body), await gitLogFollowSeq(repo, 'docs/note.md'), '旧路径历史完整保留');
  } finally {
    await h.close();
  }
});

test('逐提交寻址边界：改名前提交在新路径 404、旧路径 200 可预览；改名提交在新路径 diff 如实整文件新增', async () => {
  const { h, headers } = await seededBoundaryVault();
  try {
    const repo = repoPathOf(h, 1);
    const res = await formPost(
      h,
      headers,
      'POST',
      `/vaults/alpha/rename/${['docs', 'note.md'].map(encodeURIComponent).join('/')}`,
      `to=${encodeURIComponent('docs/renamed.md')}`,
    );
    assert.equal(res.statusCode, 302, res.body);
    const renameCommit = (await gitOut(['--git-dir', repo, 'rev-parse', 'refs/heads/main'])).trim();
    const c2 = (await gitOut(['--git-dir', repo, 'rev-parse', 'refs/heads/main~1'])).trim(); // 改名提交的父 = c2

    // c2 时文件在旧路径——新路径处该版本不存在（404 反存在性，不虚构内容）
    const atNew = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c2}/docs/renamed.md`, headers });
    assert.equal(atNew.statusCode, 404, '改名前提交 × 新路径 = 该版本处无此路径');

    // c2 × 旧路径：历史版本预览可解析（引用三要素按当时实际路径成立）
    const atOld = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c2}/docs/note.md`, headers });
    assert.equal(atOld.statusCode, 200, atOld.body);
    assert.match(atOld.body, /v2 正文/, '旧路径版本预览渲染改名前内容');

    // 改名提交 × 新路径 diff：与 git diff 父↔改名提交 一致（整文件新增如实呈现）
    const diff = await h.app.inject({ method: 'GET', url: `/vaults/alpha/diff/${renameCommit}/docs/renamed.md`, headers });
    assert.equal(diff.statusCode, 200, diff.body);
    assert.deepEqual(
      pageDiffLines(diff.body).map(([, text]) => text),
      diffRawLines(await gitDiffOut(repo, `${renameCommit}^`, renameCommit, 'docs/renamed.md')),
      '改名提交 diff 与 git diff 一致（新路径视角整文件新增）',
    );
  } finally {
    await h.close();
  }
});

test('场景二：跨库移动不跟随——旧库历史完整保留、新库从新提交起、旧引用（库+路径+commit）仍可解析', async () => {
  const h = await browseHarness();
  try {
    const alice = addEmployee(h.db, { username: 'alice' });
    const alpha = await seededVault(h, 'alpha', alice, { 'README.md': '# 导航\n' });
    await pushHistorySeries(h, alpha, [
      { message: 'c1 建笔记', files: { 'docs/note.md': NOTE_V1 } },
      { message: 'c2 改笔记', files: { 'docs/note.md': NOTE_V2 } },
    ]);
    const beta = await seededVault(h, 'beta', alice, { 'README.md': '# beta\n' });
    addMember(h.db, alpha, alice, 'editor', alice);
    addMember(h.db, beta, alice, 'editor', alice);
    const headers = h.session(alice);
    const alphaRepo = repoPathOf(h, alpha);
    const betaRepo = repoPathOf(h, beta);

    // 移动 = 旧库 Web 删除 + 新库 Web 上传（同一内容逐字节）
    const del = await formPost(
      h,
      headers,
      'POST',
      `/vaults/alpha/delete/${['docs', 'note.md'].map(encodeURIComponent).join('/')}`,
      '',
    );
    assert.equal(del.statusCode, 302, del.body);
    const up = await h.app.inject({
      method: 'POST',
      url: '/vaults/beta/upload/docs/note.md',
      headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost', ...headers },
      payload: NOTE_V2,
    });
    assert.equal(up.statusCode, 200, JSON.stringify(up.json()));
    // 新库内再改名一次：证明「跟随」仅在同一库内生效、从不跨库
    const ren = await formPost(
      h,
      headers,
      'POST',
      `/vaults/beta/rename/${['docs', 'note.md'].map(encodeURIComponent).join('/')}`,
      `to=${encodeURIComponent('docs/moved.md')}`,
    );
    assert.equal(ren.statusCode, 302, ren.body);

    // 旧库：路径历史完整保留（删除提交 + c2 + c1——移动不带走历史）
    const alphaPage = await h.app.inject({ method: 'GET', url: '/vaults/alpha/history/docs/note.md', headers });
    assert.equal(alphaPage.statusCode, 200, alphaPage.body);
    const alphaSeq = pageSeq(alphaPage.body);
    assert.deepEqual(alphaSeq, await gitLogFollowSeq(alphaRepo, 'docs/note.md'), '旧库历史与 git log --follow 一致');
    assert.equal(alphaSeq.length, 3, '旧库恰三笔：删除 + c2 + c1（完整保留）');
    assert.match(alphaSeq[0][1], /Web 删除/, '最新一笔为删除提交');

    // 新库：从新提交起——改名跟随只回溯到新库首笔（上传），绝无旧库 c1/c2
    const betaPage = await h.app.inject({ method: 'GET', url: '/vaults/beta/history/docs/moved.md', headers });
    assert.equal(betaPage.statusCode, 200, betaPage.body);
    const betaSeq = pageSeq(betaPage.body);
    assert.deepEqual(betaSeq, await gitLogFollowSeq(betaRepo, 'docs/moved.md'), '新库历史与 git log --follow 一致');
    assert.equal(betaSeq.length, 2, '新库恰两笔：新库改名 + 新库上传');
    assert.match(betaSeq[0][1], /Web 重命名/, '最新一笔为新库改名');
    assert.match(betaSeq[1][1], /Web 上传/, '次新一笔为新库上传');
    for (const [, s] of betaSeq) {
      assert.ok(!s.includes('c1 建笔记') && !s.includes('c2 改笔记') && !s.includes('Web 删除'), `新库历史不得出现旧库提交：${s}`);
    }

    // 旧引用仍可解析：库+路径+commit 三要素指向移动前版本——按 commit 解析不受移动影响
    const c2 = (await gitOut(['--git-dir', alphaRepo, 'rev-parse', 'refs/heads/main~1'])).trim(); // 删除提交的父 = c2
    const oldRef = await h.app.inject({ method: 'GET', url: `/vaults/alpha/version/${c2}/docs/note.md`, headers });
    assert.equal(oldRef.statusCode, 200, oldRef.body);
    assert.match(oldRef.body, /v2 正文/, '旧引用解析到移动前版本内容');

    // 新库当前版本同样可解析（移动后的知识在新库按新提交寻址）
    const betaHead = (await gitOut(['--git-dir', betaRepo, 'rev-parse', 'refs/heads/main'])).trim();
    const newRef = await h.app.inject({ method: 'GET', url: `/vaults/beta/version/${betaHead}/docs/moved.md`, headers });
    assert.equal(newRef.statusCode, 200, newRef.body);
    assert.match(newRef.body, /v2 正文/, '新库版本预览渲染移动后内容');
  } finally {
    await h.close();
  }
});

test('用户文档成文：docs/user/history-boundary.md 记录重命名可追/跨库不跟随/引用含 commit 三要素', async () => {
  const docPath = fileURLToPath(new URL('../../docs/user/history-boundary.md', import.meta.url));
  const text = await readFile(docPath, 'utf8');
  assert.match(text, /--follow/, '记录重命名历史跟随（--follow 语义）');
  assert.match(text, /跨库/, '记录跨库移动边界');
  assert.match(text, /旧库历史完整保留/, '记录旧历史留在旧库');
  assert.match(text, /commit/, '记录引用含 commit（旧引用仍可解析）');
});
