/**
 * The examples in the README are run here, with the exit codes the README
 * claims. An example that stopped working is a documentation defect.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { PROJECT, runCli } from './support.mjs'

test('the valid example passes, and every finding in it is advisory', async () => {
  const run = await runCli([
    '--root', 'examples/valid',
    '--registry', 'metrics.2026-07.json',
    '--previous', 'metrics.2026-04.json',
  ])

  assert.equal(run.code, 0)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.registryRead, true)
  assert.equal(report.summary.dependencyGraphComplete, true)
  assert.equal(report.summary.cyclesFound, 0)
  assert.equal(report.summary.comparedWithPrevious, true)
  assert.deepEqual([...new Set(report.findings.map((item) => item.severity))], ['info'])
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['formula-changed-declared', 'metric-added'])
})

test('the failing example exits 1 and names the conflict and the cycle', async () => {
  const run = await runCli(['--root', 'examples/conflicts', '--registry', 'metrics.json'])

  assert.equal(run.code, 1)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), ['dependency-cycle', 'name-grain-conflict'])
  assert.equal(report.summary.cyclesFound, 1)
  assert.equal(report.summary.namesSharedBySeveralMetrics, 1)
  assert.equal(report.summary.dependencyGraphComplete, true, 'every edge in this example resolves, so the search really ran')
})

test('the valid example on its own makes no claim about what changed', async () => {
  const run = await runCli(['--root', 'examples/valid', '--registry', 'metrics.2026-07.json'])

  assert.equal(run.code, 0)
  const report = JSON.parse(run.stdout)
  assert.equal(report.summary.comparedWithPrevious, false)
  assert.equal(report.summary.metricsChanged, 0)
  assert.deepEqual(report.findings, [])
  assert.match(run.stderr, /no previous registry was given/)
})

test('the example commands in the README are the ones the package runs', async () => {
  const readme = await readFile(join(PROJECT, 'README.md'), 'utf8')
  const manifest = JSON.parse(await readFile(join(PROJECT, 'package.json'), 'utf8'))

  assert.ok(readme.includes('--root examples/valid'))
  assert.ok(readme.includes('--root examples/conflicts'))
  assert.match(manifest.scripts.example, /examples\/valid/)
  assert.match(manifest.scripts['example:failing'], /examples\/conflicts/)
})
