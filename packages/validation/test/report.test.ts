import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exitCodeFor } from '../src/report.ts'

test('退出码语义：pass→0、fail→1、error→2（schema if/then 同款映射）', () => {
  assert.equal(exitCodeFor('pass'), 0)
  assert.equal(exitCodeFor('fail'), 1)
  assert.equal(exitCodeFor('error'), 2)
  assert.throws(() => exitCodeFor('other' as never))
})
