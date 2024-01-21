/**
 * Two values this report renders identically, that are not the same string.
 *
 * `EUR` and `EUR ` are different strings. Every string that leaves this tool is
 * rendered first -- control characters and bidi marks removed, whitespace runs
 * collapsed, the result trimmed -- so the report shows both of them as `EUR`.
 * Comparing the raw pair and printing the rendered pair produced an
 * error-severity finding reading `changed unit from EUR to EUR`, evidence
 * `EUR | EUR`, exit 1: a sentence contradicted by its own evidence, on a
 * registry nobody needed to fix.
 *
 * Every test here drives the real entry point, and each one pins BOTH sides:
 * the rule id and the exit code that must appear, and the ones that must not.
 * An assertion that only says "no error finding" is satisfied by a tool that
 * reports nothing at all.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkRegistry, exitCodeFor } from '../src/index.mjs'
import { metric, oneRegistry, registryDoc, runCli, twoRegistries } from './support.mjs'

const NEL = String.fromCharCode(0x0085)
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e)

const ruleIds = (report) => report.findings.map((item) => item.ruleId)

async function compare(before, after) {
  const documents = await twoRegistries(registryDoc(before), registryDoc(after))
  return { documents, report: await checkRegistry(documents) }
}

test('a unit that gained a trailing space is not reported as a change of unit', async () => {
  const { documents, report } = await compare(
    [metric({ id: 'rev', name: 'revenue', unit: 'EUR' })],
    [metric({ id: 'rev', name: 'revenue', unit: 'EUR ' })],
  )

  assert.deepEqual(ruleIds(report), ['changed-invisibly'])
  const [found] = report.findings
  assert.equal(found.severity, 'warning')
  assert.equal(found.evidence, 'unit: at character 4: before the end of the value, after U+0020')
  assert.match(found.message, /changed unit only in characters this report removes/)
  // The sentence that used to be here, pinned so it cannot come back.
  assert.ok(!/changed unit from EUR to EUR/.test(found.message))
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)

  const run = await runCli(['--root', documents.root, '--registry', documents.registry, '--previous', documents.previous])
  assert.equal(run.code, 0)
  assert.match(run.stderr, /WARN\s+changed-invisibly/)
})

test('a unit that really changed is still an error and still exits 1', async () => {
  const { documents, report } = await compare(
    [metric({ id: 'rev', name: 'revenue', unit: 'EUR' })],
    [metric({ id: 'rev', name: 'revenue', unit: 'USD' })],
  )

  assert.deepEqual(ruleIds(report), ['unit-changed-undeclared'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.findings[0].evidence, 'EUR | USD')
  assert.equal(exitCodeFor(report), 1)

  const run = await runCli(['--root', documents.root, '--registry', documents.registry, '--previous', documents.previous])
  assert.equal(run.code, 1)
})

test('a control character reaches the same rule as a trailing space', async () => {
  const { report } = await compare(
    [metric({ id: 'rev', name: 'revenue', formula: 'sum(a)' })],
    [metric({ id: 'rev', name: 'revenue', formula: `sum(a)${NEL}` })],
  )

  assert.deepEqual(ruleIds(report), ['changed-invisibly'])
  assert.equal(report.findings[0].evidence, 'formula: at character 7: before the end of the value, after U+0085')
  assert.equal(exitCodeFor(report), 0)
})

test('an owner that differs only in removed characters is not an owner handover', async () => {
  const { report } = await compare(
    [metric({ id: 'rev', name: 'revenue', owner: 'analytics-platform' })],
    [metric({ id: 'rev', name: 'revenue', owner: `analytics-platform${RIGHT_TO_LEFT_OVERRIDE}` })],
  )

  assert.deepEqual(ruleIds(report), ['changed-invisibly'])
  assert.equal(report.findings[0].evidence, 'owner: at character 19: before the end of the value, after U+202E')
  assert.equal(exitCodeFor(report), 0)
})

test('a definitionVersion that differs only in removed characters has not moved', async () => {
  // Without this, a stray space in the version reads as "the version moved",
  // which turns every accompanying finding from error into info and the run
  // from exit 1 into exit 0.
  const { report } = await compare(
    [metric({ id: 'rev', name: 'revenue', unit: 'EUR', definitionVersion: '2' })],
    [metric({ id: 'rev', name: 'revenue', unit: 'USD', definitionVersion: '2 ' })],
  )

  assert.deepEqual(ruleIds(report).sort(), ['changed-invisibly', 'unit-changed-undeclared'])
  const version = report.findings.find((item) => item.ruleId === 'changed-invisibly')
  assert.equal(version.evidence, 'definitionVersion: at character 2: before the end of the value, after U+0020')
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('two definitions whose units differ only in removed characters do not "agree"', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue', unit: 'EUR' }),
    metric({ id: 'b', name: 'revenue', unit: 'EUR ' }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(ruleIds(report), ['name-differs-invisibly'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.findings[0].evidence, 'unit: at character 4: before the end of the value, after U+0020')
  // name-reused asserts POSITIVELY that the two agree about grain, unit and
  // aggregation. They do not, so it must not be the sentence a reader gets.
  assert.ok(!ruleIds(report).includes('name-reused'))
  assert.ok(!ruleIds(report).includes('name-unit-conflict'))
  assert.equal(report.summary.namesSharedBySeveralMetrics, 1)
  assert.equal(exitCodeFor(report), 0)
})

test('two definitions whose units really differ are still a conflict at exit 1', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue', unit: 'EUR' }),
    metric({ id: 'b', name: 'revenue', unit: 'USD' }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(ruleIds(report), ['name-unit-conflict'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(exitCodeFor(report), 1)
})

test('definitions are grouped by the name this report renders, not the raw string', async () => {
  // Grouped by the raw name, these are two unrelated metrics and the summary
  // says no name is shared -- under a report that prints "revenue" twice.
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue', unit: 'EUR' }),
    metric({ id: 'b', name: 'revenue ', unit: 'EUR' }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(ruleIds(report), ['name-differs-invisibly'])
  assert.equal(report.findings[0].evidence, 'name: at character 8: before the end of the value, after U+0020')
  assert.equal(report.summary.namesSharedBySeveralMetrics, 1)
  assert.equal(exitCodeFor(report), 0)
})

test('two definitions that genuinely agree are still name-reused, and nothing else', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'revenue', unit: 'EUR' }),
    metric({ id: 'b', name: 'revenue', unit: 'EUR' }),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(ruleIds(report), ['name-reused'])
  assert.equal(exitCodeFor(report), 0)
})

test('an unchanged registry stays silent', async () => {
  const { report } = await compare(
    [metric({ id: 'rev', name: 'revenue', unit: 'EUR' })],
    [metric({ id: 'rev', name: 'revenue', unit: 'EUR' })],
  )

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
})
