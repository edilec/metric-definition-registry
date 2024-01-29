/**
 * The cycle search itself.
 *
 * Four properties matter. It refuses an index with an edge pointing outside it.
 * It is iterative, so a chain deeper than the call stack is a report rather
 * than a crash -- a stack overflow is an exit code outside this tool's
 * contract. It finds EVERY group of metrics that depend on each other, which is
 * the completeness claim the module makes and the previous search did not keep.
 * And it does all of that in time and memory linear in the size of the graph.
 *
 * The test this file used to carry for the third property used two fully
 * disjoint cycles, which the old search did handle, and called the result "all
 * cycles are reported". The case it never tried is the one that was broken:
 * two cycles sharing a node.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { findCyclicGroups } from '../src/index.mjs'

const graph = (edges) => new Map(Object.entries(edges))
const membersOf = (groups) => groups.map((group) => group.members)

test('an acyclic graph has no cyclic groups', () => {
  assert.deepEqual(findCyclicGroups(graph({ a: ['b'], b: ['c'], c: [] })), [])
  assert.deepEqual(findCyclicGroups(graph({})), [])
})

test('a diamond is not a cycle', () => {
  assert.deepEqual(findCyclicGroups(graph({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] })), [])
})

test('a cycle is found once, whichever node the walk starts from', () => {
  assert.deepEqual(findCyclicGroups(graph({ a: ['b'], b: ['c'], c: ['a'] })), [{ members: ['a', 'b', 'c'], cycle: ['a', 'b', 'c'] }])
  // The same graph, declared in another order: the report must read the same.
  assert.deepEqual(findCyclicGroups(graph({ c: ['a'], b: ['c'], a: ['b'] })), [{ members: ['a', 'b', 'c'], cycle: ['a', 'b', 'c'] }])
})

test('a self reference is a cyclic group of one', () => {
  assert.deepEqual(findCyclicGroups(graph({ a: ['a'] })), [{ members: ['a'], cycle: ['a'] }])
})

test('separate groups are all reported, ordered by code unit', () => {
  const groups = findCyclicGroups(graph({ Z: ['Y'], Y: ['Z'], a: ['b'], b: ['a'] }))
  // 'Z' is 0x5A and 'a' is 0x61, so the uppercase pair comes first by code
  // unit. A collator puts the lowercase pair first.
  assert.deepEqual(membersOf(groups), [['Y', 'Z'], ['a', 'b']])
})

test('cycles sharing a node are one group, and every member of it is named', () => {
  // The defect this replaces: a -> b -> c -> a and a -> c -> a are two
  // elementary cycles, and the colour-marked search found one of them and
  // reported "1 cycle" as an exact count. All three metrics are unusable and
  // all three are named here.
  const groups = findCyclicGroups(graph({ a: ['b', 'c'], b: ['c'], c: ['a'] }))
  assert.deepEqual(membersOf(groups), [['a', 'b', 'c']])
  // The witness is the shortest cycle through the first member.
  assert.deepEqual(groups[0].cycle, ['a', 'c'])
})

test('a metric outside the cycle is not dragged into the group', () => {
  // `d` depends on the group and `e` is depended on by it; neither is cyclic.
  const groups = findCyclicGroups(graph({ a: ['b'], b: ['a', 'e'], d: ['a'], e: [] }))
  assert.deepEqual(membersOf(groups), [['a', 'b']])
})

test('two groups joined by a one-way edge stay two groups', () => {
  const groups = findCyclicGroups(graph({ a: ['b'], b: ['a', 'c'], c: ['d'], d: ['c'] }))
  assert.deepEqual(membersOf(groups), [['a', 'b'], ['c', 'd']])
})

test('an index with an edge leaving it is refused rather than searched', () => {
  // This is the guarantee the caller depends on: pruning the dangling edge
  // would let the search finish and report "no cycles" over a graph that was
  // never the one in the document.
  assert.throws(
    () => findCyclicGroups(graph({ a: ['ghost'] })),
    /was given an edge from a to an id outside the index/,
  )
})

test('a dependency named twice is one edge, not a cycle of its own', () => {
  assert.deepEqual(findCyclicGroups(graph({ a: ['b', 'b'], b: [] })), [])
  assert.deepEqual(findCyclicGroups(graph({ a: ['b', 'b'], b: ['a'] })), [{ members: ['a', 'b'], cycle: ['a', 'b'] }])
})

test('a chain far deeper than the call stack is handled without crashing', () => {
  const deep = {}
  for (let index = 0; index < 50000; index += 1) deep[`m${index}`] = index < 49999 ? [`m${index + 1}`] : []
  assert.deepEqual(findCyclicGroups(graph(deep)), [])

  // And the same chain closed into one enormous group.
  deep.m49999 = ['m0']
  const groups = findCyclicGroups(graph(deep))
  assert.equal(groups.length, 1)
  assert.equal(groups[0].members.length, 50000)
  assert.equal(groups[0].cycle.length, 50000)
})

/**
 * A deterministic pseudo-random generator, so a failure is reproducible from
 * the seed printed in the assertion rather than from a run nobody can repeat.
 */
function randomSource(seed) {
  let state = seed
  return (bound) => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % bound
  }
}

/** Everything reachable from `from`, by a walk that cannot recurse. */
function reachableFrom(from, adjacency) {
  const seen = new Set([from])
  const queue = [from]
  for (let at = 0; at < queue.length; at += 1) {
    for (const target of adjacency.get(queue[at])) {
      if (seen.has(target)) continue
      seen.add(target)
      queue.push(target)
    }
  }
  return seen
}

test('every group is exactly the set of metrics that reach each other, on 400 random graphs', () => {
  // The witness cycle is built by a search whose termination depends on the
  // group really being strongly connected. This drives that search over
  // hundreds of shapes and checks the answer against the definition computed
  // independently, rather than trusting the implementation to agree with
  // itself.
  const cyclicSeen = { yes: 0, no: 0 }
  let witnessesChecked = 0
  for (let seed = 1; seed <= 400; seed += 1) {
    const random = randomSource(seed)
    const size = 2 + random(9)
    // The density varies so the sweep covers sparse graphs with no cycle at all
    // and dense ones where every metric is in the same group.
    const sparseness = 2 + random(24)
    const ids = Array.from({ length: size }, (unused, index) => `m${index}`)
    const adjacency = new Map(ids.map((id) => [id, []]))
    for (const from of ids) {
      for (const to of ids) {
        if (random(sparseness) === 0) adjacency.get(from).push(to)
      }
    }

    const groups = findCyclicGroups(adjacency)
    const grouped = new Set(groups.flatMap((group) => group.members))

    for (const id of ids) {
      // On a cycle iff some edge out of it leads somewhere that gets back.
      const cyclic = adjacency.get(id).some((target) => reachableFrom(target, adjacency).has(id))
      assert.equal(grouped.has(id), cyclic, `seed ${seed}: ${id} cyclic=${cyclic} grouped=${grouped.has(id)}`)
      cyclicSeen[cyclic ? 'yes' : 'no'] += 1
    }

    for (const group of groups) {
      // Every member reaches every other member: that is what a group claims.
      for (const member of group.members) {
        const reaches = reachableFrom(member, adjacency)
        for (const other of group.members) {
          if (other === member) continue
          assert.ok(reaches.has(other), `seed ${seed}: ${member} does not reach ${other}`)
        }
      }
      // And the witness really is a cycle in the graph it came from.
      const walk = [...group.cycle, group.cycle[0]]
      for (let step = 0; step + 1 < walk.length; step += 1) {
        assert.ok(adjacency.get(walk[step]).includes(walk[step + 1]), `seed ${seed}: ${walk[step]} -> ${walk[step + 1]} is not an edge`)
      }
      assert.ok(group.cycle.every((id) => group.members.includes(id)), `seed ${seed}: witness leaves the group`)
      witnessesChecked += 1
    }
  }

  // The companion to the assertions above: a sweep over graphs that happened to
  // be all acyclic, or that produced no groups, would pass having checked
  // nothing.
  assert.ok(cyclicSeen.yes > 500, `only ${cyclicSeen.yes} cyclic metric(s) were generated`)
  assert.ok(cyclicSeen.no > 500, `only ${cyclicSeen.no} acyclic metric(s) were generated`)
  assert.ok(witnessesChecked > 300, `only ${witnessesChecked} witness cycle(s) were checked`)
})
