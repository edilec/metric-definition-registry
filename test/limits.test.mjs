/**
 * A bound has two sides.
 *
 * Every limit below is driven from BOTH: that it fires at N+1, and that it
 * stays SILENT at exactly N. The second assertion is the one users notice --
 * widening a comparison by one starts refusing documents sitting exactly on a
 * limit the documentation calls legal, and a suite that only tests the
 * overflow side stays green through it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ConfigError, DEFAULT_LIMITS, checkRegistry, exitCodeFor } from '../src/index.mjs'
import { makeRoot, metric, registryDoc, runCli, writeDocument } from './support.mjs'

/** A registry serialised to exactly `bytes` bytes, padded with trailing spaces. */
function registryOfExactBytes(bytes) {
  const text = JSON.stringify(registryDoc())
  assert.ok(text.length <= bytes, `cannot pad down to ${bytes} bytes`)
  return text + ' '.repeat(bytes - text.length)
}

const metrics = (count) => Array.from({ length: count }, (unused, index) => metric({
  id: `m${String(index).padStart(4, '0')}`,
  name: `m${String(index).padStart(4, '0')}`,
}))

test('maxDocumentBytes: a registry of exactly the limit is read', async () => {
  const limit = 400
  const root = await makeRoot()
  const text = registryOfExactBytes(limit)
  assert.equal(Buffer.byteLength(text), limit)
  await writeDocument(root, 'metrics.json', text)

  const report = await checkRegistry({ root, registry: 'metrics.json', limits: { maxDocumentBytes: limit } })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.registryRead, true)
  assert.equal(report.findings.filter((item) => item.ruleId === 'input-too-large').length, 0)
})

test('maxDocumentBytes: one byte over the limit is refused, and nothing is analysed', async () => {
  const limit = 400
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryOfExactBytes(limit + 1))

  const report = await checkRegistry({ root, registry: 'metrics.json', limits: { maxDocumentBytes: limit } })

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['input-too-large'])
  assert.match(report.findings[0].message, /401 bytes, over the 400 byte limit/)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.registryRead, false)
})

test('maxMetrics: a registry of exactly the limit is validated', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc(metrics(8)))

  const report = await checkRegistry({ root, registry: 'metrics.json', limits: { maxMetrics: 8 } })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.metrics, 8)
  assert.equal(report.findings.filter((item) => item.ruleId === 'too-many-metrics').length, 0)
})

test('maxMetrics: one metric over the limit refuses the registry without validating any of them', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc(metrics(9)))

  const report = await checkRegistry({ root, registry: 'metrics.json', limits: { maxMetrics: 8 } })

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['too-many-metrics'])
  assert.match(report.findings[0].message, /declares 9 metrics, over the 8 metric limit/)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.registryRead, false)
})

test('maxListEntries: a list of exactly the limit is examined', async () => {
  const grain = Array.from({ length: 4 }, (unused, index) => `dimension_${index}`)
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc([metric({ grain })]))

  const report = await checkRegistry({ root, registry: 'metrics.json', limits: { maxListEntries: 4 } })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
})

test('maxListEntries: one entry over the limit is refused', async () => {
  const grain = Array.from({ length: 5 }, (unused, index) => `dimension_${index}`)
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc([metric({ grain })]))

  const report = await checkRegistry({ root, registry: 'metrics.json', limits: { maxListEntries: 4 } })

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['too-many-list-entries'])
  assert.match(report.findings[0].message, /grain declares 5 entries, over the 4 entry limit/)
  assert.equal(report.status, 'incomplete')
})

test('maxFieldLength: a field of exactly the limit is accepted', async () => {
  const root = await makeRoot()
  // Every other field is kept inside the limit too, so the only value sitting
  // exactly on it is the one under test.
  await writeDocument(root, 'metrics.json', registryDoc([
    metric({ id: 'm', name: 'm', owner: 'ops', unit: 'EUR', formula: 'f'.repeat(12) }),
  ]))

  const report = await checkRegistry({ root, registry: 'metrics.json', limits: { maxFieldLength: 12 } })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
})

test('maxFieldLength: a field one character over the limit is refused', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc([
    metric({ id: 'm', name: 'm', owner: 'ops', unit: 'EUR', formula: 'f'.repeat(13) }),
  ]))

  const report = await checkRegistry({ root, registry: 'metrics.json', limits: { maxFieldLength: 12 } })

  assert.deepEqual(report.findings.map((item) => item.location.pointer), ['/metrics/0/formula'])
  assert.equal(report.findings[0].ruleId, 'metric-invalid')
  assert.equal(report.status, 'incomplete')
})

test('maxFindings: exactly the limit is reported in full', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'previous.json', registryDoc(metrics(1)))
  await writeDocument(root, 'metrics.json', registryDoc(metrics(7)))

  const report = await checkRegistry({ root, registry: 'metrics.json', previous: 'previous.json', limits: { maxFindings: 6 } })

  assert.equal(report.findings.length, 6)
  assert.deepEqual([...new Set(report.findings.map((item) => item.ruleId))], ['metric-added'])
  assert.equal(report.status, 'pass')
})

test('maxFindings: one finding over the limit truncates the list and says so', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'previous.json', registryDoc(metrics(1)))
  await writeDocument(root, 'metrics.json', registryDoc(metrics(7)))

  const report = await checkRegistry({ root, registry: 'metrics.json', previous: 'previous.json', limits: { maxFindings: 5 } })

  assert.equal(report.findings.length, 5)
  assert.equal(report.findings.at(-1).ruleId, 'too-many-findings')
  assert.match(report.findings.at(-1).message, /6 findings were produced, over the 5 finding limit/)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a limit name this tool does not have is a configuration error, not a silent default', async () => {
  const root = await makeRoot()
  await assert.rejects(
    () => checkRegistry({ root, registry: 'metrics.json', limits: { maxMetric: 5 } }),
    (error) => error instanceof ConfigError && /Unknown limit "maxMetric"/.test(error.message),
  )
})

test('a limit that is not a positive integer is a configuration error', async () => {
  const root = await makeRoot()
  for (const value of [0, -1, 1.5, '10', null]) {
    await assert.rejects(
      () => checkRegistry({ root, registry: 'metrics.json', limits: { maxMetrics: value } }),
      (error) => error instanceof ConfigError,
    )
  }
})

test('the documented defaults are the values the code uses', () => {
  assert.deepEqual({ ...DEFAULT_LIMITS }, {
    maxDocumentBytes: 1048576,
    maxMetrics: 5000,
    maxListEntries: 50,
    maxFieldLength: 400,
    maxFindings: 1000,
  })
})

test('the CLI wires every limit flag through to the engine', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc(metrics(9)))

  const silent = await runCli(['--root', root, '--registry', 'metrics.json', '--max-metrics', '9', '--json'])
  assert.equal(silent.code, 0)

  const fires = await runCli(['--root', root, '--registry', 'metrics.json', '--max-metrics', '8', '--json'])
  assert.equal(fires.code, 2)
  assert.equal(JSON.parse(fires.stdout).findings[0].ruleId, 'too-many-metrics')
})
