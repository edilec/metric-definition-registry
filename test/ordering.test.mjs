/**
 * Ordering is observable, and a source grep for `.localeCompare(` is not a test
 * for it: substituting `Intl.Collator` produces identical collation drift with
 * different source text, so the grep passes while the order becomes
 * machine-dependent.
 *
 * These tests are behavioural. Each uses inputs whose order genuinely differs
 * between code-unit ordering and collation, pushes them through the real report
 * path, and asserts the exact emitted sequence. Replacing `byCodeUnit` with a
 * collator fails them.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit, checkRegistry } from '../src/index.mjs'
import { makeRoot, metric, oneRegistry, registryDoc, writeDocument } from './support.mjs'

test('findings sort by file first, by UTF-16 code unit', async () => {
  // 'Z' is 0x5A and 'm' is 0x6D, so Z.json comes first by code unit. Every
  // default collator puts the lowercase name first, which is the drift this
  // pins. The removal is located in the previous registry, the cycle in the
  // current one.
  const root = await makeRoot()
  await writeDocument(root, 'm.json', registryDoc([
    metric({ id: 'kept', name: 'kept' }),
    metric({ id: 'gone', name: 'gone' }),
  ]))
  await writeDocument(root, 'Z.json', registryDoc([metric({ id: 'kept', name: 'kept', dependsOn: ['kept'] })]))

  const report = await checkRegistry({ root, registry: 'Z.json', previous: 'm.json' })

  assert.deepEqual(report.findings.map((item) => item.location.file), ['Z.json', 'Z.json', 'm.json'])
  // Within Z.json, '/metrics/0' precedes '/metrics/0/dependsOn'.
  assert.deepEqual(report.findings.map((item) => item.ruleId), [
    'dependencies-changed-undeclared',
    'dependency-cycle',
    'metric-removed',
  ])
  assert.deepEqual(['Z.json', 'm.json'].sort(new Intl.Collator().compare), ['m.json', 'Z.json'], 'this test is only meaningful while collation disagrees')
})

test('within one file, findings sort by pointer by code unit, not numerically', async () => {
  // /metrics/10 precedes /metrics/2 by code unit. A numeric collator reverses
  // it, which is exactly the kind of "nicer" ordering that makes two machines
  // disagree about the same report.
  //
  // m0, m2 and m10 share a name. Ids are compared by code unit too, so m0
  // sorts first among them and is the definition the other two are measured
  // against; the two conflicts therefore land at /metrics/2 and /metrics/10.
  const metrics = Array.from({ length: 11 }, (unused, index) => metric({
    id: `m${index}`,
    name: [0, 2, 10].includes(index) ? 'shared' : `m${index}`,
    grain: index === 0 ? ['date'] : ['region'],
  }))
  const report = await checkRegistry(await oneRegistry(registryDoc(metrics)))

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['name-grain-conflict', 'name-grain-conflict'])
  assert.deepEqual(report.findings.map((item) => item.location.pointer), ['/metrics/10', '/metrics/2'])
})

test('two findings on the same definition sort by rule id by code unit', async () => {
  const report = await checkRegistry(await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'shared', grain: ['date'], unit: 'EUR', aggregation: 'sum' }),
    metric({ id: 'b', name: 'shared', grain: ['region'], unit: 'USD', aggregation: 'avg' }),
  ])))

  assert.deepEqual(report.findings.map((item) => item.ruleId), [
    'name-aggregation-conflict',
    'name-grain-conflict',
    'name-unit-conflict',
  ])
})

test('cycles are ordered by their first member, by code unit', async () => {
  const report = await checkRegistry(await oneRegistry(registryDoc([
    metric({ id: 'Y', name: 'Y', dependsOn: ['Z'] }),
    metric({ id: 'Z', name: 'Z', dependsOn: ['Y'] }),
    metric({ id: 'a', name: 'a', dependsOn: ['b'] }),
    metric({ id: 'b', name: 'b', dependsOn: ['a'] }),
  ])))

  assert.deepEqual(report.findings.map((item) => item.evidence), ['Y -> Z -> Y', 'a -> b -> a'])
})

test('byCodeUnit orders the pairs a collator reorders', () => {
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.equal(byCodeUnit('README', 'assets'), -1)
  assert.equal(byCodeUnit('same', 'same'), 0)
})
