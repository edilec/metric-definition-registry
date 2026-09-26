/**
 * The acceptance criterion for this tool, item by item:
 *
 *   "Two definitions sharing a name but different grain are flagged;
 *    dependency cycles fail; units and aggregation are explicit."
 *
 * Each item drives the real entry point and asserts the observable outcome --
 * rule id, severity, status and CLI exit code -- because a verdict that is only
 * a string in a report is a verdict a demotion can erase.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkRegistry, exitCodeFor } from '../src/index.mjs'
import { metric, oneRegistry, registryDoc, runCli } from './support.mjs'

test('acceptance: two definitions sharing a name but different grain are flagged', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'revenue_daily', name: 'revenue', grain: ['date'] }),
    metric({ id: 'revenue_regional', name: 'revenue', grain: ['date', 'region'] }),
  ]))
  const report = await checkRegistry(documents)
  const [item] = report.findings

  assert.equal(report.findings.length, 1)
  assert.equal(item.ruleId, 'name-grain-conflict')
  assert.equal(item.severity, 'error')
  assert.equal(item.location.pointer, '/metrics/1')
  assert.match(item.message, /one name cannot mean two grains/)
  // Each entry is quoted, so the evidence says how many dimensions there are.
  // Joined bare, `["date, region"]` and `["date", "region"]` read the same.
  assert.equal(item.evidence, '"date" | "date", "region"')
  assert.equal(report.summary.namesSharedBySeveralMetrics, 1)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('acceptance: a shared name with a different unit or aggregation is flagged too', async () => {
  const units = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue', unit: 'EUR' }),
    metric({ id: 'b', name: 'revenue', unit: 'USD' }),
  ]))
  const unitReport = await checkRegistry(units)
  assert.deepEqual(unitReport.findings.map((item) => item.ruleId), ['name-unit-conflict'])
  assert.equal(unitReport.status, 'fail')

  const aggregations = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue', aggregation: 'sum' }),
    metric({ id: 'b', name: 'revenue', aggregation: 'avg' }),
  ]))
  const aggregationReport = await checkRegistry(aggregations)
  assert.deepEqual(aggregationReport.findings.map((item) => item.ruleId), ['name-aggregation-conflict'])
  assert.equal(aggregationReport.status, 'fail')
})

test('acceptance: a dependency cycle fails', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'revenue', name: 'revenue', dependsOn: ['margin'] }),
    metric({ id: 'margin', name: 'margin', dependsOn: ['revenue'] }),
  ]))
  const report = await checkRegistry(documents)
  const [item] = report.findings

  assert.equal(report.findings.length, 1)
  assert.equal(item.ruleId, 'dependency-cycle')
  assert.equal(item.severity, 'error')
  assert.equal(item.evidence, 'margin -> revenue -> margin')
  assert.match(item.message, /so none of them can be computed/)
  assert.equal(report.summary.cyclicGroupsFound, 1)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('acceptance: a metric depending on itself is a cycle of one', async () => {
  const documents = await oneRegistry(registryDoc([metric({ id: 'loop', name: 'loop', dependsOn: ['loop'] })]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['dependency-cycle'])
  assert.match(report.findings[0].message, /depends on itself/)
  assert.equal(report.status, 'fail')
})

test('acceptance: two separate cycles are both reported, each once', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'a', dependsOn: ['b'] }),
    metric({ id: 'b', name: 'b', dependsOn: ['a'] }),
    metric({ id: 'y', name: 'y', dependsOn: ['z'] }),
    metric({ id: 'z', name: 'z', dependsOn: ['y'] }),
  ]))
  const report = await checkRegistry(documents)

  assert.equal(report.summary.cyclicGroupsFound, 2)
  assert.deepEqual(report.findings.map((item) => item.evidence), ['a -> b -> a', 'y -> z -> y'])
})

test('acceptance: a cycle fails through the CLI with exit 1', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'a', dependsOn: ['b'] }),
    metric({ id: 'b', name: 'b', dependsOn: ['a'] }),
  ]))
  const run = await runCli(['--root', documents.root, '--registry', documents.registry, '--json'])

  assert.equal(run.code, 1)
  assert.equal(run.stderr, '')
  assert.equal(JSON.parse(run.stdout).findings[0].ruleId, 'dependency-cycle')
})

test('acceptance: a unit must be explicit, and is never inferred', async () => {
  const withoutUnit = metric()
  delete withoutUnit.unit
  const documents = await oneRegistry(registryDoc([withoutUnit]))
  const report = await checkRegistry(documents)
  const [item] = report.findings

  assert.equal(item.ruleId, 'unit-undeclared')
  assert.equal(item.severity, 'error')
  assert.equal(item.location.pointer, '/metrics/0/unit')
  assert.match(item.message, /does not infer one from the formula/)
  // Unknown is never a pass: an undeclared unit is missing evidence, not a
  // definition this tool can judge.
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.registryRead, false)
})

test('acceptance: an aggregation must be explicit, and is never inferred', async () => {
  const withoutAggregation = metric()
  delete withoutAggregation.aggregation
  const documents = await oneRegistry(registryDoc([withoutAggregation]))
  const report = await checkRegistry(documents)
  const [item] = report.findings

  assert.equal(item.ruleId, 'aggregation-undeclared')
  assert.equal(item.location.pointer, '/metrics/0/aggregation')
  assert.match(item.message, /does not infer one from the formula/)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('acceptance: an aggregation outside the vocabulary is unknown, not accepted as declared', async () => {
  // A string in the field is not the same as a declared aggregation: this one
  // looks declared and tells a reader nothing this tool can act on.
  const documents = await oneRegistry(registryDoc([metric({ aggregation: 'weighted_harmonic_mean' })]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['aggregation-unsupported'])
  assert.match(report.findings[0].message, /does not guess what an aggregation it has not been taught computes/)
  assert.equal(report.findings[0].suggestion, 'declare "custom" if the aggregation is genuinely outside this vocabulary')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('acceptance: "custom" is accepted, because it declares the limit rather than hiding it', async () => {
  const documents = await oneRegistry(registryDoc([metric({ aggregation: 'custom' })]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('acceptance: a unit or aggregation that renders empty is not declared', async () => {
  // `value.trim().length > 0` accepts both of these and they render as nothing.
  for (const [field, value] of [['unit', String.fromCharCode(0x200e)], ['aggregation', String.fromCharCode(0x0001)]]) {
    const documents = await oneRegistry(registryDoc([metric({ [field]: value })]))
    const report = await checkRegistry(documents)
    assert.equal(report.findings[0].ruleId, `${field}-undeclared`, field)
    assert.equal(report.status, 'incomplete')
  }
})
