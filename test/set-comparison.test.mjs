/**
 * Grain, filters and dependencies are LISTS, and a list is not the string you
 * get by joining it.
 *
 * `["date, region"]` is one dimension whose name contains a comma.
 * `["date", "region"]` is two dimensions. Joined with `, ` they are the same
 * text, and a comparison made on that text said the two definitions "agree
 * about grain, unit and aggregation" -- positively, at exit 0 -- and silenced a
 * real cross-registry grain change completely: zero findings, exit 0, where
 * grain-changed-undeclared at error severity is specified.
 *
 * That is the contract's "unknown is never a pass on BOTH sides of a
 * comparison": a positive claim derived from a lossy index.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkRegistry, exitCodeFor } from '../src/index.mjs'
import { compareEntriesAsRendered } from '../src/text.mjs'
import { metric, oneRegistry, registryDoc, runCli, twoRegistries } from './support.mjs'

const ruleIds = (report) => report.findings.map((item) => item.ruleId)

async function compare(before, after) {
  const documents = await twoRegistries(registryDoc(before), registryDoc(after))
  return checkRegistry(documents)
}

test('one dimension containing a comma is not two dimensions', () => {
  assert.equal(compareEntriesAsRendered(['date, region'], ['date', 'region'], 400, { ordered: false }), 'different')
  assert.equal(compareEntriesAsRendered(['date', 'region'], ['region', 'date'], 400, { ordered: false }), 'same')
  assert.equal(compareEntriesAsRendered(['a', 'b'], ['b', 'a'], 400, { ordered: true }), 'different')
  assert.equal(compareEntriesAsRendered(['date'], ['date '], 400, { ordered: false }), 'stripped-only')
  assert.equal(compareEntriesAsRendered([], [], 400, { ordered: false }), 'same')
})

test('two definitions at genuinely different grains never "agree about grain"', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue', grain: ['date, region'] }),
    metric({ id: 'b', name: 'revenue', grain: ['date', 'region'] }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(ruleIds(report), ['name-grain-conflict'])
  assert.equal(report.findings[0].severity, 'error')
  // Quoted per entry, so the two sides of the evidence are distinguishable.
  assert.equal(report.findings[0].evidence, '"date, region" | "date", "region"')
  assert.ok(!ruleIds(report).includes('name-reused'))
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('a grain change that only regroups the dimensions is still a grain change', async () => {
  const report = await compare(
    [metric({ id: 'rev', name: 'revenue', grain: ['date', 'region'] })],
    [metric({ id: 'rev', name: 'revenue', grain: ['date, region'] })],
  )

  assert.deepEqual(ruleIds(report), ['grain-changed-undeclared'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.findings[0].evidence, '"date", "region" | "date, region"')
  assert.equal(report.summary.metricsChanged, 1)
  assert.equal(exitCodeFor(report), 1)
})

test('a dependency set that only regroups its entries is still a change', async () => {
  const before = [
    metric({ id: 'rev', name: 'revenue', dependsOn: ['a', 'b'] }),
    metric({ id: 'a', name: 'alpha' }),
    metric({ id: 'b', name: 'beta' }),
    metric({ id: 'a, b', name: 'alphabeta' }),
  ]
  const after = [
    metric({ id: 'rev', name: 'revenue', dependsOn: ['a, b'] }),
    metric({ id: 'a', name: 'alpha' }),
    metric({ id: 'b', name: 'beta' }),
    metric({ id: 'a, b', name: 'alphabeta' }),
  ]
  const report = await compare(before, after)

  assert.deepEqual(ruleIds(report), ['dependencies-changed-undeclared'])
  assert.equal(report.findings[0].evidence, '"a", "b" | "a, b"')
  assert.equal(exitCodeFor(report), 1)
})

test('reordering a grain or a dependency list is not a change', async () => {
  const report = await compare(
    [metric({ id: 'rev', name: 'revenue', grain: ['date', 'region'], dependsOn: [] })],
    [metric({ id: 'rev', name: 'revenue', grain: ['region', 'date'], dependsOn: [] })],
  )

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.metricsChanged, 0)
  assert.equal(exitCodeFor(report), 0)
})

test('a grain set reordered across an invisible spelling difference is not a changed grain', async () => {
  const before = [' x', 'a']
  const after = ['a', 'x']
  assert.equal(compareEntriesAsRendered(before, after, 400, { ordered: false }), 'stripped-only')

  const documents = await twoRegistries(
    registryDoc([metric({ id: 'rev', name: 'revenue', grain: before })]),
    registryDoc([metric({ id: 'rev', name: 'revenue', grain: after })]),
  )
  const report = await checkRegistry(documents)
  assert.deepEqual(ruleIds(report), ['changed-invisibly'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.findings[0].evidence, 'grain: entry 2, at character 1: before U+0020, after U+0078')
  assert.equal(report.summary.metricsChanged, 0)
  assert.equal(exitCodeFor(report), 0)

  const cli = await runCli(['--root', documents.root, '--registry', documents.registry, '--previous', documents.previous, '--json'])
  assert.equal(cli.code, 0)
  assert.deepEqual(JSON.parse(cli.stdout).findings.map((item) => item.ruleId), ['changed-invisibly'])
})

test('a shared-name grain conflict explains a difference hidden by the short excerpt', async () => {
  const left = `${'x'.repeat(61)}A`
  const right = `${'x'.repeat(61)}B`
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'shared', grain: [left] }),
    metric({ id: 'b', name: 'shared', grain: [right] }),
  ]))
  const report = await checkRegistry(documents)
  const item = report.findings.find((entry) => entry.ruleId === 'name-grain-conflict')
  assert.equal(item?.severity, 'error')
  assert.match(item.message, /character 62: before U\+0041, after U\+0042/)
  assert.match(item.evidence, /character 62: before U\+0041, after U\+0042/)
  assert.doesNotMatch(item.message, /at grain \(([^)]*)\) and .* at grain \(\1\)/)
  assert.equal(exitCodeFor(report), 1)
})

test('a cross-registry grain change explains a difference hidden by the short excerpt', async () => {
  const left = `${'x'.repeat(61)}A`
  const right = `${'x'.repeat(61)}B`
  const report = await compare(
    [metric({ id: 'rev', grain: [left] })],
    [metric({ id: 'rev', grain: [right] })],
  )
  const item = report.findings.find((entry) => entry.ruleId === 'grain-changed-undeclared')
  assert.equal(item?.severity, 'error')
  assert.match(item.message, /character 62: before U\+0041, after U\+0042/)
  assert.match(item.evidence, /character 62: before U\+0041, after U\+0042/)
  assert.equal(exitCodeFor(report), 1)
})

test('a shared name does not acquire a grain conflict from raw entry sort order', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue', grain: [' x', 'a'] }),
    metric({ id: 'b', name: 'revenue', grain: ['a', 'x'] }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(ruleIds(report), ['name-differs-invisibly'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.findings[0].evidence, 'grain: entry 2, at character 1: before U+0020, after U+0078')
  assert.equal(exitCodeFor(report), 0)
})

test('changed-grain evidence orders the dimensions as the reader sees them', async () => {
  const report = await compare(
    [metric({ id: 'rev', name: 'revenue', grain: [' x', 'a'] })],
    [metric({ id: 'rev', name: 'revenue', grain: ['a', 'y'] })],
  )

  assert.deepEqual(ruleIds(report), ['grain-changed-undeclared'])
  assert.equal(report.findings[0].evidence, '"a", "x" | "a", "y"')
  assert.equal(exitCodeFor(report), 1)
})

test('reordering filters is still reported as a reordering, not as a rewrite', async () => {
  const report = await compare(
    [metric({ id: 'rev', name: 'revenue', filters: ['a = 1', 'b = 2'] })],
    [metric({ id: 'rev', name: 'revenue', filters: ['b = 2', 'a = 1'] })],
  )

  assert.deepEqual(ruleIds(report), ['filters-changed-undeclared'])
  assert.match(report.findings[0].message, /lists the same filters in a different order/)
  assert.equal(exitCodeFor(report), 1)
})

test('a filter list regrouped into one expression is a rewrite, not a reordering', async () => {
  // `["a AND b"]` and `["a", "b"]` joined with ` AND ` are one string. The
  // reordering branch is the one that must not claim them equal.
  const report = await compare(
    [metric({ id: 'rev', name: 'revenue', filters: ['a', 'b'] })],
    [metric({ id: 'rev', name: 'revenue', filters: ['a AND b'] })],
  )

  assert.deepEqual(ruleIds(report), ['filters-changed-undeclared'])
  assert.ok(!/different order/.test(report.findings[0].message))
  assert.equal(report.findings[0].evidence, '"a" AND "b" | "a AND b"')
  assert.equal(exitCodeFor(report), 1)
})

test('a grain entry differing only in removed characters is not a grain change', async () => {
  const report = await compare(
    [metric({ id: 'rev', name: 'revenue', grain: ['date', 'region'] })],
    [metric({ id: 'rev', name: 'revenue', grain: ['date ', 'region'] })],
  )

  assert.deepEqual(ruleIds(report), ['changed-invisibly'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.findings[0].evidence, 'grain: entry 1, at character 5: before the end of the value, after U+0020')
  assert.equal(report.summary.metricsChanged, 0)
  assert.equal(exitCodeFor(report), 0)
})

test('two grain entries this report renders identically are a duplicate dimension', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'rev', name: 'revenue', grain: ['date', 'date '] }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(ruleIds(report), ['metric-invalid'])
  assert.equal(report.findings[0].location.pointer, '/metrics/0/grain')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a grain with genuinely distinct dimensions is accepted', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'rev', name: 'revenue', grain: ['date', 'region', 'date, region'] }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings, [])
  assert.equal(exitCodeFor(report), 0)
})
