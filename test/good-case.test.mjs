/**
 * The first verification of a checker is not "does it catch the bad case". It
 * is "does it stay silent on the good one". A finding raised on correct input
 * sends somebody to fix what was already right, and after that nobody reads
 * the output.
 *
 * Every test here constructs a registry a data team would call correct and
 * asserts the tool says nothing about it -- and asserts the analysis really
 * ran, so silence cannot come from a run that evaluated nothing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkRegistry } from '../src/index.mjs'
import { metric, oneRegistry, registryDoc, runCli, twoRegistries } from './support.mjs'

test('a well-formed registry with resolvable dependencies produces no findings at all', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'orders_daily', name: 'orders' }),
    metric({ id: 'revenue_daily', name: 'revenue', unit: 'EUR', dependsOn: ['orders_daily'] }),
  ]))
  const report = await checkRegistry(documents)

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  // Silence has to come from an analysis that happened.
  assert.equal(report.summary.registryRead, true)
  assert.equal(report.summary.dependencyGraphComplete, true)
  assert.equal(report.summary.cyclicGroupsFound, 0)
  assert.equal(report.summary.metrics, 2)
})

test('the CLI exits 0 and writes a parseable pass report for a clean registry', async () => {
  const documents = await oneRegistry(registryDoc())
  const run = await runCli(['--root', documents.root, '--registry', documents.registry])

  assert.equal(run.code, 0)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.findings.length, 0)
})

test('a diamond dependency is not a cycle', async () => {
  // a -> b, a -> c, b -> d, c -> d. Two paths reach d, and a walk that marks
  // "visited" rather than "on the current path" calls that a cycle.
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'a', dependsOn: ['b', 'c'] }),
    metric({ id: 'b', name: 'b', dependsOn: ['d'] }),
    metric({ id: 'c', name: 'c', dependsOn: ['d'] }),
    metric({ id: 'd', name: 'd', dependsOn: [] }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.cyclicGroupsFound, 0)
  assert.equal(report.status, 'pass')
})

test('the same grain written in another order is the same grain', async () => {
  // Dimension order carries no meaning, so this must not be a conflict.
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue', grain: ['date', 'region'] }),
    metric({ id: 'b', name: 'revenue', grain: ['region', 'date'] }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['name-reused'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.namesSharedBySeveralMetrics, 1)
})

test('two definitions with different names say nothing about each other', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue daily', grain: ['date'], unit: 'EUR' }),
    metric({ id: 'b', name: 'revenue regional', grain: ['date', 'region'], unit: 'USD', aggregation: 'avg' }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.namesSharedBySeveralMetrics, 0)
})

test('an empty grain is a declared grain, not a missing one', async () => {
  const documents = await oneRegistry(registryDoc([metric({ grain: [] })]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('an unchanged registry compared with itself reports nothing but the comparison', async () => {
  const document = registryDoc([metric(), metric({ id: 'second', name: 'second' })])
  const documents = await twoRegistries(document, document)
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.comparedWithPrevious, true)
  assert.equal(report.summary.metricsChanged, 0)
})

test('every optional field present is still a pass', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ description: 'orders counted once they are placed', filters: ["status = 'placed'"] }),
  ]))
  const report = await checkRegistry(documents)

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
})

test('every aggregation in the declared vocabulary is accepted', async () => {
  const { SUPPORTED_AGGREGATIONS } = await import('../src/index.mjs')
  const documents = await oneRegistry(registryDoc(
    SUPPORTED_AGGREGATIONS.map((aggregation, index) => metric({
      id: `m${index}`,
      name: `m${index}`,
      aggregation,
    })),
  ))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})
