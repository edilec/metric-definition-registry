/**
 * metric-definition-registry -- validate a registry of metric definitions and
 * compare it with the registry that came before.
 *
 * What this tool sees is one or two JSON documents somebody exported. It
 * connects to no warehouse, resolves no host, runs no query, evaluates no
 * formula and reads no clock. A formula and a filter are opaque text here:
 * they are compared, never parsed. Every sentence in the report is a sentence
 * about those documents.
 *
 * Two rules the design turns on:
 *
 * 1. Explicit or unknown. A definition that does not declare its unit, its
 *    aggregation or its dependencies is not completed with a default; it is
 *    reported and the run is `incomplete`.
 * 2. A graph with a dangling edge is not an acyclic graph. An unresolved
 *    dependency is not dropped so the cycle search can finish -- the search is
 *    refused, and the report says the graph is not known to be acyclic.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

import { findCycles } from './graph.mjs'
import {
  byCodeUnit, decodeUtf8, excerpt, isPlainObject, isUsableText, parseFailureDetail,
} from './text.mjs'

export { byCodeUnit, excerpt, isUsableText, parseFailureDetail, renderable } from './text.mjs'
export { findCycles } from './graph.mjs'

/** Equal to the directory and package name. A test asserts that, in both directions. */
export const TOOL_ID = 'metric-definition-registry'

/** The report envelope version from the Edilec tool report contract. */
export const SCHEMA_VERSION = '1'

/** Registry document versions this tool understands. Anything else is unknown, not assumed. */
export const SUPPORTED_REGISTRY_VERSIONS = Object.freeze(['1'])

/**
 * Aggregations this tool understands, and `custom` for the ones it does not.
 *
 * The vocabulary is closed on purpose: "units and aggregation are explicit"
 * means a reader of the registry can tell what the number is, and a free-text
 * aggregation is a field that looks declared and says nothing. `custom` is the
 * escape hatch, and it is honest -- it declares that the aggregation is
 * something this tool cannot interpret, rather than implying that it can.
 */
export const SUPPORTED_AGGREGATIONS = Object.freeze([
  'avg', 'count', 'count_distinct', 'custom', 'first', 'last', 'max', 'median', 'min', 'percentile', 'ratio', 'sum',
])

/**
 * Limits, enforced BEFORE the work they bound rather than after it.
 *
 * `maxDocumentBytes` is checked against the file size from `stat` before a byte
 * is read and against the buffer after, so a file that grows between the two
 * cannot slip past. `maxMetrics` and `maxListEntries` are checked against
 * declared lengths before any element is examined. A legal-sized input cannot
 * exhaust memory, and the cycle search is iterative, so a deep dependency
 * chain cannot exhaust the stack either.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDocumentBytes: 1048576,
  maxMetrics: 5000,
  maxListEntries: 50,
  maxFieldLength: 400,
  maxFindings: 1000,
})

/**
 * One frozen ruleId -> severity table. Severity decides the exit code, so it is
 * never written at a construction site: `finding()` reads it here and throws on
 * an id that is not in the table.
 *
 * The comparison ids carry `-declared` or `-undeclared`, which is the whole
 * point of a registry having versions: changing what a metric means is
 * ordinary work, and doing it without moving `definitionVersion` is what makes
 * yesterday's number and today's number incomparable while both claim to be
 * the same metric at the same version.
 */
const RULE_SEVERITY = Object.freeze({
  'aggregation-changed-declared': 'info',
  'aggregation-changed-undeclared': 'error',
  'aggregation-undeclared': 'error',
  'aggregation-unsupported': 'error',
  'dependencies-changed-declared': 'info',
  'dependencies-changed-undeclared': 'error',
  'dependencies-undeclared': 'error',
  'dependency-cycle': 'error',
  'dependency-duplicate': 'warning',
  'dependency-unresolved': 'error',
  'filters-changed-declared': 'info',
  'filters-changed-undeclared': 'error',
  'formula-changed-declared': 'info',
  'formula-changed-undeclared': 'error',
  'grain-changed-declared': 'info',
  'grain-changed-undeclared': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'metric-added': 'info',
  'metric-id-duplicate': 'error',
  'metric-invalid': 'error',
  'metric-removed': 'error',
  'metric-unknown-field': 'error',
  'name-aggregation-conflict': 'error',
  'name-changed-declared': 'info',
  'name-changed-undeclared': 'error',
  'name-grain-conflict': 'error',
  'name-reused': 'warning',
  'name-unit-conflict': 'error',
  'no-metrics-declared': 'error',
  'owner-changed': 'info',
  'path-escapes-root': 'error',
  'registry-invalid': 'error',
  'registry-unknown-field': 'error',
  'registry-version-unsupported': 'error',
  'too-many-findings': 'error',
  'too-many-list-entries': 'error',
  'too-many-metrics': 'error',
  'unit-changed-declared': 'info',
  'unit-changed-undeclared': 'error',
  'unit-undeclared': 'error',
})

/**
 * The rules that mean evidence was missing, unreadable or unusable.
 *
 * Any one of them makes the report `incomplete`, which exits 2. Status is
 * derived from this set rather than assigned at each site, so there is no
 * `incomplete = true` line to delete: removing an id from this freeze is the
 * mutation, and every id here has a test that drives it through the real entry
 * point and asserts exit 2.
 *
 * `dependency-cycle` and the name conflicts are deliberately NOT here. They are
 * facts about a registry that was read completely, so they fail (exit 1).
 */
const INCOMPLETE_RULES = Object.freeze(new Set([
  'aggregation-undeclared',
  'aggregation-unsupported',
  'dependencies-undeclared',
  'dependency-unresolved',
  'input-not-json',
  'input-not-utf8',
  'input-too-large',
  'input-unreadable',
  'metric-id-duplicate',
  'metric-invalid',
  'metric-unknown-field',
  'no-metrics-declared',
  'path-escapes-root',
  'registry-invalid',
  'registry-unknown-field',
  'registry-version-unsupported',
  'too-many-findings',
  'too-many-list-entries',
  'too-many-metrics',
  'unit-undeclared',
]))

/** The catalogue, exported so docs and tests can be checked against it in both directions. */
export const RULE_CATALOG = Object.freeze(
  Object.keys(RULE_SEVERITY).sort(byCodeUnit).map((ruleId) => Object.freeze({
    ruleId,
    severity: RULE_SEVERITY[ruleId],
    incomplete: INCOMPLETE_RULES.has(ruleId),
  })),
)

const MESSAGE_LIMIT = 400
const LOCATION_LIMIT = 200
const EVIDENCE_LIMIT = 160
const SUGGESTION_LIMIT = 300

/** A configuration error: the run never had a subject, so stdout stays empty. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function finding({ ruleId, file, pointer = '', message, evidence, suggestion }) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`No severity is declared for rule "${ruleId}"`)
  const built = {
    ruleId,
    severity,
    message: excerpt(message, MESSAGE_LIMIT),
    location: { file: excerpt(file, LOCATION_LIMIT), pointer: excerpt(pointer, LOCATION_LIMIT) },
  }
  if (evidence !== undefined) built.evidence = excerpt(evidence, EVIDENCE_LIMIT)
  if (suggestion !== undefined) built.suggestion = excerpt(suggestion, SUGGESTION_LIMIT)
  return built
}

function normaliseLimits(given) {
  if (!isPlainObject(given)) throw new ConfigError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(given)) {
    // A typo in a limit name must not silently restore the default: that is how
    // a documented limit becomes a limit nobody enforces.
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new ConfigError(`Unknown limit "${excerpt(key, 60)}"`)
    if (!Number.isInteger(value) || value < 1) throw new ConfigError(`Limit "${key}" must be a positive integer`)
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * Resolve one input path inside the declared root.
 *
 * Two checks, because neither covers the other. The lexical one refuses an
 * absolute path and a `..` segment, which keeps an obvious escape out of the
 * report's `location.file`. The real one resolves symbolic links and asserts
 * the result is inside the resolved root, because a symlink planted inside a
 * root is not refused by any amount of string inspection.
 */
async function resolveInside(realRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return { ok: false, reason: 'not-a-path' }
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) return { ok: false, reason: 'escapes-root' }
  const candidate = resolve(realRoot, relativePath)
  let real
  try {
    real = await realpath(candidate)
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, reason: 'escapes-root' }
  return { ok: true, path: real }
}

/** Read, decode and parse one registry document. Never throws for a bad input. */
async function loadRegistry(realRoot, relativePath, limits) {
  const located = await resolveInside(realRoot, relativePath)
  if (!located.ok) {
    if (located.reason === 'escapes-root') {
      return {
        ok: false,
        problem: finding({
          ruleId: 'path-escapes-root',
          file: relativePath,
          message: 'the path resolves outside the declared root, so it was not read',
          suggestion: 'name a registry inside --root; a symbolic link out of the root does not widen it',
        }),
      }
    }
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-unreadable',
        file: relativePath,
        message: `the registry could not be opened (${located.reason === 'missing' ? 'ENOENT' : located.code ?? 'unknown error'})`,
      }),
    }
  }

  // The size bound is checked before a byte is read, and again after, because a
  // file can grow between the two calls.
  let size
  try {
    size = (await stat(located.path)).size
  } catch (error) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-unreadable',
        file: relativePath,
        message: `the registry could not be inspected (${error.code ?? 'unknown error'})`,
      }),
    }
  }
  if (size > limits.maxDocumentBytes) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-too-large',
        file: relativePath,
        message: `the registry is ${size} bytes, over the ${limits.maxDocumentBytes} byte limit, so it was not read`,
        suggestion: 'raise --max-document-bytes deliberately, or split the registry',
      }),
    }
  }

  let bytes
  try {
    bytes = await readFile(located.path)
  } catch (error) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-unreadable',
        file: relativePath,
        message: `the registry could not be read (${error.code ?? 'unknown error'})`,
      }),
    }
  }
  if (bytes.byteLength > limits.maxDocumentBytes) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-too-large',
        file: relativePath,
        message: `the registry is ${bytes.byteLength} bytes, over the ${limits.maxDocumentBytes} byte limit`,
      }),
    }
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-not-utf8',
        file: relativePath,
        message: 'the registry is not valid UTF-8, so it was not decoded',
      }),
    }
  }

  try {
    return { ok: true, document: JSON.parse(decoded.text) }
  } catch (error) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-not-json',
        file: relativePath,
        // parseFailureDetail describes the failure without quoting the
        // document: V8's own message embeds the offending input.
        message: `the registry is not valid JSON: ${parseFailureDetail(error)}`,
      }),
    }
  }
}

const REGISTRY_FIELDS = Object.freeze(['registryVersion', 'metrics'])
const METRIC_FIELDS = Object.freeze([
  'id', 'name', 'grain', 'aggregation', 'unit', 'formula', 'filters', 'owner', 'dependsOn', 'definitionVersion', 'description',
])

const escapeSegment = (segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1')

/** Validate one list field: an array of usable strings, within the declared bound. */
function validateList(value, { pointer, limits, add, what }) {
  if (!Array.isArray(value)) {
    add({ ruleId: 'metric-invalid', pointer, message: `${what} must be an array of strings, declared explicitly` })
    return null
  }
  if (value.length > limits.maxListEntries) {
    add({
      ruleId: 'too-many-list-entries',
      pointer,
      message: `${what} declares ${value.length} entries, over the ${limits.maxListEntries} entry limit, so none of them were examined`,
      suggestion: 'raise --max-list-entries deliberately',
    })
    return null
  }
  const entries = []
  let usable = true
  for (const [position, entry] of value.entries()) {
    if (!isUsableText(entry, limits.maxFieldLength)) {
      add({
        ruleId: 'metric-invalid',
        pointer: `${pointer}/${position}`,
        message: `every entry in ${what} must be a non-empty string of at most ${limits.maxFieldLength} characters that is still non-empty once control characters are removed`,
      })
      usable = false
      continue
    }
    entries.push(entry)
  }
  return usable ? entries : null
}

/**
 * Validate one registry and build its index by metric id.
 *
 * Returns the index only when NOTHING was dropped. A definition this function
 * could not read is not skipped over: the registry is reported unusable and no
 * graph search and no comparison is attempted against it. The alternative --
 * indexing what parsed and analysing that -- is how a cycle search comes to
 * report "no cycles" over a graph half of which was discarded.
 */
function validateRegistry(document, file, limits) {
  const problems = []
  const add = (options) => problems.push(finding({ file, ...options }))

  if (!isPlainObject(document)) {
    add({ ruleId: 'registry-invalid', message: 'the registry must be a JSON object' })
    return { ok: false, problems }
  }
  for (const key of Object.keys(document)) {
    if (!REGISTRY_FIELDS.includes(key)) {
      add({
        ruleId: 'registry-unknown-field',
        pointer: `/${escapeSegment(key)}`,
        message: `the registry declares "${excerpt(key, 60)}", which this tool does not understand, so it cannot claim to have read the registry completely`,
        suggestion: `registry fields are ${REGISTRY_FIELDS.join(', ')}`,
      })
    }
  }
  if (!SUPPORTED_REGISTRY_VERSIONS.includes(document.registryVersion)) {
    add({
      ruleId: 'registry-version-unsupported',
      pointer: '/registryVersion',
      message: `registryVersion must be one of ${SUPPORTED_REGISTRY_VERSIONS.join(', ')}; this document declares ${JSON.stringify(excerpt(document.registryVersion, 40))}`,
    })
  }
  if (!Array.isArray(document.metrics)) {
    add({ ruleId: 'registry-invalid', pointer: '/metrics', message: 'metrics must be an array' })
    return { ok: false, problems }
  }
  // Bound checked against the declared length before any definition is read.
  if (document.metrics.length > limits.maxMetrics) {
    add({
      ruleId: 'too-many-metrics',
      pointer: '/metrics',
      message: `the registry declares ${document.metrics.length} metrics, over the ${limits.maxMetrics} metric limit, so none of them were validated`,
      suggestion: 'raise --max-metrics deliberately',
    })
    return { ok: false, problems }
  }
  if (document.metrics.length === 0) {
    add({
      ruleId: 'no-metrics-declared',
      pointer: '/metrics',
      message: 'the registry declares no metrics, so there is nothing to validate and a clean result would mean nothing',
    })
  }

  const index = new Map()
  for (const [position, raw] of document.metrics.entries()) {
    const pointer = `/metrics/${position}`
    if (!isPlainObject(raw)) {
      add({ ruleId: 'metric-invalid', pointer, message: 'a metric definition must be a JSON object' })
      continue
    }
    // Any problem at all means this definition is not indexed -- including an
    // unknown field, which is a definition this tool cannot claim to have read.
    // The flag this replaces had to be set at nine separate sites, and
    // forgetting one would put a definition the tool could not read into the
    // index under an id it is not sure of, where a later duplicate of that id
    // would then be reported twice over.
    const problemsBefore = problems.length
    for (const key of Object.keys(raw)) {
      if (!METRIC_FIELDS.includes(key)) {
        add({
          ruleId: 'metric-unknown-field',
          pointer: `${pointer}/${escapeSegment(key)}`,
          message: `the definition declares "${excerpt(key, 60)}", which this tool does not understand`,
          suggestion: `definition fields are ${METRIC_FIELDS.join(', ')}`,
        })
      }
    }

    for (const key of ['id', 'name', 'formula', 'owner', 'definitionVersion']) {
      if (!isUsableText(raw[key], limits.maxFieldLength)) {
        add({
          ruleId: 'metric-invalid',
          pointer: `${pointer}/${key}`,
          message: `${key} must be a non-empty string of at most ${limits.maxFieldLength} characters that is still non-empty once control characters are removed`,
        })
      }
    }
    if (raw.description !== undefined && !isUsableText(raw.description, limits.maxFieldLength)) {
      add({ ruleId: 'metric-invalid', pointer: `${pointer}/description`, message: 'description, when present, must be a usable string' })
    }

    // Units and aggregation are explicit or they are unknown. Neither is
    // defaulted: a metric whose unit nobody wrote down is a number nobody can
    // read, and filling one in here would be inventing it.
    if (!isUsableText(raw.unit, limits.maxFieldLength)) {
      add({
        ruleId: 'unit-undeclared',
        pointer: `${pointer}/unit`,
        message: 'unit must be declared as a non-empty string; this tool does not infer one from the formula',
        suggestion: 'declare the unit the numbers are in, for example "EUR", "orders" or "ratio"',
      })
    }
    if (!isUsableText(raw.aggregation, limits.maxFieldLength)) {
      add({
        ruleId: 'aggregation-undeclared',
        pointer: `${pointer}/aggregation`,
        message: 'aggregation must be declared as a non-empty string; this tool does not infer one from the formula',
        suggestion: `declare one of ${SUPPORTED_AGGREGATIONS.join(', ')}`,
      })
    } else if (!SUPPORTED_AGGREGATIONS.includes(raw.aggregation)) {
      add({
        ruleId: 'aggregation-unsupported',
        pointer: `${pointer}/aggregation`,
        message: `aggregation ${JSON.stringify(excerpt(raw.aggregation, 40))} is not one of ${SUPPORTED_AGGREGATIONS.join(', ')}; this tool does not guess what an aggregation it has not been taught computes`,
        suggestion: 'declare "custom" if the aggregation is genuinely outside this vocabulary',
      })
    }

    // `grain === null` means an entry was unusable, and the duplicate check is
    // deliberately skipped then: judging a list with entries removed would
    // report a duplicate the document does not contain.
    const grain = validateList(raw.grain, { pointer: `${pointer}/grain`, limits, add, what: 'grain' })
    if (grain !== null && new Set(grain).size !== grain.length) {
      add({ ruleId: 'metric-invalid', pointer: `${pointer}/grain`, message: 'grain declares the same dimension more than once' })
    }

    const filters = raw.filters === undefined
      ? []
      : validateList(raw.filters, { pointer: `${pointer}/filters`, limits, add, what: 'filters' })

    let dependsOn = null
    if (raw.dependsOn === undefined) {
      // An absent list is not an empty list. "This metric depends on nothing"
      // is a claim somebody has to make; assuming it would let a registry that
      // never declared its edges be reported as an acyclic graph.
      add({
        ruleId: 'dependencies-undeclared',
        pointer: `${pointer}/dependsOn`,
        message: 'dependsOn must be declared, as [] when the metric depends on no other metric in this registry',
        suggestion: 'declare "dependsOn": [] explicitly',
      })
    } else {
      dependsOn = validateList(raw.dependsOn, { pointer: `${pointer}/dependsOn`, limits, add, what: 'dependsOn' })
    }

    if (problems.length > problemsBefore) continue

    if (index.has(raw.id)) {
      // A duplicate id makes the index ambiguous. Keeping the last entry would
      // silently drop the first and then analyse a registry nobody wrote.
      add({
        ruleId: 'metric-id-duplicate',
        pointer: `${pointer}/id`,
        message: `the metric id ${JSON.stringify(excerpt(raw.id, 60))} is declared more than once, so an index by id is ambiguous`,
      })
      continue
    }
    index.set(raw.id, {
      id: raw.id,
      name: raw.name,
      grain,
      aggregation: raw.aggregation,
      unit: raw.unit,
      formula: raw.formula,
      filters,
      owner: raw.owner,
      dependsOn,
      definitionVersion: raw.definitionVersion,
      position,
    })
  }

  const ok = problems.length === 0
  return ok ? { ok, problems, index, order: [...index.keys()], document } : { ok, problems }
}

/** A grain or a dependency set, rendered in one canonical order for comparison. */
const asSet = (entries) => [...entries].sort(byCodeUnit).join(', ')

/**
 * Analyse one complete registry: name conflicts, duplicate edges, and -- only
 * when every edge resolves -- dependency cycles.
 */
function analyseRegistry(registry, file) {
  const findings = []
  const add = (options) => findings.push(finding({ file, ...options }))
  const ids = [...registry.order].sort(byCodeUnit)

  // Name conflicts. A name is how a metric is cited in a dashboard, a ticket
  // and a conversation; two definitions answering to one name must agree about
  // what the number is, or nobody can tell which one was meant.
  const byName = new Map()
  for (const id of ids) {
    const metric = registry.index.get(id)
    if (!byName.has(metric.name)) byName.set(metric.name, [])
    byName.get(metric.name).push(metric)
  }
  let namesSharedBySeveralMetrics = 0
  for (const name of [...byName.keys()].sort(byCodeUnit)) {
    const metrics = byName.get(name)
    if (metrics.length < 2) continue
    namesSharedBySeveralMetrics += 1
    const [first, ...rest] = metrics
    let conflicted = false
    for (const other of rest) {
      const pointer = `/metrics/${other.position}`
      if (asSet(first.grain) !== asSet(other.grain)) {
        conflicted = true
        add({
          ruleId: 'name-grain-conflict',
          pointer,
          message: `${JSON.stringify(excerpt(name, 60))} is defined by ${JSON.stringify(excerpt(first.id, 40))} at grain (${excerpt(asSet(first.grain), 60) || 'none'}) and by ${JSON.stringify(excerpt(other.id, 40))} at grain (${excerpt(asSet(other.grain), 60) || 'none'}); one name cannot mean two grains`,
          evidence: `${excerpt(asSet(first.grain), 60) || 'none'} | ${excerpt(asSet(other.grain), 60) || 'none'}`,
          suggestion: 'give the two definitions different names, or put the grain in the name',
        })
      }
      if (first.unit !== other.unit) {
        conflicted = true
        add({
          ruleId: 'name-unit-conflict',
          pointer,
          message: `${JSON.stringify(excerpt(name, 60))} is defined by ${JSON.stringify(excerpt(first.id, 40))} in ${excerpt(first.unit, 40)} and by ${JSON.stringify(excerpt(other.id, 40))} in ${excerpt(other.unit, 40)}`,
          evidence: `${excerpt(first.unit, 60)} | ${excerpt(other.unit, 60)}`,
        })
      }
      if (first.aggregation !== other.aggregation) {
        conflicted = true
        add({
          ruleId: 'name-aggregation-conflict',
          pointer,
          message: `${JSON.stringify(excerpt(name, 60))} is aggregated as ${excerpt(first.aggregation, 30)} by ${JSON.stringify(excerpt(first.id, 40))} and as ${excerpt(other.aggregation, 30)} by ${JSON.stringify(excerpt(other.id, 40))}`,
          evidence: `${excerpt(first.aggregation, 60)} | ${excerpt(other.aggregation, 60)}`,
        })
      }
    }
    if (!conflicted) {
      add({
        ruleId: 'name-reused',
        pointer: `/metrics/${metrics[1].position}`,
        message: `${metrics.length} definitions share the name ${JSON.stringify(excerpt(name, 60))} and agree about grain, unit and aggregation; they are still separate ids, so a consumer citing the name gets no help choosing`,
      })
    }
  }

  // Duplicate edges are harmless to the search and still worth saying: a list
  // that names the same dependency twice is usually an editing accident.
  for (const id of ids) {
    const metric = registry.index.get(id)
    const seen = new Set()
    for (const [position, dependency] of metric.dependsOn.entries()) {
      if (seen.has(dependency)) {
        add({
          ruleId: 'dependency-duplicate',
          pointer: `/metrics/${metric.position}/dependsOn/${position}`,
          message: `${JSON.stringify(excerpt(id, 40))} names ${JSON.stringify(excerpt(dependency, 40))} as a dependency more than once`,
        })
      }
      seen.add(dependency)
    }
  }

  // Unresolved edges. This is the point where the honesty rule bites: the
  // dangling edge is NOT removed so the search can run. The search is refused.
  let graphComplete = true
  for (const id of ids) {
    const metric = registry.index.get(id)
    for (const [position, dependency] of metric.dependsOn.entries()) {
      if (!registry.index.has(dependency)) {
        graphComplete = false
        add({
          ruleId: 'dependency-unresolved',
          pointer: `/metrics/${metric.position}/dependsOn/${position}`,
          message: `${JSON.stringify(excerpt(id, 40))} depends on ${JSON.stringify(excerpt(dependency, 40))}, which this registry does not define; the dependency graph therefore has an edge leaving the evidence and is not known to be acyclic`,
          suggestion: 'define the dependency in this registry, or remove the edge if it belongs to another one',
        })
      }
    }
  }

  let cycles = null
  if (graphComplete) {
    const edges = new Map(ids.map((id) => [id, registry.index.get(id).dependsOn]))
    cycles = findCycles(edges)
    for (const cycle of cycles) {
      const member = registry.index.get(cycle[0])
      const rendered = [...cycle, cycle[0]].map((id) => excerpt(id, 40)).join(' -> ')
      add({
        ruleId: 'dependency-cycle',
        pointer: `/metrics/${member.position}/dependsOn`,
        message: cycle.length === 1
          ? `${JSON.stringify(excerpt(cycle[0], 40))} depends on itself, so it can never be computed`
          : `${cycle.length} metrics depend on each other in a cycle, so none of them can be computed: ${excerpt(rendered, 200)}`,
        evidence: excerpt(rendered, EVIDENCE_LIMIT),
        suggestion: 'break the cycle by making one of these metrics depend on a shared upstream definition instead',
      })
    }
  }

  return { findings, graphComplete, cycles, namesSharedBySeveralMetrics }
}

/** The fields whose change alters what a number means or how it is cited. */
const SEMANTIC_FIELDS = Object.freeze([
  { key: 'name', rule: 'name-changed', render: (metric) => metric.name },
  { key: 'grain', rule: 'grain-changed', render: (metric) => asSet(metric.grain) || 'none' },
  { key: 'aggregation', rule: 'aggregation-changed', render: (metric) => metric.aggregation },
  { key: 'unit', rule: 'unit-changed', render: (metric) => metric.unit },
  { key: 'formula', rule: 'formula-changed', render: (metric) => metric.formula },
  { key: 'filters', rule: 'filters-changed', render: (metric) => metric.filters.join(' AND ') || 'none' },
  { key: 'dependencies', rule: 'dependencies-changed', render: (metric) => asSet(metric.dependsOn) || 'none' },
])

/** The exact value compared for a field. Filters keep their order; sets do not have one. */
function comparableValue(metric, key, render) {
  return key === 'filters' ? JSON.stringify(metric.filters) : render(metric)
}

/**
 * Compare a registry with the one that came before.
 *
 * Grain and dependencies are compared as SETS, because the order of dimensions
 * and of dependencies carries no meaning. Filters are compared as an ORDERED
 * list, because this tool does not parse a filter expression and so cannot know
 * whether their order matters -- so a reordering is reported, and the message
 * says it was a reordering rather than implying the expressions changed.
 */
function compareRegistries(previous, current, files) {
  const findings = []
  const counts = { metricsAdded: 0, metricsRemoved: 0, metricsChanged: 0 }
  const ids = [...new Set([...previous.order, ...current.order])].sort(byCodeUnit)

  for (const id of ids) {
    const was = previous.index.get(id)
    const now = current.index.get(id)

    if (was === undefined) {
      counts.metricsAdded += 1
      findings.push(finding({
        ruleId: 'metric-added',
        file: files.registry,
        pointer: `/metrics/${now.position}`,
        message: `${JSON.stringify(excerpt(id, 60))} is new in this registry`,
      }))
      continue
    }
    if (now === undefined) {
      counts.metricsRemoved += 1
      findings.push(finding({
        ruleId: 'metric-removed',
        file: files.previous,
        pointer: `/metrics/${was.position}`,
        message: `${JSON.stringify(excerpt(id, 60))} was defined and is now gone; anything citing it has no definition to resolve`,
      }))
      continue
    }

    const pointer = `/metrics/${now.position}`
    const declared = was.definitionVersion !== now.definitionVersion
    let changed = false

    for (const field of SEMANTIC_FIELDS) {
      if (comparableValue(was, field.key, field.render) === comparableValue(now, field.key, field.render)) continue
      changed = true
      const reordered = field.key === 'filters' && asSet(was.filters) === asSet(now.filters)
      findings.push(finding({
        ruleId: `${field.rule}-${declared ? 'declared' : 'undeclared'}`,
        file: files.registry,
        pointer,
        message: reordered
          ? `${JSON.stringify(excerpt(id, 60))} lists the same filters in a different order; this tool does not parse a filter expression, so it cannot tell you whether the order matters. definitionVersion ${declared ? 'moved with the change' : 'did not move, so the same version now names two different lists'}`
          : `${JSON.stringify(excerpt(id, 60))} changed ${field.key} from ${excerpt(field.render(was), 60)} to ${excerpt(field.render(now), 60)}. definitionVersion ${declared ? `moved from ${excerpt(was.definitionVersion, 20)} to ${excerpt(now.definitionVersion, 20)}` : `stayed at ${excerpt(now.definitionVersion, 20)}, so the same version now means two different things`}`,
        evidence: `${excerpt(field.render(was), 60)} | ${excerpt(field.render(now), 60)}`,
        suggestion: declared ? undefined : 'move definitionVersion when the definition moves, so a cached number can be matched to the definition that produced it',
      }))
    }

    if (was.owner !== now.owner) {
      findings.push(finding({
        ruleId: 'owner-changed',
        file: files.registry,
        pointer,
        message: `${JSON.stringify(excerpt(id, 60))} changed owner from ${excerpt(was.owner, 60)} to ${excerpt(now.owner, 60)}`,
      }))
    }
    if (changed) counts.metricsChanged += 1
  }

  return { findings, counts, compared: ids.length }
}

/**
 * Validate a metric registry, and compare it with a previous one when given.
 *
 * Throws `ConfigError` for a bad configuration -- the caller writes nothing to
 * stdout and exits 2. Everything else comes back as a report.
 */
export async function checkRegistry(options = {}) {
  if (!isPlainObject(options)) throw new ConfigError('options must be an object')
  const { root, registry, previous = null, limits: givenLimits = {}, ...unknown } = options
  const unknownKeys = Object.keys(unknown)
  if (unknownKeys.length > 0) throw new ConfigError(`Unknown option "${excerpt(unknownKeys[0], 60)}"`)

  const limits = normaliseLimits(givenLimits)
  if (typeof root !== 'string' || root.length === 0) throw new ConfigError('root is required')
  if (typeof registry !== 'string' || registry.length === 0) throw new ConfigError('registry is required')
  if (previous !== null && (typeof previous !== 'string' || previous.length === 0)) {
    throw new ConfigError('previous, when given, must be a path')
  }

  let realRoot
  try {
    realRoot = await realpath(resolve(root))
  } catch (error) {
    throw new ConfigError(`root could not be resolved: ${error.code ?? 'unknown error'}`)
  }

  const files = { registry: excerpt(registry, LOCATION_LIMIT), previous: previous === null ? '' : excerpt(previous, LOCATION_LIMIT) }
  const findings = []

  const loadedCurrent = await loadRegistry(realRoot, registry, limits)
  let current
  if (loadedCurrent.ok) {
    const validated = validateRegistry(loadedCurrent.document, files.registry, limits)
    findings.push(...validated.problems)
    if (validated.ok) current = validated
  } else {
    findings.push({ ...loadedCurrent.problem, location: { ...loadedCurrent.problem.location, file: files.registry } })
  }

  let earlier
  if (previous !== null) {
    const loadedPrevious = await loadRegistry(realRoot, previous, limits)
    if (loadedPrevious.ok) {
      const validated = validateRegistry(loadedPrevious.document, files.previous, limits)
      findings.push(...validated.problems)
      if (validated.ok) earlier = validated
    } else {
      findings.push({ ...loadedPrevious.problem, location: { ...loadedPrevious.problem.location, file: files.previous } })
    }
  }

  let analysis = null
  if (current !== undefined) {
    analysis = analyseRegistry(current, files.registry)
    findings.push(...analysis.findings)
  }

  let comparison = null
  if (current !== undefined && earlier !== undefined) {
    comparison = compareRegistries(earlier, current, files)
    findings.push(...comparison.findings)
  }

  findings.sort((left, right) => byCodeUnit(left.location.file, right.location.file)
    || byCodeUnit(left.location.pointer, right.location.pointer)
    || byCodeUnit(left.ruleId, right.ruleId))

  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length

  let emitted = findings
  if (findings.length > limits.maxFindings) {
    emitted = findings.slice(0, limits.maxFindings - 1)
    emitted.push(finding({
      ruleId: 'too-many-findings',
      file: files.registry,
      message: `${findings.length} findings were produced, over the ${limits.maxFindings} finding limit, so this report lists only the first ${limits.maxFindings - 1}`,
      suggestion: 'raise --max-findings deliberately',
    }))
  }

  // Status is derived from the rule ids, over every finding detected and every
  // finding emitted -- there is no `incomplete = true` line to delete.
  const incomplete = [...findings, ...emitted].some((item) => INCOMPLETE_RULES.has(item.ruleId))
  const failed = errors > 0
  const metrics = current === undefined ? 0 : current.order.length

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    status: incomplete ? 'incomplete' : failed ? 'fail' : 'pass',
    summary: {
      checked: metrics + (comparison === null ? 0 : comparison.compared),
      errors,
      warnings,
      metrics,
      // False means the registry was never validated as a whole, so an empty
      // findings list says nothing about it.
      registryRead: current !== undefined,
      // False means an edge left the evidence. `cyclesFound` is then null: not
      // zero, because zero is a claim and none was earned.
      dependencyGraphComplete: analysis === null ? false : analysis.graphComplete,
      cyclesFound: analysis === null || analysis.cycles === null ? null : analysis.cycles.length,
      namesSharedBySeveralMetrics: analysis === null ? 0 : analysis.namesSharedBySeveralMetrics,
      // False means no previous registry was read, so nothing here is a claim
      // about what changed. Absent history is unknown, not "nothing changed".
      comparedWithPrevious: comparison !== null,
      metricsAdded: comparison === null ? 0 : comparison.counts.metricsAdded,
      metricsRemoved: comparison === null ? 0 : comparison.counts.metricsRemoved,
      metricsChanged: comparison === null ? 0 : comparison.counts.metricsChanged,
    },
    findings: emitted,
  }
}

export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 pass, 1 fail, 2 incomplete. An incomplete run is never a pass. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_MARK = Object.freeze({ error: 'ERROR  ', warning: 'WARN   ', info: 'INFO   ' })

/**
 * The human summary. It goes to stderr; stdout carries the JSON and nothing
 * else.
 *
 * Note what this never says: it calls the graph acyclic only when every edge
 * resolved, and it says nothing at all about what changed unless a previous
 * registry was actually read.
 */
export function formatReport(report) {
  const summary = report.summary
  const lines = [`${TOOL_ID}: ${report.status}`]
  lines.push(`  ${summary.checked} check(s), ${summary.errors} error(s), ${summary.warnings} warning(s)`)
  if (!summary.registryRead) {
    lines.push('  the registry was not read completely, so nothing below is a statement about it as a whole')
  } else {
    lines.push(`  ${summary.metrics} metric definition(s), ${summary.namesSharedBySeveralMetrics} name(s) shared by several definitions`)
    lines.push(summary.dependencyGraphComplete
      ? `  dependency graph: every edge resolves, ${summary.cyclesFound} cycle(s) found`
      : '  dependency graph: at least one edge leaves this registry, so it is NOT known to be acyclic and no cycle search was run')
  }
  lines.push(summary.comparedWithPrevious
    ? `  compared with the previous registry: ${summary.metricsAdded} added, ${summary.metricsRemoved} removed, ${summary.metricsChanged} changed`
    : '  no previous registry was given, so nothing here is a statement about what changed')
  for (const item of report.findings) {
    const where = item.location.pointer === '' ? item.location.file : `${item.location.file}${item.location.pointer}`
    lines.push(`  ${SEVERITY_MARK[item.severity]}${item.ruleId}  ${where}`)
    lines.push(`         ${item.message}`)
  }
  return `${lines.join('\n')}\n`
}
