/**
 * 内嵌 JSON Schema 子集校验器（测试用，零依赖——沿用 S2-T1「零测试依赖」纪律）。
 * 覆盖 validation-report.schema.json 用到的构造：type（含数组/null）、required、properties、
 * enum、const、pattern、minLength、minimum、items、allOf、if/then、本地 $ref（#/$defs/…）。
 */

export interface SchemaCheckError {
  path: string
  message: string
}

export function schemaCheck(rootSchema: unknown, data: unknown): SchemaCheckError[] {
  const errors: SchemaCheckError[] = []
  check(rootSchema, data, '$', errors, rootSchema, new Set())
  return errors
}

function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error(`仅支持本地 $ref：${ref}`)
  let node: unknown = root
  for (const seg of ref.slice(2).split('/')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[seg.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return node
}

function check(
  schema: unknown,
  data: unknown,
  path: string,
  errors: SchemaCheckError[],
  root: unknown,
  seen: Set<unknown>,
): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return
  const s = schema as Record<string, unknown>

  if (typeof s.$ref === 'string') {
    if (seen.has(schema)) return
    seen.add(schema)
    check(resolveRef(root, s.$ref), data, path, errors, root, seen)
    return
  }

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]
    const jsType = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data
    if (!types.some((t) => (t === 'integer' ? jsType === 'number' && Number.isInteger(data) : t === jsType))) {
      errors.push({ path, message: `类型应为 ${types.join('|')}，实际 ${jsType}` })
      return
    }
  }

  if (s.const !== undefined && data !== s.const) errors.push({ path, message: `应为常量 ${JSON.stringify(s.const)}，实际 ${JSON.stringify(data)}` })
  if (Array.isArray(s.enum) && !(s.enum as unknown[]).some((v) => v === data)) {
    errors.push({ path, message: `不在枚举 ${JSON.stringify(s.enum)} 内：${JSON.stringify(data)}` })
  }
  if (typeof s.pattern === 'string' && typeof data === 'string' && !new RegExp(s.pattern, 'u').test(data)) {
    errors.push({ path, message: `不匹配模式 ${s.pattern}：${JSON.stringify(data)}` })
  }
  if (typeof s.minLength === 'number' && typeof data === 'string' && data.length < s.minLength) {
    errors.push({ path, message: `字符串短于 minLength ${s.minLength}` })
  }
  if (typeof s.minimum === 'number' && typeof data === 'number' && data < s.minimum) {
    errors.push({ path, message: `数值小于 minimum ${s.minimum}` })
  }

  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf as unknown[]) check(sub, data, path, errors, root, seen)
  }
  if (s.if !== undefined) {
    const ifErrors: SchemaCheckError[] = []
    check(s.if, data, path, ifErrors, root, seen)
    if (ifErrors.length === 0 && s.then !== undefined) check(s.then, data, path, errors, root, seen)
  }

  if (s.properties !== undefined && data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const props = s.properties as Record<string, unknown>
    for (const [key, sub] of Object.entries(props)) {
      if ((data as Record<string, unknown>)[key] !== undefined) check(sub, (data as Record<string, unknown>)[key], `${path}.${key}`, errors, root, seen)
    }
  }
  if (Array.isArray(s.required) && data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of s.required as string[]) {
      if ((data as Record<string, unknown>)[key] === undefined) errors.push({ path, message: `缺少必填字段 ${key}` })
    }
  }
  if (s.items !== undefined && Array.isArray(data)) {
    ;(data as unknown[]).forEach((item, i) => check(s.items, item, `${path}[${i}]`, errors, root, seen))
  }
}
