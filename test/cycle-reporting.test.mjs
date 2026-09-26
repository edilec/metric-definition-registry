/**
 * What the report says about cycles, driven through the real entry point.
 *
 * Two defects meet here. `summary.cyclesFound` was an exact integer that
 * undercounted: the old colour-marked walk recorded a back edge only to a node
 * still on the current path, so with `a -> [b, c]`, `b -> [c]`, `c -> [a]` it
 * found `a -> b -> c -> a`, missed `a -> c -> a`, and reported "1 cycle" while
 * the module comment, the README and the changelog all claimed every elementary
 * cycle was reported once.
 *
 * And the enumeration it was attempting is unbounded: a registry of 4880
 * definitions with fourteen dependencies each -- 1,045,409 bytes against a
 * 1,048,576 byte limit, 4880 metrics against a 5000 metric limit -- produced
 * 63,349 cycle objects, 3.2 GB of resident memory and over eight minutes,
 * against a README that says a legal-sized input cannot exhaust memory.
 *
 * So the unit is the cyclic GROUP, and these tests pin both halves: every
 * metric in a cycle is named, and the amount of output is bounded by the number
 * of groups rather than by the number of paths through them.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkRegistry, exitCodeFor } from '../src/index.mjs'
import { metric, oneRegistry, registryDoc } from './support.mjs'

const cyclic = (id, dependsOn) => metric({ id, name: id, dependsOn })

test('two cycles sharing a node are one group, and every member is named', async () => {
  // a -> b -> c -> a and a -> c -> a. The old search saw one of the two and
  // called that an exact count.
  const documents = await oneRegistry(registryDoc([
    cyclic('a', ['b', 'c']),
    cyclic('b', ['c']),
    cyclic('c', ['a']),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['dependency-cycle'])
  assert.equal(report.summary.cyclicGroupsFound, 1)
  // Every metric that takes part in a cycle is named, whether or not the
  // witness cycle passes through it.
  assert.match(report.findings[0].message, /the group is a, b, c/)
  assert.equal(report.findings[0].evidence, 'a -> c -> a')
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('a member outside the witness cycle is still reported as unusable', async () => {
  // b is in the group -- it depends on c and c depends on a which depends on b
  // -- but the shortest cycle through a does not pass through it.
  const documents = await oneRegistry(registryDoc([
    cyclic('a', ['b', 'c']),
    cyclic('b', ['c']),
    cyclic('c', ['a']),
  ]))
  const report = await checkRegistry(documents)

  assert.ok(!report.findings[0].evidence.includes('b'))
  assert.ok(report.findings[0].message.includes('b'))
})

test('a witness that covers the whole group says so without a group list', async () => {
  const documents = await oneRegistry(registryDoc([
    cyclic('a', ['b']),
    cyclic('b', ['c']),
    cyclic('c', ['a']),
  ]))
  const report = await checkRegistry(documents)

  assert.equal(report.findings[0].evidence, 'a -> b -> c -> a')
  assert.match(report.findings[0].message, /3 metrics depend on each other, so none of them can be computed: a -> b -> c -> a$/)
})

test('two groups joined by a one-way edge are two findings, not one', async () => {
  const documents = await oneRegistry(registryDoc([
    cyclic('a', ['b']),
    cyclic('b', ['a', 'c']),
    cyclic('c', ['d']),
    cyclic('d', ['c']),
  ]))
  const report = await checkRegistry(documents)

  assert.deepEqual(report.findings.map((item) => item.evidence), ['a -> b -> a', 'c -> d -> c'])
  assert.equal(report.summary.cyclicGroupsFound, 2)
})

test('a registry whose cycles number in the tens of thousands produces one finding per group', async () => {
  // The shape that cost 3.2 GB: a chain where every metric also depends on the
  // first thirteen, so almost every pair of paths closes another cycle. All of
  // it is one strongly connected group, and one group is one finding. The old
  // search emitted one finding per path it happened to close.
  const size = 900
  const depth = 13
  const metrics = Array.from({ length: size }, (unused, position) => {
    const dependsOn = []
    if (position < size - 1) dependsOn.push(`m${position + 1}`)
    for (let earlier = 0; earlier < depth && earlier < position; earlier += 1) dependsOn.push(`m${earlier}`)
    return cyclic(`m${position}`, dependsOn)
  })
  const documents = await oneRegistry(registryDoc(metrics))

  const started = process.hrtime.bigint()
  const report = await checkRegistry(documents)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

  assert.equal(report.summary.cyclicGroupsFound, 1)
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['dependency-cycle'])
  assert.match(report.findings[0].message, new RegExp(`^${size} metrics depend on each other`))
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  // Generous by two orders of magnitude against the measured linear cost, and
  // still far below what enumerating the paths through this graph costs.
  assert.ok(elapsedMs < 30000, `the search took ${elapsedMs.toFixed(0)} ms`)
})

test('an acyclic registry of the same size stays silent', async () => {
  // The companion to the test above: a bound that fires on everything large
  // would pass it while making the tool useless.
  const size = 900
  const metrics = Array.from({ length: size }, (unused, position) => cyclic(
    `m${position}`,
    position < size - 1 ? [`m${position + 1}`] : [],
  ))
  const report = await checkRegistry(await oneRegistry(registryDoc(metrics)))

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.cyclicGroupsFound, 0)
  assert.equal(exitCodeFor(report), 0)
})
