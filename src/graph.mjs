/**
 * Dependency graph analysis over a COMPLETE index, and nothing else.
 *
 * The one rule this module exists to enforce: it is only ever asked about a
 * graph whose every edge landed on a metric in the index. An edge pointing at
 * an id nobody declared is not dropped here and it is not dropped by the
 * caller either -- the caller refuses to run this analysis at all, because a
 * cycle search over an index with edges removed can only ever report "no
 * cycles", and reporting that would be asserting a fact from evidence that was
 * thrown away.
 *
 * Detection is iterative rather than recursive: a registry is an export, its
 * depth is whatever somebody wrote, and a recursive walk would turn a deep
 * chain into a stack overflow -- which is an exit code outside this tool's
 * contract rather than a finding.
 *
 * WHAT IS REPORTED, AND WHY IT IS NOT "EVERY ELEMENTARY CYCLE"
 *
 * This module used to claim "every elementary cycle reachable in `edges`, each
 * reported once" and deliver neither. Its colour-marked search recorded a back
 * edge only to a node still on the current path, so a cycle whose entry node
 * had already gone black was never seen: `a -> [b, c]`, `b -> [c]`, `c -> [a]`
 * holds two elementary cycles, `a -> b -> c -> a` and `a -> c -> a`, and the
 * search found one. `summary.cyclesFound` was an exact integer that undercounted.
 *
 * Making that claim true is not the fix, because it cannot be made true inside
 * a memory bound derived from the input size. The number of elementary cycles
 * is exponential in the number of metrics -- a registry of 4880 definitions
 * with fourteen dependencies each, legal on every documented bound at
 * 1,045,409 bytes, drove the old undercounting search to 3.2 GB of resident
 * memory and 504 seconds on the machine this was measured on, against a README
 * that promises a legal-sized input cannot exhaust memory. Bounding the
 * enumeration instead would make a registry that is merely large report
 * `incomplete` for a question whose actionable answer is available in linear
 * time.
 *
 * So the unit reported is the one a reader has to act on anyway: a **cyclic
 * group**, a set of metrics that all depend on each other, none of which can
 * ever be computed. That is a strongly connected component with more than one
 * member, or a single metric that depends on itself. Every such group is found,
 * each exactly once, in time and memory linear in the size of the graph, and
 * every metric that takes part in any cycle is named in exactly one of them.
 * Each group carries one witness cycle so a reader has somewhere to start.
 */

import { byCodeUnit } from './text.mjs'

/**
 * `id -> targets`, deduplicated and sorted by code unit.
 *
 * Ordering is part of the output contract: the witness cycle below is chosen by
 * walking this adjacency, so two registries that differ only in the order their
 * dependencies were written must produce the same sentence. Duplicates are
 * removed because a list naming the same dependency twice is one edge; the
 * duplicate itself is reported separately by the caller.
 */
function adjacencyOf(edges) {
  const adjacency = new Map()
  for (const [id, targets] of edges) {
    for (const target of targets) {
      if (!edges.has(target)) throw new Error(`findCyclicGroups was given an edge from ${id} to an id outside the index`)
    }
    adjacency.set(id, [...new Set(targets)].sort(byCodeUnit))
  }
  return adjacency
}

/**
 * Tarjan's strongly connected components, with an explicit frame stack.
 *
 * Components come back in the order Tarjan closes them, which is not a
 * documented order; the caller sorts. Every id appears in exactly one.
 */
function stronglyConnectedComponents(ids, adjacency) {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const open = []
  const components = []
  let next = 0

  const discover = (id) => {
    index.set(id, next)
    low.set(id, next)
    next += 1
    open.push(id)
    onStack.add(id)
  }

  for (const root of ids) {
    if (index.has(root)) continue
    discover(root)
    const frames = [{ id: root, at: 0 }]

    while (frames.length > 0) {
      const frame = frames.at(-1)
      const targets = adjacency.get(frame.id)
      if (frame.at < targets.length) {
        const target = targets[frame.at]
        frame.at += 1
        if (!index.has(target)) {
          discover(target)
          frames.push({ id: target, at: 0 })
        } else if (onStack.has(target)) {
          low.set(frame.id, Math.min(low.get(frame.id), index.get(target)))
        }
        continue
      }

      frames.pop()
      if (frames.length > 0) {
        const parent = frames.at(-1).id
        low.set(parent, Math.min(low.get(parent), low.get(frame.id)))
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const component = []
        let member
        do {
          member = open.pop()
          onStack.delete(member)
          component.push(member)
        } while (member !== frame.id)
        components.push(component)
      }
    }
  }

  return components
}

/**
 * One cycle through `start`, as short as this graph allows, inside `members`.
 *
 * Breadth first, over an adjacency already sorted by code unit, so the witness
 * is the same for two registries that differ only in declaration order. A self
 * dependency is the shortest cycle there is and is answered directly.
 */
function witnessCycle(start, members, adjacency) {
  if (adjacency.get(start).includes(start)) return [start]

  const inside = new Set(members)
  const cameFrom = new Map([[start, null]])
  const queue = [start]
  for (let at = 0; at < queue.length; at += 1) {
    const node = queue[at]
    for (const target of adjacency.get(node)) {
      if (!inside.has(target)) continue
      if (target === start) {
        const path = []
        for (let step = node; step !== null; step = cameFrom.get(step)) path.push(step)
        return path.reverse()
      }
      if (cameFrom.has(target)) continue
      cameFrom.set(target, node)
      queue.push(target)
    }
  }

  // Unreachable: every member of a strongly connected component of two or more
  // members reaches every other member, so the search above always meets an
  // edge back to `start`. Reaching here would mean this function was handed a
  // set that is not strongly connected, which is a defect in this module and
  // not a fact about any registry -- so it says that, rather than inventing a
  // cycle or returning a group with no witness.
  throw new Error(`witnessCycle was given a set around ${start} that is not strongly connected`)
}

/**
 * Every cyclic group in `edges`, each reported once.
 *
 * `edges` is `id -> string[]`, and every target must be a key of `edges`; being
 * handed an edge that leaves the index is a programming error here and throws,
 * because silently tolerating it is the exact failure this module refuses to
 * take part in.
 *
 * A group is `{ members, cycle }`. `members` is every metric in one strongly
 * connected component of two or more metrics, or the one metric that depends on
 * itself, sorted by code unit. `cycle` is one witness cycle through the member
 * that sorts first, so the same graph always produces the same sentence.
 * Groups are sorted by their first member.
 *
 * A metric that is in no cycle is in no group: a component of one metric with
 * no self dependency is not cyclic.
 */
export function findCyclicGroups(edges) {
  const adjacency = adjacencyOf(edges)
  const ids = [...edges.keys()].sort(byCodeUnit)
  const groups = []

  for (const component of stronglyConnectedComponents(ids, adjacency)) {
    const members = [...component].sort(byCodeUnit)
    const cyclic = members.length > 1 || adjacency.get(members[0]).includes(members[0])
    if (!cyclic) continue
    groups.push({ members, cycle: witnessCycle(members[0], members, adjacency) })
  }

  groups.sort((left, right) => byCodeUnit(left.members[0], right.members[0]))
  return groups
}
