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
 */

import { byCodeUnit } from './text.mjs'

/**
 * Every elementary cycle reachable in `edges`, each reported once.
 *
 * `edges` is `id -> string[]`, and every target must be a key of `edges`;
 * being handed an edge that leaves the index is a programming error here and
 * throws, because silently tolerating it is the exact failure this module
 * refuses to take part in.
 *
 * Returns an array of cycles, each an array of ids in traversal order, rotated
 * to start at the member that sorts first by code unit so that the same graph
 * always produces the same sentence.
 */
export function findCycles(edges) {
  const ids = [...edges.keys()].sort(byCodeUnit)
  for (const [id, targets] of edges) {
    for (const target of targets) {
      if (!edges.has(target)) throw new Error(`findCycles was given an edge from ${id} to an id outside the index`)
    }
  }

  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const colour = new Map(ids.map((id) => [id, WHITE]))
  const seen = new Set()
  const cycles = []

  for (const root of ids) {
    if (colour.get(root) !== WHITE) continue
    // An explicit stack of (node, next edge index) frames. `path` is the grey
    // chain from the root, which is what makes a back edge a cycle.
    const stack = [{ id: root, at: 0 }]
    const path = [root]
    const positionInPath = new Map([[root, 0]])
    colour.set(root, GREY)

    while (stack.length > 0) {
      const frame = stack.at(-1)
      const targets = edges.get(frame.id)
      if (frame.at < targets.length) {
        const next = targets[frame.at]
        frame.at += 1
        const state = colour.get(next)
        if (state === GREY) {
          const cycle = path.slice(positionInPath.get(next))
          // Rotate to a canonical start so the same cycle found from two roots
          // is recognised as one cycle and always reads the same way.
          let start = 0
          for (let index = 1; index < cycle.length; index += 1) {
            if (byCodeUnit(cycle[index], cycle[start]) < 0) start = index
          }
          const rotated = [...cycle.slice(start), ...cycle.slice(0, start)]
          const key = JSON.stringify(rotated)
          if (!seen.has(key)) {
            seen.add(key)
            cycles.push(rotated)
          }
        } else if (state === WHITE) {
          colour.set(next, GREY)
          positionInPath.set(next, path.length)
          path.push(next)
          stack.push({ id: next, at: 0 })
        }
      } else {
        colour.set(frame.id, BLACK)
        positionInPath.delete(frame.id)
        path.pop()
        stack.pop()
      }
    }
  }

  // Sort by first member, then by length, then by the whole path: two graphs
  // that differ only in declaration order produce the same report.
  cycles.sort((left, right) => byCodeUnit(left[0], right[0])
    || left.length - right.length
    || byCodeUnit(left.join('>'), right.join('>')))
  return cycles
}
