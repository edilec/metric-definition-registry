/**
 * Every untrusted string that reaches output passes through the sanitiser --
 * metric ids, names, grain dimensions, units, formulas, filters and owners, not
 * only an excerpt field. One tool in this catalog sanitised its evidence
 * carefully and let a page id carrying a newline forge whole lines in the
 * report.
 *
 * Each class in the contract's table is tested, and each is tested arriving
 * through an IDENTIFIER (a metric name), not only through an excerpt.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTROL_CLASSES, excerpt, hasForbiddenCharacter, isUsableText } from '../src/text.mjs'
import { checkRegistry, formatReport } from '../src/index.mjs'
import { metric, oneRegistry, registryDoc, runCli } from './support.mjs'

const CLASS_NAMES = ['c0', 'del', 'c1', 'lineSeparators', 'bidi']

/**
 * Every string the report carries, walked out of the object itself.
 *
 * Asserting against `JSON.stringify` output would be the wrong check twice
 * over: it escapes control characters on the way out, hiding a character that
 * IS in the field, and it adds newlines of its own from pretty-printing. The
 * field values are what a consumer reads.
 */
function stringsIn(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsIn(entry, found)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) stringsIn(entry, found)
  return found
}

/** A registry that always produces one finding, with the given name on both definitions. */
const conflicting = (name) => registryDoc([
  metric({ id: 'a', name, grain: ['date'] }),
  metric({ id: 'b', name, grain: ['date', 'region'] }),
])

test('the sanitiser knows about every class the contract names', () => {
  assert.deepEqual(Object.keys(CONTROL_CLASSES), CLASS_NAMES)
  assert.ok(CONTROL_CLASSES.c1.includes(0x85), 'NEL forges a line on a terminal')
  assert.ok(CONTROL_CLASSES.c1.includes(0x9b), 'the 8-bit CSI opens an escape sequence')
  assert.ok(CONTROL_CLASSES.bidi.includes(0x202e), 'RIGHT-TO-LEFT OVERRIDE reverses displayed text')
  assert.ok(CONTROL_CLASSES.lineSeparators.includes(0x2028))
})

/** The human summary for the same finding with a name carrying nothing odd. */
async function cleanSummaryLineCount() {
  const report = await checkRegistry(await oneRegistry(conflicting('ok name')))
  return formatReport(report).split('\n').length
}

for (const className of CLASS_NAMES) {
  test(`a metric name carrying a ${className} character is sanitised out of the report`, async () => {
    const expectedLines = await cleanSummaryLineCount()
    for (const codePoint of CONTROL_CLASSES[className]) {
      const forged = `ok${String.fromCharCode(codePoint)}name`
      const report = await checkRegistry(await oneRegistry(conflicting(forged)))

      // What IS there, beside what is not: the finding was raised, and the
      // name reached the message with the character removed.
      assert.equal(report.findings[0].ruleId, 'name-grain-conflict')
      assert.match(report.findings[0].message, /ok name/)
      for (const text of stringsIn(report)) {
        assert.ok(
          !text.includes(String.fromCharCode(codePoint)),
          `U+${codePoint.toString(16).padStart(4, '0')} survived into a report field`,
        )
      }
      // The human summary is line-oriented, so the guarantee there is
      // structural: a forged character must not add a line to it.
      assert.equal(formatReport(report).split('\n').length, expectedLines, 'a control character changed the shape of the human summary')
    }
  })
}

test('a formula carrying a control character is sanitised in the evidence', async () => {
  const root = await oneRegistry(registryDoc([metric({ formula: `sum(${String.fromCharCode(0x2028)}a)` })]))
  const previous = registryDoc([metric({ formula: 'sum(a)' })])
  const { writeDocument } = await import('./support.mjs')
  await writeDocument(root.root, 'previous.json', previous)

  const report = await checkRegistry({ ...root, previous: 'previous.json' })

  assert.equal(report.findings[0].ruleId, 'formula-changed-undeclared')
  assert.ok(stringsIn(report).every((text) => !text.includes(String.fromCharCode(0x2028))))
  assert.match(report.findings[0].evidence, /sum\(a\) \| sum\( a\)/)
})

test('a newline in a metric id cannot forge a line in the human summary', async () => {
  const forged = 'a\nERROR  forged-rule  everything is fine'
  const documents = await oneRegistry(registryDoc([
    metric({ id: forged, name: 'shared', grain: ['date'] }),
    metric({ id: 'b', name: 'shared', grain: ['region'] }),
  ]))
  const run = await runCli(['--root', documents.root, '--registry', documents.registry])

  assert.equal(run.code, 1)
  const forgedLines = run.stderr.split('\n').filter((line) => line.startsWith('ERROR'))
  assert.deepEqual(forgedLines, [], 'a finding line must start with the tool\'s own indentation')
  assert.match(run.stderr, /ERROR  name-grain-conflict/)
})

test('an id that renders empty is refused, not accepted as present', () => {
  // `value.trim().length > 0` passes for both of these and then renders as the
  // empty string -- a required field that says nothing.
  assert.equal(isUsableText(String.fromCharCode(0x0001), 200), false)
  assert.equal(isUsableText(String.fromCharCode(0x200e), 200), false)
  assert.equal(isUsableText('   ', 200), false)
  assert.equal(isUsableText('orders_daily', 200), true)
  assert.equal(String.fromCharCode(0x0001).trim().length > 0, true, 'trim alone would have accepted it')
})

test('a metric whose id renders empty makes the run incomplete', async () => {
  const report = await checkRegistry(await oneRegistry(registryDoc([metric({ id: String.fromCharCode(0x200e) })])))

  assert.equal(report.findings[0].ruleId, 'metric-invalid')
  assert.equal(report.findings[0].location.pointer, '/metrics/0/id')
  assert.equal(report.status, 'incomplete')
})

test('excerpt bounds what it renders and reports the truncation', () => {
  assert.equal(excerpt('x'.repeat(10), 5), 'xxxxx...')
  assert.equal(excerpt('x'.repeat(5), 5), 'xxxxx')
  assert.throws(() => excerpt('x', 0), TypeError)
  assert.equal(hasForbiddenCharacter(`a${String.fromCharCode(0x009b)}b`), true)
  assert.equal(hasForbiddenCharacter('plain'), false)
})
