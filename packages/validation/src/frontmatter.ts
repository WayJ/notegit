/** frontmatter 规则（validation.md §3）：六字段 title-only + YAML 安全子集 + 版本化资源常量。 */
import { parseDocument, isAlias, isPair, isMap, isSeq, isScalar, LineCounter } from 'yaml'
import type { Node, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import type { Issue } from './issue.ts'
import { issueOf } from './registry.ts'

/** 版本化常量（T2 建议值，随 rulesVersion 变更；与 schemas/frontmatter.schema.json 由测试交叉核对）。 */
export const FM_CONSTANTS = {
  titleMaxLength: 200,
  ownerMaxLength: 100,
  descriptionMaxLength: 500,
  sourceMaxLength: 500,
  tagMinLength: 1,
  tagMaxLength: 64,
  tagsMaxItems: 32,
  statusEnum: ['active', 'draft', 'deprecated'],
} as const

/** YAML 安全子集资源常量（validation.md §3.2：限制大小和解析资源）。 */
export const YAML_RESOURCES = {
  maxBlockBytes: 65536,
  maxNodes: 1000,
  maxDepth: 8,
} as const

/** YAML 1.2 core schema 之外的自定义 tag 一律拒绝（E-FM-007）。 */
const STANDARD_TAGS = new Set([
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:merge',
  'tag:yaml.org,2002:value',
  'tag:yaml.org,2002:binary',
  'tag:yaml.org,2002:timestamp',
])

export interface ExtractedFrontmatter {
  kind: 'none' | 'unterminated' | 'block'
  /** kind=block 时为两侧 --- 之间的原始文本（含换行）；文档行号 = 块内行号 + 1 */
  blockText?: string
  closeLine?: number
}

/** 提取 frontmatter 块：首行（允许 BOM）trimEnd 后为 `---`，向下找闭合 `---`（trimEnd 容忍 CRLF）。 */
export function extractFrontmatter(text: string): ExtractedFrontmatter {
  const src = text.startsWith('﻿') ? text.slice(1) : text
  const lines = src.split('\n')
  if (lines.length === 0 || lines[0].trimEnd() !== '---') return { kind: 'none' }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') {
      return { kind: 'block', blockText: lines.slice(1, i).join('\n'), closeLine: i + 1 }
    }
  }
  return { kind: 'unterminated' }
}

interface UnsafeConstruct {
  kind: 'anchor' | 'alias' | 'merge' | 'tag'
  line: number
  detail: string
}

/** 解析 YAML 安全子集：语法错误/不安全构造/重复键/资源常量。返回 null 表示解析层失败（调用方停止字段校验）。 */
function parseSafeYaml(blockText: string, path: string): { issues: Issue[]; doc: ReturnType<typeof parseDocument> | null; lc: LineCounter | null } {
  const byteLen = Buffer.byteLength(blockText, 'utf8')
  if (byteLen > YAML_RESOURCES.maxBlockBytes) {
    return {
      issues: [issueOf('E-FM-008', { path, actual: `frontmatter 块 ${byteLen} 字节`, limit: YAML_RESOURCES.maxBlockBytes })],
      doc: null,
      lc: null,
    }
  }
  const lc = new LineCounter()
  const doc = parseDocument(blockText, { lineCounter: lc, uniqueKeys: false, prettyErrors: false })
  if (doc.errors.length > 0) {
    const err = doc.errors[0]
    const yamlLine = err.linePos?.[0]?.line ?? 1
    return {
      issues: [issueOf('E-FM-002', { path, actual: err.message.split('\n')[0].slice(0, 200) }, { line: yamlLine + 1 })],
      doc: null,
      lc,
    }
  }

  const unsafe: UnsafeConstruct[] = []
  const dupKeys: Array<{ key: string; line: number }> = []
  let nodeCount = 0
  let maxDepth = 0
  const seenPerMap: Array<Map<string, number>> = []

  const lineOf = (n: Node): number => {
    const pos = n.range?.[0]
    if (pos === undefined) return 1
    const p = lc.linePos(pos)
    return (p?.line ?? 1) + 1 // 块内 1 起始 → 文档内行号（首行是 ---）
  }

  const walk = (node: unknown, depth: number, mapStackIndex: number): void => {
    if (!node || typeof node !== 'object') return
    nodeCount++
    if (isAlias(node)) {
      unsafe.push({ kind: 'alias', line: lineOf(node as Node), detail: `别名 *${node.source}` })
      return
    }
    const n = node as Node & { anchor?: string; tag?: string }
    if (n.anchor !== undefined) unsafe.push({ kind: 'anchor', line: lineOf(n), detail: `锚点 &${n.anchor}` })
    if (n.tag !== undefined && !STANDARD_TAGS.has(n.tag)) {
      unsafe.push({ kind: 'tag', line: lineOf(n), detail: `自定义 tag ${n.tag}` })
    }
    if (isScalar(node)) return
    if (isPair(node)) {
      const pair = node as Pair<Node, Node>
      if (isScalar(pair.key)) {
        const keyScalar = pair.key as Scalar
        const keyStr = String(keyScalar.value)
        if (keyStr === '<<') unsafe.push({ kind: 'merge', line: lineOf(pair.key), detail: '合并键 <<' })
        const seen = seenPerMap[mapStackIndex]
        const prev = seen.get(keyStr)
        if (prev !== undefined) dupKeys.push({ key: keyStr, line: lineOf(pair.key) })
        else seen.set(keyStr, lineOf(pair.key))
      }
      walk(pair.key, depth, mapStackIndex)
      walk(pair.value, depth + 1, mapStackIndex)
      return
    }
    if (isMap(node) || isSeq(node)) {
      const coll = node as YAMLMap | YAMLSeq
      if (isMap(coll)) seenPerMap.push(new Map())
      const myIndex = isMap(coll) ? seenPerMap.length - 1 : mapStackIndex
      maxDepth = Math.max(maxDepth, depth)
      for (const item of coll.items) walk(item, isMap(coll) ? depth : depth + 1, myIndex)
      if (isMap(coll)) seenPerMap.pop()
      return
    }
  }

  if (doc.contents !== null) {
    seenPerMap.push(new Map())
    walk(doc.contents, 1, 0)
    seenPerMap.pop()
  }

  if (unsafe.length > 0) {
    const first = unsafe[0]
    return { issues: [issueOf('E-FM-007', { path, actual: first.detail }, { line: first.line })], doc: null, lc }
  }
  if (dupKeys.length > 0) {
    const d = dupKeys[0]
    return { issues: [issueOf('E-FM-006', { path, field: d.key }, { line: d.line, field: d.key })], doc: null, lc }
  }
  if (nodeCount > YAML_RESOURCES.maxNodes) {
    return { issues: [issueOf('E-FM-008', { path, actual: `解析节点 ${nodeCount}`, limit: YAML_RESOURCES.maxNodes })], doc: null, lc }
  }
  if (maxDepth > YAML_RESOURCES.maxDepth) {
    return { issues: [issueOf('E-FM-008', { path, actual: `嵌套深度 ${maxDepth}`, limit: YAML_RESOURCES.maxDepth })], doc: null, lc }
  }
  return { issues: [], doc, lc }
}

const TITLE_EXPECTED = '去空白后非空的字符串（≤200 字符）'

function typeActual(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'map'
  return typeof v
}

/** 知识文档的 frontmatter 校验（E-FM-001..009 + W-FM-101）。exempt 文件（README/导航豁免）由调用方跳过本函数。 */
export function validateKnowledgeDoc(path: string, text: string): Issue[] {
  const extracted = extractFrontmatter(text)
  if (extracted.kind === 'none') return [issueOf('E-FM-001', { path })]
  if (extracted.kind === 'unterminated') {
    return [issueOf('E-FM-002', { path, actual: 'frontmatter 块未闭合（缺少结束 ---）' }, { line: 2 })]
  }
  const parsed = parseSafeYaml(extracted.blockText ?? '', path)
  if (parsed.issues.length > 0) return parsed.issues

  const root = parsed.doc?.contents ?? null
  const lc = parsed.lc!
  const keyLine = (pair: Pair<Node, Node>): number => {
    const pos = pair.key.range?.[0]
    if (pos === undefined) return 2
    return (lc.linePos(pos)?.line ?? 1) + 1
  }
  if (root !== null && !isMap(root)) {
    return [issueOf('E-FM-002', { path, actual: `顶层必须是键值映射，实际为 ${typeActual(null)}` }, { line: 2 })]
  }
  const map = root as YAMLMap | null
  const pairs: Pair<Node, Node>[] = map ? (map.items as Pair<Node, Node>[]) : []
  const byKey = new Map<string, Pair<Node, Node>>()
  for (const p of pairs) if (isScalar(p.key)) byKey.set(String((p.key as Scalar).value), p)

  const issues: Issue[] = []
  const scalarOf = (p: Pair<Node, Node>): unknown => (isScalar(p.value) ? (p.value as Scalar).value : undefined)
  const firstContentLine = pairs.length > 0 ? keyLine(pairs[0]) : 2

  // title（唯一必填）
  const titlePair = byKey.get('title')
  if (titlePair === undefined) {
    issues.push(issueOf('E-FM-003', { path, field: 'title', expected: TITLE_EXPECTED }, { line: firstContentLine, field: 'title' }))
  } else if (!isScalar(titlePair.value)) {
    issues.push(
      issueOf('E-FM-004', { path, field: 'title', expected: 'string', actual: typeActual(titlePair.value) }, { line: keyLine(titlePair), field: 'title' }),
    )
  } else {
    const v = (titlePair.value as Scalar).value
    if (typeof v !== 'string') {
      issues.push(issueOf('E-FM-004', { path, field: 'title', expected: 'string', actual: typeActual(v) }, { line: keyLine(titlePair), field: 'title' }))
    } else if (v.trim() === '') {
      issues.push(issueOf('E-FM-003', { path, field: 'title', expected: TITLE_EXPECTED }, { line: keyLine(titlePair), field: 'title' }))
    } else if ([...v].length > FM_CONSTANTS.titleMaxLength) {
      issues.push(
        issueOf('E-FM-009', { path, field: 'title', actual: [...v].length, limit: FM_CONSTANTS.titleMaxLength }, { line: keyLine(titlePair), field: 'title' }),
      )
    }
  }

  // owner / description / source：可选字符串 + 缺失提示
  for (const [field, maxLen] of [
    ['owner', FM_CONSTANTS.ownerMaxLength],
    ['description', FM_CONSTANTS.descriptionMaxLength],
    ['source', FM_CONSTANTS.sourceMaxLength],
  ] as const) {
    const pair = byKey.get(field)
    if (pair === undefined) {
      issues.push(issueOf('W-FM-101', { path, field }, { field }))
      continue
    }
    if (!isScalar(pair.value) || typeof scalarOf(pair) !== 'string') {
      issues.push(
        issueOf('E-FM-004', { path, field, expected: 'string', actual: typeActual(scalarOf(pair)) }, { line: keyLine(pair), field }),
      )
    } else {
      const len = [...(scalarOf(pair) as string)].length
      if (len > maxLen) {
        issues.push(issueOf('E-FM-009', { path, field, actual: len, limit: maxLen }, { line: keyLine(pair), field }))
      }
    }
  }

  // tags：可选字符串列表
  const tagsPair = byKey.get('tags')
  if (tagsPair !== undefined) {
    if (!isSeq(tagsPair.value)) {
      issues.push(
        issueOf('E-FM-004', { path, field: 'tags', expected: '字符串列表', actual: typeActual(isScalar(tagsPair.value) ? scalarOf(tagsPair) : tagsPair.value) }, { line: keyLine(tagsPair), field: 'tags' }),
      )
    } else {
      const items = (tagsPair.value as YAMLSeq).items as Node[]
      if (items.length > FM_CONSTANTS.tagsMaxItems) {
        issues.push(issueOf('E-FM-009', { path, field: 'tags', actual: items.length, limit: FM_CONSTANTS.tagsMaxItems }, { line: keyLine(tagsPair), field: 'tags' }))
      }
      const seenTags = new Set<string>()
      for (const item of items) {
        if (!isScalar(item) || typeof (item as Scalar).value !== 'string') {
          issues.push(issueOf('E-FM-004', { path, field: 'tags', expected: 'string', actual: typeActual(isScalar(item) ? (item as Scalar).value : item) }, { line: keyLine(tagsPair), field: 'tags' }))
          continue
        }
        const tag = (item as Scalar).value as string
        const len = [...tag].length
        if (len < FM_CONSTANTS.tagMinLength) {
          issues.push(issueOf('E-FM-009', { path, field: 'tags', actual: '空字符串', limit: FM_CONSTANTS.tagMinLength }, { line: keyLine(tagsPair), field: 'tags' }))
        } else if (len > FM_CONSTANTS.tagMaxLength) {
          issues.push(issueOf('E-FM-009', { path, field: 'tags', actual: len, limit: FM_CONSTANTS.tagMaxLength }, { line: keyLine(tagsPair), field: 'tags' }))
        } else if (seenTags.has(tag)) {
          issues.push(issueOf('E-FM-009', { path, field: 'tags', actual: `重复项 ${tag}`, limit: FM_CONSTANTS.tagsMaxItems }, { line: keyLine(tagsPair), field: 'tags' }))
        }
        seenTags.add(tag)
      }
    }
  }

  // status：可选枚举
  const statusPair = byKey.get('status')
  if (statusPair !== undefined) {
    if (!isScalar(statusPair.value) || typeof scalarOf(statusPair) !== 'string') {
      issues.push(
        issueOf('E-FM-004', { path, field: 'status', expected: `${FM_CONSTANTS.statusEnum.join('/')} 之一（字符串）`, actual: typeActual(scalarOf(statusPair)) }, { line: keyLine(statusPair), field: 'status' }),
      )
    } else if (!(FM_CONSTANTS.statusEnum as readonly string[]).includes(scalarOf(statusPair) as string)) {
      issues.push(issueOf('E-FM-005', { path, field: 'status', actual: String(scalarOf(statusPair)) }, { line: keyLine(statusPair), field: 'status' }))
    }
  }

  return issues
}
