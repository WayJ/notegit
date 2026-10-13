/**
 * S4-T3 编辑表单字段模型与文档组装（validation.md §3 六字段 + 架构 §5.1）。
 *
 * 组装规则（确定性布局——错误映射的行定位依赖它）：
 * - 第 1 行 `---`；六字段自第 2 行起按固定顺序（title→owner→description→tags→
 *   status→source）各占一行，空白（去空白后为空）的字段整行省略——title 省略
 *   即触发 E-FM-003（唯一必填，行=首个内容行）。
 * - 标量一律 JSON 双引号串、列表 JSON 流式数组（JSON 是 YAML 1.2 流式子集，
 *   转义规则兼容——不手写 YAML 序列化器，杜绝注入面）。
 * - extra（额外字段）原文逐行附于六字段之后（安全 YAML 值由校验单一来源判
 *   定——E-FM-002/006/007/008 均经发布组件报告映射回 extra 区行号）。
 * - 闭合 `---` 后接正文（textarea 多行原文，无富文本）。
 */

import { extractFrontmatter } from 'notegit-validation';

/** 表单六字段 + 额外字段（原始 YAML 文本，安全值）；tags 为逗号分隔输入 */
export interface EditFormFields {
  readonly title: string;
  readonly owner: string;
  readonly description: string;
  readonly tags: string;
  readonly status: string;
  readonly source: string;
  readonly extra: string;
}

export type SixFieldKey = 'title' | 'owner' | 'description' | 'tags' | 'status' | 'source';

export const SIX_FIELD_KEYS: readonly SixFieldKey[] = [
  'title', 'owner', 'description', 'tags', 'status', 'source',
];

/** 组装产物：全文 + extra 块行定位（错误映射用） */
export interface ComposedDocument {
  readonly text: string;
  /** extra 块首行文档行号；无 extra 行 = null */
  readonly extraStartLine: number | null;
  /** extra 块行数（0 = 无） */
  readonly extraLineCount: number;
}

/** 逗号分隔 tags 输入 → 标签列表（各项去空白、空项丢弃） */
function tagsOf(raw: string): string[] {
  return raw.split(',').map((t) => t.trim()).filter((t) => t !== '');
}

/** extra 原文 → 行数组（首尾空白行剪除；内部缩进与空行原样保留） */
function extraLinesOf(raw: string): string[] {
  const trimmed = raw.replace(/^[\n\t ]+/, '').replace(/[\n\t ]+$/, '');
  return trimmed === '' ? [] : trimmed.split('\n');
}

export function composeDocument(fields: EditFormFields, body: string): ComposedDocument {
  const lines: string[] = [];
  if (fields.title.trim() !== '') lines.push(`title: ${JSON.stringify(fields.title)}`);
  if (fields.owner.trim() !== '') lines.push(`owner: ${JSON.stringify(fields.owner)}`);
  if (fields.description.trim() !== '') lines.push(`description: ${JSON.stringify(fields.description)}`);
  const tags = tagsOf(fields.tags);
  if (tags.length > 0) lines.push(`tags: ${JSON.stringify(tags)}`);
  if (fields.status.trim() !== '') lines.push(`status: ${JSON.stringify(fields.status.trim())}`);
  if (fields.source.trim() !== '') lines.push(`source: ${JSON.stringify(fields.source)}`);
  const sixCount = lines.length;
  const extraLines = extraLinesOf(fields.extra);
  lines.push(...extraLines);
  const block = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return {
    text: `---\n${block}---\n${body}`,
    extraStartLine: extraLines.length === 0 ? null : 2 + sixCount,
    extraLineCount: extraLines.length,
  };
}

/** 从文件名生成 title（架构 §5.1：网页新建时可从文件名生成，提交前可改；
 *  仅去扩展名——不断言真实来源，不做大小写/分隔符改写） */
export function titleFromFilename(path: string): string {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

export interface ParsedForForm {
  readonly fields: Omit<EditFormFields, 'extra'>;
  readonly extra: string;
  readonly body: string;
}

const SIX_SET = new Set<string>(SIX_FIELD_KEYS);

/** 顶层键行（无缩进且含冒号）→ 键名；否则 null */
function topKeyOf(line: string): string | null {
  if (/^\s/.test(line)) return null;
  const m = /^([^\s:][^:]*):(?:\s|$)/.exec(line);
  return m === null ? null : m[1]!;
}

/** 标量取值（best-effort 回填）：JSON/单引号解包、裸标量原样；空值='' */
function scalarOf(raw: string): string {
  const v = raw.trim();
  if (v === '' || v === '|' || v === '>') return '';
  if (v.startsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v;
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  return v;
}

/** 流式列表 [a, b] → 逗号输入形态；非列表原样（校验权威在发布组件） */
function flowListItems(raw: string): string | null {
  const v = raw.trim();
  if (!(v.startsWith('[') && v.endsWith(']'))) return null;
  const inner = v.slice(1, -1).trim();
  if (inner === '') return '';
  return inner.split(',').map((s) => scalarOf(s)).join(', ');
}

/**
 * 回填解析（best-effort，仅展示）：六字段进表单（流式/块式列表、引号标量），
 * 其余键连同行原文进 extra 文本区，闭合 `---` 后为正文（与 view 剥离同款切法）。
 * 无 frontmatter（README/旧文档）→ 表单全空、正文=全文；不做校验判定。
 */
export function parseDocForForm(text: string): ParsedForForm {
  const fields: Record<SixFieldKey, string> = {
    title: '', owner: '', description: '', tags: '', status: '', source: '',
  };
  const extraLines: string[] = [];
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = src.split('\n');
  const fm = extractFrontmatter(text);

  if (fm.kind === 'block') {
    const block = (fm.blockText ?? '').split('\n');
    for (let i = 0; i < block.length; i++) {
      const line = block[i]!;
      const key = topKeyOf(line);
      if (key !== null && SIX_SET.has(key)) {
        const raw = line.slice(line.indexOf(':') + 1);
        if (key === 'tags') {
          const flow = flowListItems(raw);
          if (flow !== null) {
            fields.tags = flow;
            continue;
          }
          if (raw.trim() === '') {
            // 块式列表：向后收集 `  - item` 行
            const items: string[] = [];
            let j = i + 1;
            while (j < block.length && /^\s+-\s/.test(block[j]!)) {
              items.push(scalarOf(block[j]!.replace(/^\s+-\s*/, '')));
              j++;
            }
            if (items.length > 0) {
              fields.tags = items.join(', ');
              i = j - 1;
              continue;
            }
          }
          fields.tags = raw.trim(); // 标量形态（非法值）原样回填——校验兜底
          continue;
        }
        fields[key as SixFieldKey] = scalarOf(raw);
        continue;
      }
      extraLines.push(line);
    }
  }

  const body = fm.kind === 'block' && fm.closeLine !== undefined
    ? lines.slice(fm.closeLine).join('\n')
    : src;
  return {
    fields: { ...fields },
    extra: extraLines.join('\n').replace(/^[\n\t ]+/, '').replace(/[\n\t ]+$/, ''),
    body,
  };
}
