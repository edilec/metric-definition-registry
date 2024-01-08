/**
 * Two runs over the same registries produce byte-identical stdout, and nothing
 * in the report depends on when it was produced.
 *
 * A clock is injected, never read -- and this tool needs no instant at all, so
 * it takes none. The behavioural proof is below; the source scan beside it is a
 * cheap extra, and it is labelled as what it is rather than relied on.
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { checkRegistry, serializeReport } from '../src/index.mjs'
import { PROJECT, metric, registryDoc, runCli, twoRegistries } from './support.mjs'

const interestingPair = () => twoRegistries(
  registryDoc([
    metric({ id: 'a', name: 'shared', unit: 'EUR', dependsOn: [] }),
    metric({ id: 'b', name: 'shared', grain: ['region'], dependsOn: ['a'] }),
    metric({ id: 'gone', name: 'gone' }),
  ]),
  registryDoc([
    metric({ id: 'b', name: 'shared', grain: ['region'], dependsOn: ['a'], formula: 'other(x)' }),
    metric({ id: 'a', name: 'shared', unit: 'USD', dependsOn: ['b'] }),
    metric({ id: 'fresh', name: 'fresh' }),
  ]),
)

test('the same inputs produce byte-identical stdout across processes', async () => {
  const documents = await interestingPair()
  const args = ['--root', documents.root, '--registry', documents.registry, '--previous', documents.previous, '--json']

  const first = await runCli(args)
  const second = await runCli(args)

  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.ok(first.stdout.length > 0)
})

test('the report carries no timestamp, seed or host detail', async () => {
  const documents = await interestingPair()
  const report = await checkRegistry(documents)
  const serialised = serializeReport(report)

  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(serialised), 'an instant reached the report')
  assert.ok(!Object.hasOwn(report.summary, 'evaluatedAt'))
  assert.ok(!serialised.includes(documents.root), 'a host path reached the report')
})

test('scan: no source file reads a clock, a random source or the network', async () => {
  // Weaker than the behavioural test above, and kept for what it does catch:
  // a new CALL SITE added later. It matches call syntax rather than the words,
  // because the modules discuss both by name in their comments. It is a scan,
  // not a proof: substituting one collator for another changes the source text
  // and not the drift, which is why the ordering tests are behavioural.
  const forbidden = [
    /\bDate\.now\b/, /\bnew Date\b/, /\bMath\.random\b/,
    /node:https?/, /node:net\b/, /node:dgram\b/, /\bfetch\s*\(/,
    /\.localeCompare\s*\(/, /new Intl\.Collator/,
  ]
  for (const directory of ['src', 'bin']) {
    for (const name of await readdir(join(PROJECT, directory))) {
      const text = await readFile(join(PROJECT, directory, name), 'utf8')
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(text), `${directory}/${name} matches ${pattern}`)
      }
    }
  }
})

test('declaration order does not change the report', async () => {
  const forward = registryDoc([
    metric({ id: 'a', name: 'a', dependsOn: ['b'] }),
    metric({ id: 'b', name: 'b', dependsOn: ['a'] }),
  ])
  const backward = registryDoc([
    metric({ id: 'b', name: 'b', dependsOn: ['a'] }),
    metric({ id: 'a', name: 'a', dependsOn: ['b'] }),
  ])
  const { oneRegistry } = await import('./support.mjs')

  const first = await checkRegistry(await oneRegistry(forward))
  const second = await checkRegistry(await oneRegistry(backward))

  assert.deepEqual(first.findings.map((item) => item.evidence), second.findings.map((item) => item.evidence))
  assert.equal(first.findings[0].evidence, 'a -> b -> a')
})
