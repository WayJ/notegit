import { ERROR_REGISTRY } from 'notegit-validation';

/**
 * S4-T8 统一错误提示：错误码 → 修正建议映射表（breakdown §2.3 S4-T8 行）。
 *
 * 键来源受测试约束（web-error-hints.test.ts）：validation 码 ⊆ ERROR_REGISTRY
 * （validation.md §6.2 机器注册表——单一来源，不杜撰码），api 码 ⊆ api.md §1
 * 错误码注册表。建议文案与注册表消息模板的修正语义一致（模板「；」后的行动
 * 指引即建议来源），此处给出面向 web 使用者的完整句子。
 *
 * 消费面（T8 收口）：web 页面域写端点拒绝响应统一携带 code + hint——
 * - upload POST：JSON `error.code`/`error.hint`（422 格式类 / 403 权限类）；
 * - rename/delete POST：同页回显 notice（code + message + hint）；
 * - submissions 422 **不带 hint**（保持裸 T2 报告——与契约示例
 *   report-web-submit-draft-rejected.json 同构，见对应测试；报告 message 模板
 *   本身已含修正指引）；409 信封 §8.2 已定形不扩字段。
 */

/** 修正建议（面向 web 使用者的行动指引；键 = 注册表错误码） */
export const ERROR_HINTS: Readonly<Record<string, string>> = {
  // ── validation §6.2（格式/内容类——模板修正语义的完整句形态） ──
  'E-FM-001': '在文件首行补 `---` 开始的 frontmatter 块，并填写 title 等元数据后重新提交。',
  'E-FM-002': '修正 frontmatter 的 YAML 语法（检查缩进、引号与冒号后空格）后重新提交。',
  'E-FM-003': '填写非空标题（≤200 字符）后重新提交。',
  'E-FM-004': '按字段期望类型修改取值（如 tags 应为列表、title 应为字符串）后重新提交。',
  'E-FM-005': '将 status 改为 active、draft 或 deprecated 之一（缺省按 active 解释）。',
  'E-FM-006': '删除 frontmatter 中的重复键，每个键只保留一份。',
  'E-FM-007': '移除 frontmatter 中的自定义 tag、锚点、别名或合并键，仅使用安全 YAML。',
  'E-FM-008': '精简 frontmatter 元数据至资源常量内（减少字段或缩短取值）。',
  'E-FM-009': '调整字段取值使其满足约束上限（见消息中的 limit 与实际值）。',
  'E-PATH-001': '修改路径：使用允许的字符集与 NFC 形态，避免保留名、过长或过深的段。',
  'E-PATH-002': '符号链接不可入库——上传常规文件替代。',
  'E-PATH-003': 'submodule/gitlink 不可入库——移除子模块引用。',
  'E-PATH-004': '与既有文件仅大小写不同——改名避免大小写冲突（大小写不敏感系统会互相覆盖）。',
  'E-PATH-005': '移除 Git 仓库组件条目（含子模块配置）或非常规 mode 的条目。',
  'E-LIMIT-001': '拆分文档至单文件上限内。',
  'E-LIMIT-002': '改用允许清单内的文件类型（如 .md/.png/.jpg），或联系管理员调整清单。',
  'E-LIMIT-003': '压缩或裁剪附件至容量上限内。',
  'E-LIMIT-004': '分批推送，单次推送总量不超过上限。',
  'E-LIMIT-005': '清理库内不再需要的内容或联系管理员扩容。',
  'E-RUN-001': '本次操作被拒绝——可重试，或减小提交/推送规模。',
  'E-RUN-002': '请重试；若持续失败请联系管理员反馈。',
  // ── api.md §1（权限/请求面——web 写端点拒绝映射所用码） ──
  'E-AUTHZ-001': '当前角色无写入权限——如需编辑，请联系库管理员将你的角色调整为 editor。',
  'E-RES-001': '请核对地址是否正确；若无成员关系或库不存在，响应同形（不泄露库是否存在）。',
  'E-RES-003': '分支已被他人更新——刷新页面取最新基线后重提（你的草稿与表单内容已保留）。',
  'E-RES-004': '请求形状不符——按接口文档修正字段后重试。',
  'E-MAINT-001': '实例维护中，写入暂不可用——请稍后重试。',
};

/** 错误码 → 修正建议；未注册码返回 undefined（不杜撰回退文案） */
export function hintFor(code: string): string | undefined {
  return ERROR_HINTS[code];
}

/** 注册表错误级码覆盖自检键（模块加载期断言——防注册表演进后静默漏项） */
for (const entry of ERROR_REGISTRY) {
  if (entry.severity === 'error' && ERROR_HINTS[entry.code] === undefined) {
    throw new Error(`web/hints.ts：注册表 error 级码缺修正建议：${entry.code}`);
  }
}
