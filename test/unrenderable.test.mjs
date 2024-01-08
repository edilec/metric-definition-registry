/**
 * `String(value)` throws for an object carrying a non-callable own `toString`,
 * and `{"toString": {}}` in a document is enough to reach it. Uncaught, one
 * malformed registry costs the whole report: stdout empty on exit 2, which is
 * the shape reserved for a configuration error.
 *
 * Each field below is a field the tool renders into a message before, or
 * instead of, any other check.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkRegistry, renderable } from '../src/index.mjs'
import { makeRoot, runCli, writeDocument } from './support.mjs'

const UNRENDERABLE = '{"toString": {}}'
const wrap = (metricText, registryVersion = '"1"') => `{"registryVersion": ${registryVersion}, "metrics": [${metricText}]}`
const DEFINITION = '"id": "m", "name": "m", "grain": [], "aggregation": "sum", "unit": "EUR", "formula": "f", "filters": [], "owner": "ops", "dependsOn": [], "definitionVersion": "1"'

test('String() really does throw for this shape, so the guard is not theoretical', () => {
  assert.throws(() => String(JSON.parse(UNRENDERABLE)), TypeError)
  assert.equal(renderable(JSON.parse(UNRENDERABLE)), '[object]')
  assert.equal(renderable([1, 2]), '1,2')
  assert.equal(renderable(null), 'null')
})

for (const [label, document] of [
  ['registryVersion', wrap(`{${DEFINITION}}`, UNRENDERABLE)],
  ['an id', wrap(`{${DEFINITION.replace('"id": "m"', `"id": ${UNRENDERABLE}`)}}`)],
  ['an aggregation', wrap(`{${DEFINITION.replace('"aggregation": "sum"', `"aggregation": ${UNRENDERABLE}`)}}`)],
  ['a unit', wrap(`{${DEFINITION.replace('"unit": "EUR"', `"unit": ${UNRENDERABLE}`)}}`)],
  ['a grain entry', wrap(`{${DEFINITION.replace('"grain": []', `"grain": [${UNRENDERABLE}]`)}}`)],
  ['an unknown field name', wrap(`{${DEFINITION}, "tier": ${UNRENDERABLE}}`)],
]) {
  test(`an unrenderable ${label} is described, and the report still arrives`, async () => {
    const root = await makeRoot()
    await writeDocument(root, 'metrics.json', document)

    const report = await checkRegistry({ root, registry: 'metrics.json' })

    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.length > 0)
    // The description carries nothing of the document, so a neighbouring field
    // cannot leak out through it.
    for (const item of report.findings) assert.ok(!item.message.includes('toString'))
  })
}

test('the CLI still writes a report on stdout for an unrenderable field', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', wrap(`{${DEFINITION}}`, UNRENDERABLE))

  const run = await runCli(['--root', root, '--registry', 'metrics.json', '--json'])

  assert.equal(run.code, 2)
  assert.notEqual(run.stdout, '', 'an empty stdout here would be the configuration-error shape')
  assert.equal(JSON.parse(run.stdout).status, 'incomplete')
})
