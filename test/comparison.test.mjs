/**
 * Comparing a registry with the one before it -- and, just as important, what
 * the report says when there is no "before" to compare with.
 *
 * Absent history is unknown. A run with no `--previous` must never read as
 * "nothing changed", because a consumer that treats the two as the same thing
 * will ship a redefinition believing it was reviewed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkRegistry, exitCodeFor } from '../src/index.mjs'
import { makeRoot, metric, oneRegistry, registryDoc, runCli, twoRegistries, writeDocument } from './support.mjs'

async function compare(before, after) {
  const documents = await twoRegistries(registryDoc(before), registryDoc(after))
  return checkRegistry(documents)
}

test('without a previous registry, nothing is claimed about what changed', async () => {
  const documents = await oneRegistry(registryDoc([metric()]))
  const report = await checkRegistry(documents)

  assert.equal(report.summary.comparedWithPrevious, false)
  assert.equal(report.summary.metricsChanged, 0)
  assert.equal(report.status, 'pass')
  // Validating one registry is a legitimate use, so there is no finding here.
  // The claim is withheld in the summary and in the human summary instead.
  assert.deepEqual(report.findings, [])

  const run = await runCli(['--root', documents.root, '--registry', documents.registry])
  assert.equal(report.summary.previousRegistryNamed, false)
  assert.match(run.stderr, /no previous registry was given, so nothing here is a statement about what changed/)
  assert.ok(!/removed/.test(run.stderr))
})

test('a previous registry that was named and could not be read is not "not given"', async () => {
  // The sentence "no previous registry was given" was printed two lines above
  // "ERROR input-unreadable gone.json": a false statement about the invocation,
  // made beside the finding that contradicts it. The JSON report was right
  // throughout; only the human summary lied.
  const documents = await oneRegistry(registryDoc([metric()]))
  const report = await checkRegistry({ ...documents, previous: 'gone.json' })

  assert.equal(report.summary.comparedWithPrevious, false)
  assert.equal(report.summary.previousRegistryNamed, true)
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['input-unreadable'])
  assert.equal(exitCodeFor(report), 2)

  const run = await runCli(['--root', documents.root, '--registry', documents.registry, '--previous', 'gone.json'])
  assert.equal(run.code, 2)
  assert.match(run.stderr, /a previous registry was named and was not read/)
  assert.ok(!/no previous registry was given/.test(run.stderr))
})

test('a previous registry that exists but does not validate is also not "not given"', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc([metric()]))
  await writeDocument(root, 'previous.json', { registryVersion: '1', metrics: [metric()], extra: 1 })
  const report = await checkRegistry({ root, registry: 'metrics.json', previous: 'previous.json' })

  assert.equal(report.summary.comparedWithPrevious, false)
  assert.equal(report.summary.previousRegistryNamed, true)
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['registry-unknown-field'])

  const run = await runCli(['--root', root, '--registry', 'metrics.json', '--previous', 'previous.json'])
  assert.equal(run.code, 2)
  assert.match(run.stderr, /a previous registry was named and was not read/)
  assert.ok(!/no previous registry was given/.test(run.stderr))
})

test('a semantic change without a version bump fails', async () => {
  const report = await compare(
    [metric({ id: 'revenue', name: 'revenue', formula: 'sum(a)', definitionVersion: '2' })],
    [metric({ id: 'revenue', name: 'revenue', formula: 'sum(a) - sum(b)', definitionVersion: '2' })],
  )
  const [item] = report.findings

  assert.equal(item.ruleId, 'formula-changed-undeclared')
  assert.equal(item.severity, 'error')
  assert.match(item.message, /stayed at 2, so the same version now means two different things/)
  assert.equal(item.suggestion, 'move definitionVersion when the definition moves, so a cached number can be matched to the definition that produced it')
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.equal(report.summary.metricsChanged, 1)
})

test('the same change with a version bump is declared, and passes', async () => {
  const report = await compare(
    [metric({ id: 'revenue', name: 'revenue', formula: 'sum(a)', definitionVersion: '2' })],
    [metric({ id: 'revenue', name: 'revenue', formula: 'sum(a) - sum(b)', definitionVersion: '3' })],
  )

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['formula-changed-declared'])
  assert.equal(report.findings[0].severity, 'info')
  assert.match(report.findings[0].message, /moved from 2 to 3/)
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
})

test('every semantic field is compared, and each names itself', async () => {
  const cases = [
    ['name', { name: 'revenue, net' }, 'name-changed-undeclared'],
    ['grain', { grain: ['date', 'region'] }, 'grain-changed-undeclared'],
    ['aggregation', { aggregation: 'avg' }, 'aggregation-changed-undeclared'],
    ['unit', { unit: 'USD' }, 'unit-changed-undeclared'],
    ['formula', { formula: 'sum(other)' }, 'formula-changed-undeclared'],
    ['filters', { filters: ["region = 'eu'"] }, 'filters-changed-undeclared'],
    ['dependencies', { dependsOn: ['upstream'] }, 'dependencies-changed-undeclared'],
  ]
  for (const [field, change, expected] of cases) {
    const report = await compare(
      [metric({ id: 'm', name: 'revenue', unit: 'EUR' }), metric({ id: 'upstream', name: 'upstream' })],
      [metric({ id: 'm', name: 'revenue', unit: 'EUR', ...change }), metric({ id: 'upstream', name: 'upstream' })],
    )
    const ids = report.findings.map((item) => item.ruleId)
    assert.ok(ids.includes(expected), `${field}: expected ${expected}, got ${ids.join(', ')}`)
    assert.equal(report.status, 'fail', field)
  }
})

test('grain and dependency order are not changes; filter order is reported as an order change', async () => {
  const reordered = await compare(
    [metric({ id: 'm', name: 'm', grain: ['date', 'region'], dependsOn: ['a', 'b'] }), metric({ id: 'a', name: 'a' }), metric({ id: 'b', name: 'b' })],
    [metric({ id: 'm', name: 'm', grain: ['region', 'date'], dependsOn: ['b', 'a'] }), metric({ id: 'a', name: 'a' }), metric({ id: 'b', name: 'b' })],
  )
  assert.deepEqual(reordered.findings, [], 'dimension and dependency order carry no meaning')

  const filters = await compare(
    [metric({ id: 'm', name: 'm', filters: ['x', 'y'] })],
    [metric({ id: 'm', name: 'm', filters: ['y', 'x'] })],
  )
  assert.deepEqual(filters.findings.map((item) => item.ruleId), ['filters-changed-undeclared'])
  // The message says what it is, and admits what the tool cannot know.
  assert.match(filters.findings[0].message, /lists the same filters in a different order/)
  assert.match(filters.findings[0].message, /does not parse a filter expression/)
})

test('an owner change is recorded and does not fail the build', async () => {
  const report = await compare(
    [metric({ id: 'm', name: 'm', owner: 'analytics-platform' })],
    [metric({ id: 'm', name: 'm', owner: 'finance-analytics' })],
  )

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['owner-changed'])
  assert.equal(report.findings[0].severity, 'info')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.metricsChanged, 0, 'an owner is not part of what the number means')
})

test('a removed metric fails and is located in the registry that still had it', async () => {
  const report = await compare(
    [metric({ id: 'kept', name: 'kept' }), metric({ id: 'gone', name: 'gone' })],
    [metric({ id: 'kept', name: 'kept' })],
  )
  const [item] = report.findings

  assert.equal(item.ruleId, 'metric-removed')
  assert.equal(item.severity, 'error')
  assert.equal(item.location.file, 'previous.json')
  assert.equal(item.location.pointer, '/metrics/1')
  assert.equal(report.summary.metricsRemoved, 1)
  assert.equal(report.status, 'fail')
})

test('an added metric is recorded and does not fail the build', async () => {
  const report = await compare(
    [metric({ id: 'kept', name: 'kept' })],
    [metric({ id: 'kept', name: 'kept' }), metric({ id: 'fresh', name: 'fresh' })],
  )

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['metric-added'])
  assert.equal(report.summary.metricsAdded, 1)
  assert.equal(report.status, 'pass')
})

test('a version bump with nothing else changed is not reported', async () => {
  // Nagging about it would be a finding on correct input: re-versioning a
  // definition ahead of a change is ordinary work.
  const report = await compare(
    [metric({ id: 'm', name: 'm', definitionVersion: '1' })],
    [metric({ id: 'm', name: 'm', definitionVersion: '2' })],
  )
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.metricsChanged, 0)
})
