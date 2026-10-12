import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as publish from '../src/publish/index.ts';
import { PUBLISH_STAGES } from '../src/publish/index.ts';

// S3-T7 结构性禁跳步（implementation-breakdown §2.2 S3-T7 行完成标准：「发布
// 组件跳过任一步骤的结构性禁止（代码断言）」）。与 pipeline.ts 运行器内置的
// 前序断言互补，此处做可在 CI 复跑的结构性断言：
// 1) 公共面只有 publishWebSubmit + PUBLISH_STAGES——不存在「只更新引用」
//    「只构造候选」的旁路入口（S4 无从跳步调用）；
// 2) `update-ref` 在发布组件源码中恰出现一次且仅在 pipeline.ts（引用更新
//    唯一落点=有序链终点）；
// 3) 链的判定件来自唯一来源：refCommandRejection（githttp/ref-rules.ts）与
//    createValidator（notegit-validation）——不得在 publish/ 内复刻规则；
// 4) PUBLISH_STAGES 无重复、首步为候选构造、末步为终态核对（链完整性）。

const SRC = path.resolve(import.meta.dirname, '../src/publish');

async function tsFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(SRC, { withFileTypes: true })) {
    if (e.name.endsWith('.ts')) out.push(path.join(SRC, e.name));
  }
  return out.sort();
}

/** 去注释（粗粒度；与 gitrepo-static-rules.test.ts 同法——规则只针对可执行代码） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('结构性：发布组件公共面=publishWebSubmit+PUBLISH_STAGES（无旁路入口）', async () => {
  assert.deepEqual(
    Object.keys(publish).sort(),
    ['PUBLISH_STAGES', 'publishWebSubmit'],
    '导出面只有单一发布入口与链声明——S4 无法导入「只更新引用/只构造候选」的组件（结构性禁跳步）',
  );
  assert.equal(typeof publish.publishWebSubmit, 'function');
  assert.ok(Array.isArray(PUBLISH_STAGES));
});

test('结构性：update-ref 在 publish/ 源码中恰一次且仅在 pipeline.ts（引用更新唯一落点）', async () => {
  // 匹配 plumbing 调用形态 ['update-ref', …]（PUBLISH_STAGES 的同名阶段字面量
  // 是链声明、不是引用更新调用——不计入）
  const hits: { file: string; count: number }[] = [];
  for (const file of await tsFiles()) {
    const code = stripComments(await readFile(file, 'utf8'));
    const count = (code.match(/\['update-ref'/g) ?? []).length;
    if (count > 0) hits.push({ file: path.relative(SRC, file), count });
  }
  assert.deepEqual(
    hits,
    [{ file: 'pipeline.ts', count: 1 }],
    "update-ref 调用（['update-ref', …] 形态）只出现在管线 update-ref 步骤一处——不存在绕过链的第二个引用更新点",
  );
});

test('结构性：链判定件来自唯一来源（ref-rules / limits engine→notegit-validation），publish/ 不复刻规则', async () => {
  const pipeline = stripComments(await readFile(path.join(SRC, 'pipeline.ts'), 'utf8'));
  assert.match(pipeline, /from '\.\.\/githttp\/ref-rules\.ts'/, '分支/ref 规则复用唯一判定源（S3-T5）');
  assert.match(pipeline, /refCommandRejection/, '逐 ref 判定调用唯一判定源函数');
  assert.match(pipeline, /from 'notegit-validation'/, '内容校验报告/类型复用共享校验器（sprint D7）');
  // S3-T8 起校验入口经 limits/engine（配置覆盖链 + 共享并发闸门）包装
  // createValidator——仍是单一入口（publish/ 不直接触碰校验器，也不复刻规则）
  assert.match(pipeline, /from '\.\.\/limits\/engine\.ts'/, '校验经 server 配置引擎单一入口（S3-T8 覆盖链）');
  assert.match(pipeline, /runServerValidation/, '校验调用 runServerValidation（pre-receive 与发布组件同源入口）');
  assert.ok(!/\bcreateValidator\b/.test(pipeline), 'publish/ 不直接构造校验器（经 engine 统一装配配置与闸门）');
  // 审计 settle 消费 T6 导出面（同构锚点）
  assert.match(pipeline, /settlePushRejected|settlePushByRefState/, '终态核对消费 T6 审计链导出面');

  // publish/ 内不得出现规则复刻形态：错误码表、路径规则、frontmatter 判定
  for (const file of await tsFiles()) {
    const code = stripComments(await readFile(file, 'utf8'));
    assert.ok(!/E-PATH-00\d|E-FM-00\d|E-LIMIT-00\d/.test(code), `${path.basename(file)} 不得内置错误码判定（规则唯一来源在校验器——D7）`);
  }
});

test('结构性：PUBLISH_STAGES 有序链完整（无重复、candidate 先行、settle 收尾）', () => {
  assert.equal(new Set(PUBLISH_STAGES).size, PUBLISH_STAGES.length, '无重复步骤');
  assert.equal(PUBLISH_STAGES[0], 'candidate', '首步=候选构造（后续步骤的输入）');
  assert.equal(PUBLISH_STAGES.at(-1), 'settle', '末步=终态核对（不虚报成功）');
  for (const must of ['audit', 'authorization', 'branch-rules', 'validation', 'base-commit', 'execution-point', 'update-ref']) {
    assert.ok((PUBLISH_STAGES as readonly string[]).includes(must), `链含 ${must}`);
  }
  // update-ref 不得先于任一检查步骤（顺序结构）
  const idxOf = (s: string) => (PUBLISH_STAGES as readonly string[]).indexOf(s);
  for (const check of ['authorization', 'branch-rules', 'validation', 'base-commit', 'execution-point']) {
    assert.ok(idxOf(check) < idxOf('update-ref'), `${check} 先于 update-ref（检查先行，写入殿后）`);
  }
});
