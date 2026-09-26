/**
 * The package, and the documents that describe it.
 *
 * A documentation overclaim counts as a defect here, so the rule table is
 * checked against the code in BOTH directions -- a rule the code can emit and
 * the docs never mention, and a rule the docs promise and the code cannot
 * produce, are both failures.
 */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, RULE_CATALOG, SUPPORTED_AGGREGATIONS, TOOL_ID } from '../src/index.mjs'
import { PROJECT } from './support.mjs'

const readProjectFile = (name) => readFile(join(PROJECT, name), 'utf8')
const readPackage = async () => JSON.parse(await readProjectFile('package.json'))

/** The rule rows a markdown table declares, as `id -> { severity, incomplete }`. */
function ruleRows(markdown) {
  const rows = new Map()
  for (const [, ruleId, severity, incomplete] of markdown.matchAll(/^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes|no) \|/gm)) {
    rows.set(ruleId, { severity, incomplete: incomplete === 'yes' })
  }
  return rows
}

test('TOOL_ID equals the directory name and the package name', async () => {
  const manifest = await readPackage()
  assert.equal(TOOL_ID, basename(PROJECT))
  assert.equal(TOOL_ID, manifest.name)
  assert.equal(manifest.bin[TOOL_ID], `./bin/${TOOL_ID}.mjs`)
})

test('the package declares the scripts the release check needs', async () => {
  const manifest = await readPackage()
  for (const script of ['lint', 'test', 'example', 'example:failing', 'pack:check', 'check']) {
    assert.ok(Object.hasOwn(manifest.scripts, script), `missing script: ${script}`)
  }
  assert.match(manifest.scripts.check, /npm run lint/)
  assert.match(manifest.scripts.check, /npm test/)
  assert.match(manifest.scripts.check, /npm run example/)
  assert.match(manifest.scripts.check, /npm run example:failing/)
  assert.match(manifest.scripts.check, /npm run pack:check/)
})

test('the package declares no dependencies of any kind', async () => {
  const manifest = await readPackage()
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
})

for (const document of ['README.md', 'docs/rules.md']) {
  test(`${document} documents exactly the rules the code can emit`, async () => {
    const rows = ruleRows(await readProjectFile(document))
    const catalogue = new Map(RULE_CATALOG.map((entry) => [entry.ruleId, entry]))

    for (const entry of RULE_CATALOG) {
      const row = rows.get(entry.ruleId)
      assert.ok(row !== undefined, `${document} does not document ${entry.ruleId}`)
      assert.equal(row.severity, entry.severity, `${document} disagrees about the severity of ${entry.ruleId}`)
      assert.equal(row.incomplete, entry.incomplete, `${document} disagrees about whether ${entry.ruleId} makes the run incomplete`)
    }
    for (const ruleId of rows.keys()) {
      assert.ok(catalogue.has(ruleId), `${document} documents ${ruleId}, which the code cannot emit`)
    }
    assert.equal(rows.size, RULE_CATALOG.length)
  })
}

test('the README states the limits the code actually enforces', async () => {
  const readme = await readProjectFile('README.md')
  const documented = Object.fromEntries(
    [...readme.matchAll(/^\| `--([a-z-]+)` \| (\d+) \|/gm)].map(([, flag, value]) => [flag, Number(value)]),
  )
  assert.deepEqual(documented, {
    'max-document-bytes': DEFAULT_LIMITS.maxDocumentBytes,
    'max-metrics': DEFAULT_LIMITS.maxMetrics,
    'max-list-entries': DEFAULT_LIMITS.maxListEntries,
    'max-field-length': DEFAULT_LIMITS.maxFieldLength,
    'max-findings': DEFAULT_LIMITS.maxFindings,
  })
})

test('the README lists exactly the aggregations the code accepts', async () => {
  const readme = await readProjectFile('README.md')
  const section = readme.slice(readme.indexOf('### Aggregations'))
  const listed = [...section.matchAll(/`([a-z_]+)`/g)].map(([, name]) => name)
  const documented = listed.slice(0, SUPPORTED_AGGREGATIONS.length)
  assert.deepEqual(documented, [...SUPPORTED_AGGREGATIONS])
})

test('the README claims no destination check the code does not perform', async () => {
  const readme = await readProjectFile('README.md')
  // This tool writes nothing, so it must not describe a write guard it has no
  // use for -- documenting a check that is not performed reads as coverage.
  assert.match(readme, /It writes nothing/)
  assert.match(readme, /no destination check applies/)
  assert.ok(!/assertWritableDestination/.test(readme))
  assert.match(readme, /--root/)
})

test('the README carries the sections a reader needs', async () => {
  const readme = await readProjectFile('README.md')
  for (const heading of ['## Why this exists', '## Quick start', '## Rules', '## Exit codes', '## Limits', '## Non-goals']) {
    assert.ok(readme.includes(heading), `missing section: ${heading}`)
  }
})

/**
 * Every file npm would publish, as a path relative to the project root.
 *
 * Derived from `package.json` `files` rather than written out, because a
 * hand-written list is a list that stops matching the package the day somebody
 * adds a directory to it -- which is exactly what happened here: the list named
 * four documents while `files` publishes `bin`, `src`, `examples` and `docs`,
 * so the credential scan below never looked at a single line of shipped source.
 * `package.json` itself is always published whether or not it is listed.
 */
async function publishedFiles() {
  const manifest = await readPackage()
  const found = []
  const visit = async (relative) => {
    let entries
    try {
      entries = await readdir(join(PROJECT, relative), { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOTDIR') {
        found.push(relative)
        return
      }
      throw error
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      await visit(posix.join(relative, entry.name))
    }
  }
  for (const entry of [...manifest.files, 'package.json']) await visit(entry)
  return found.sort()
}

test('the published-file list is derived from the package, not from a hand-written list', async () => {
  const published = await publishedFiles()
  // The companion to the absence assertions below: a scan over an empty or
  // truncated list passes for the wrong reason. These are the files that were
  // outside the old hand-written list, and the source one is the file that
  // carried a key-shaped literal past it.
  for (const name of ['src/text.mjs', 'src/index.mjs', 'src/graph.mjs', 'bin/metric-definition-registry.mjs', 'LICENSE', 'package.json']) {
    assert.ok(published.includes(name), `${name} is published and would not be scanned`)
  }
  assert.ok(published.length >= 12, `only ${published.length} published file(s) were enumerated`)
})

test('no file in the published tree names a person, a credential or a host', async () => {
  // The catalogue rule: nothing that looks like a real record, anywhere. Owners
  // in every fixture and example are teams, never people. This walks the whole
  // published tree -- source, binary entry point, examples and documents alike
  // -- because a key-shaped literal in a source comment ships exactly as far as
  // one in the README.
  for (const name of await publishedFiles()) {
    const text = await readProjectFile(name)
    assert.ok(!/AKIA[0-9A-Z]{16}/.test(text), `${name} carries something shaped like a key`)
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `${name} carries a private key block`)
    assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text.replaceAll('noreply@', '')), `${name} carries something shaped like an address`)
  }
})
