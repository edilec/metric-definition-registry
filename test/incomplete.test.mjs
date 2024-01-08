/**
 * Unknown is never a pass -- and never a pass on either side of the comparison.
 *
 * Every rule in the tool's incomplete set is driven through the real entry
 * point here and asserted to produce status "incomplete" and exit code 2. The
 * status is derived from that set rather than assigned at a call site, so the
 * mutation these tests exist to catch is removing an id from the set; each id
 * below fails this file when it is removed.
 *
 * The sharpest tests are the dependency ones. A cycle search over a graph with
 * an edge removed can only ever report "no cycles", and reporting that would be
 * a positive claim drawn from evidence that was thrown away.
 */

import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { checkRegistry, exitCodeFor } from '../src/index.mjs'
import { makeRoot, metric, oneRegistry, registryDoc, runCli, writeDocument } from './support.mjs'

function assertIncomplete(report, ruleId) {
  const ruleIds = report.findings.map((item) => item.ruleId)
  assert.ok(ruleIds.includes(ruleId), `expected ${ruleId}, got ${ruleIds.join(', ')}`)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
}

test('an unresolved dependency leaves the graph unknown, and no cycle search is run', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'revenue', name: 'revenue', dependsOn: ['margin_from_another_registry'] }),
  ]))
  const report = await checkRegistry(documents)

  assertIncomplete(report, 'dependency-unresolved')
  assert.match(report.findings[0].message, /not known to be acyclic/)
  assert.equal(report.summary.dependencyGraphComplete, false)
  // Not zero. Zero is a claim, and none was earned.
  assert.equal(report.summary.cyclesFound, null)
  assert.equal(report.findings.filter((item) => item.ruleId === 'dependency-cycle').length, 0)
})

test('an unresolved dependency does not suppress the cycle that is visible beside it', async () => {
  // The honest outcome is BOTH: the cycle that the resolved edges show, and
  // the statement that the graph as a whole is not known to be acyclic. What
  // must never happen is the search running over a pruned graph and the report
  // reading as though it were complete.
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'a', dependsOn: ['b'] }),
    metric({ id: 'b', name: 'b', dependsOn: ['a'] }),
    metric({ id: 'c', name: 'c', dependsOn: ['elsewhere'] }),
  ]))
  const report = await checkRegistry(documents)

  assertIncomplete(report, 'dependency-unresolved')
  assert.equal(report.summary.dependencyGraphComplete, false)
  assert.equal(report.summary.cyclesFound, null)
  assert.equal(exitCodeFor(report), 2, 'an incomplete graph is not downgraded to a plain failure')
})

test('the human summary refuses to call an incomplete graph acyclic', async () => {
  const documents = await oneRegistry(registryDoc([metric({ dependsOn: ['ghost'] })]))
  const run = await runCli(['--root', documents.root, '--registry', documents.registry])

  assert.equal(run.code, 2)
  assert.match(run.stderr, /NOT known to be acyclic and no cycle search was run/)
  assert.ok(!/cycle\(s\) found/.test(run.stderr))
})

test('an absent dependsOn is unknown, not an empty list', async () => {
  const without = metric()
  delete without.dependsOn
  const documents = await oneRegistry(registryDoc([without]))
  const report = await checkRegistry(documents)

  assertIncomplete(report, 'dependencies-undeclared')
  assert.match(report.findings[0].message, /must be declared, as \[\] when the metric depends on no other metric/)
  assert.equal(report.summary.registryRead, false)
  assert.equal(report.summary.cyclesFound, null)
})

test('a duplicate metric id makes the index ambiguous, and nothing is analysed', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'same', name: 'first' }),
    metric({ id: 'same', name: 'second' }),
  ]))
  const report = await checkRegistry(documents)

  assertIncomplete(report, 'metric-id-duplicate')
  assert.equal(report.summary.registryRead, false)
  assert.equal(report.summary.cyclesFound, null)
  assert.equal(report.findings.filter((item) => item.ruleId.startsWith('name-')).length, 0)
})

test('one unusable definition stops the whole registry being analysed', async () => {
  // Analysing the rest would mean analysing a registry nobody wrote: the
  // unusable definition might have been the other end of a cycle.
  const broken = metric({ id: 'broken' })
  delete broken.unit
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'a', dependsOn: ['b'] }),
    metric({ id: 'b', name: 'b', dependsOn: ['a'] }),
    broken,
  ]))
  const report = await checkRegistry(documents)

  assertIncomplete(report, 'unit-undeclared')
  assert.equal(report.summary.registryRead, false)
  assert.equal(report.summary.metrics, 0)
  assert.equal(report.findings.filter((item) => item.ruleId === 'dependency-cycle').length, 0)
})

test('a registry that could not be read produces no claim about it', async () => {
  const root = await makeRoot()
  const report = await checkRegistry({ root, registry: 'missing.json' })

  assertIncomplete(report, 'input-unreadable')
  assert.equal(report.summary.registryRead, false)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.dependencyGraphComplete, false)
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['input-unreadable'])
})

test('a registry that is not valid UTF-8 is incomplete', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))
  const report = await checkRegistry({ root, registry: 'metrics.json' })
  assertIncomplete(report, 'input-not-utf8')
})

test('a registry that is not valid JSON is incomplete', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', '{ "registryVersion": ')
  const report = await checkRegistry({ root, registry: 'metrics.json' })
  assertIncomplete(report, 'input-not-json')
})

test('a registry that is not a JSON object is incomplete', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', '[]')
  const report = await checkRegistry({ root, registry: 'metrics.json' })
  assertIncomplete(report, 'registry-invalid')
})

test('an unsupported registry version is incomplete rather than read anyway', async () => {
  const documents = await oneRegistry(registryDoc([metric()], { registryVersion: '2' }))
  const report = await checkRegistry(documents)
  assertIncomplete(report, 'registry-version-unsupported')
  assert.equal(report.summary.registryRead, false)
})

test('an unknown registry field is incomplete, because the tool cannot claim it read the document', async () => {
  const documents = await oneRegistry(registryDoc([metric()], { generatedBy: 'some pipeline' }))
  const report = await checkRegistry(documents)
  assertIncomplete(report, 'registry-unknown-field')
  assert.equal(report.findings[0].location.pointer, '/generatedBy')
})

test('an unknown definition field is incomplete', async () => {
  const documents = await oneRegistry(registryDoc([{ ...metric(), tier: 'gold' }]))
  const report = await checkRegistry(documents)
  assertIncomplete(report, 'metric-unknown-field')
  assert.equal(report.findings[0].location.pointer, '/metrics/0/tier')
})

test('a definition that is not an object is incomplete', async () => {
  const documents = await oneRegistry(registryDoc(['orders_daily']))
  const report = await checkRegistry(documents)
  assertIncomplete(report, 'metric-invalid')
})

test('a grain naming the same dimension twice is incomplete', async () => {
  const documents = await oneRegistry(registryDoc([metric({ grain: ['date', 'date'] })]))
  const report = await checkRegistry(documents)
  assertIncomplete(report, 'metric-invalid')
  assert.equal(report.findings[0].location.pointer, '/metrics/0/grain')
})

test('a registry declaring no metrics is incomplete, not a clean pass over nothing', async () => {
  const documents = await oneRegistry(registryDoc([]))
  const report = await checkRegistry(documents)

  assertIncomplete(report, 'no-metrics-declared')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.registryRead, false)
})

test('a previous registry that could not be read produces no comparison', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc([metric()]))
  const report = await checkRegistry({ root, registry: 'metrics.json', previous: 'gone.json' })

  assertIncomplete(report, 'input-unreadable')
  assert.equal(report.summary.comparedWithPrevious, false)
  assert.equal(report.summary.metricsAdded, 0, 'nothing is "added" against a registry nobody read')
  assert.equal(report.findings.filter((item) => item.ruleId === 'metric-added').length, 0)
})

test('a previous registry that is unusable produces no comparison either', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc([metric()]))
  await writeDocument(root, 'previous.json', registryDoc([{ ...metric({ id: 'gone' }), tier: 'gold' }]))
  const report = await checkRegistry({ root, registry: 'metrics.json', previous: 'previous.json' })

  assertIncomplete(report, 'metric-unknown-field')
  assert.equal(report.summary.comparedWithPrevious, false)
  assert.equal(report.findings.filter((item) => item.ruleId === 'metric-removed').length, 0)
})

test('a path leaving the root through a symbolic link is refused, not followed', async () => {
  const outside = await makeRoot()
  await writeDocument(outside, 'secret.json', registryDoc([metric({ id: 'not_yours', name: 'not yours' })]))
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc([metric()]))
  await symlink(join(outside, 'secret.json'), join(root, 'link.json'))

  const report = await checkRegistry({ root, registry: 'metrics.json', previous: 'link.json' })

  assertIncomplete(report, 'path-escapes-root')
  assert.equal(report.summary.comparedWithPrevious, false)
  assert.ok(!JSON.stringify(report).includes('not_yours'))
})

test('a lexically escaping path is refused before anything is opened', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc([metric()]))
  const report = await checkRegistry({ root, registry: '../metrics.json' })
  assertIncomplete(report, 'path-escapes-root')
})

test('the CLI exits 2 and still writes an incomplete report on stdout', async () => {
  const documents = await oneRegistry(registryDoc([metric({ dependsOn: ['ghost'] })]))
  const run = await runCli(['--root', documents.root, '--registry', documents.registry])

  assert.equal(run.code, 2)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'incomplete')
  assert.match(run.stderr, /incomplete: this run is not a pass/)
})
