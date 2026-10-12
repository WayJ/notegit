/**
 * 占位内容校验（S3-T2；**T4 换装点**）：先写坏后删/多 ref 夹带的行为测试
 * （route-b B5/B6）在本任务即须拦截，正式的逐提交校验（validation 契约全量、
 * packages/validation 单一来源）是 S3-T4 的交付——T4 将本文件整体替换为
 * 共享校验器实现，调用面（findFrontmatterViolations 的签名与消费点）保持。
 *
 * 占位规则 = spike 同款最小子集：推送范围内每个新提交，新增/修改的 .md 知识
 * 文档须含 frontmatter title（README.md 导航文档豁免，架构 §5.2；删除条目
 * 不校验）。多 ref 原子性由 pre-receive 拒绝即整包回滚的原生语义保证。
 */

/** git 查询缝（只做只读对象遍历）；注入便于替换与测试 */
export type GitQuery = (args: readonly string[]) => Promise<string>;

const ZERO = /^0+$/;

export async function findFrontmatterViolations(
  query: GitQuery,
  newOid: string,
  oldOid: string,
): Promise<string[]> {
  const violations: string[] = [];
  // 推送范围内全部新提交：根推送（old 为零）用 --not --all 锚定服务器已有历史
  const revArgs = ZERO.test(oldOid)
    ? ['rev-list', newOid, '--not', '--all']
    : ['rev-list', newOid, `^${oldOid}`];
  const commits = (await query(revArgs)).trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    // --root 覆盖根提交（空库首推）
    const entries = (await query(['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', commit]))
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const entry of entries) {
      const [status, ...rest] = entry.split('\t');
      const filePath = rest.join('\t'); // 文件名可含制表符以外的任意字符，稳妥拼回
      if (!filePath.endsWith('.md')) continue;
      if (filePath.toLowerCase() === 'readme.md' || filePath.toLowerCase().endsWith('/readme.md')) {
        continue; // 导航文档豁免 frontmatter（架构 §5.2）
      }
      if (status !== 'A' && status !== 'M') continue; // 删除条目不校验（D）
      const content = await query(['show', `${commit}:${filePath}`]);
      const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content);
      if (fm === null || !/^title:\s*\S/m.test(fm[1]!)) {
        violations.push(`${filePath}（提交 ${commit.slice(0, 7)}）：缺少必需的 frontmatter title（占位校验，T4 换共享校验器）`);
      }
    }
  }
  return violations;
}
