/**
 * The cycle search itself.
 *
 * Two properties matter beyond finding cycles: it refuses an index with an edge
 * pointing outside it, and it is iterative, so a chain deeper than the call
 * stack is a report rather than a crash. A stack overflow is an exit code
 * outside this tool's contract, which is the failure mode the report contract
 * calls "outside the documented exit contract".
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { findCycles } from '../src/index.mjs'

const graph = (edges) => new Map(Object.entries(edges))

test('an acyclic graph has no cycles', () => {
  assert.deepEqual(findCycles(graph({ a: ['b'], b: ['c'], c: [] })), [])
  assert.deepEqual(findCycles(graph({})), [])
})

test('a diamond is not a cycle', () => {
  assert.deepEqual(findCycles(graph({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] })), [])
})

test('a cycle is found once, whichever node the walk starts from', () => {
  assert.deepEqual(findCycles(graph({ a: ['b'], b: ['c'], c: ['a'] })), [['a', 'b', 'c']])
  // Same cycle, declared in another order: the report must read the same.
  assert.deepEqual(findCycles(graph({ c: ['a'], b: ['c'], a: ['b'] })), [['a', 'b', 'c']])
})

test('a self reference is a cycle of one', () => {
  assert.deepEqual(findCycles(graph({ a: ['a'] })), [['a']])
})

test('separate cycles are all reported, ordered by code unit', () => {
  const cycles = findCycles(graph({ Z: ['Y'], Y: ['Z'], a: ['b'], b: ['a'] }))
  // 'Z' is 0x5A and 'a' is 0x61, so the uppercase pair comes first by code
  // unit. A collator puts the lowercase pair first.
  assert.deepEqual(cycles, [['Y', 'Z'], ['a', 'b']])
})

test('an index with an edge leaving it is refused rather than searched', () => {
  // This is the guarantee the caller depends on: pruning the dangling edge
  // would let the search finish and report "no cycles" over a graph that was
  // never the one in the document.
  assert.throws(
    () => findCycles(graph({ a: ['ghost'] })),
    /was given an edge from a to an id outside the index/,
  )
})

test('a chain far deeper than the call stack is handled without crashing', () => {
  const deep = {}
  for (let index = 0; index < 50000; index += 1) deep[`m${index}`] = index < 49999 ? [`m${index + 1}`] : []
  assert.deepEqual(findCycles(graph(deep)), [])

  // And the same chain closed into one enormous cycle.
  deep.m49999 = ['m0']
  const cycles = findCycles(graph(deep))
  assert.equal(cycles.length, 1)
  assert.equal(cycles[0].length, 50000)
})
