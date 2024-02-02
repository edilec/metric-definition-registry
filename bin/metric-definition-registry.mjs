#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_LIMITS, SUPPORTED_AGGREGATIONS,
  ConfigError, checkRegistry, excerpt, exitCodeFor, formatReport, serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `metric-definition-registry

Validate a registry of metric definitions -- formula, grain, filters, unit,
aggregation, owner and semantic dependencies -- and compare it with the
registry that came before.

Reads one JSON document, or two when --previous is given, and nothing else. It
connects to no warehouse, resolves no host, runs no query, evaluates no formula
and reads no clock. A formula and a filter expression are opaque text here:
they are compared, never parsed.

Aggregations this tool understands: ${SUPPORTED_AGGREGATIONS.join(', ')}.
"custom" is the honest escape hatch -- it declares that the aggregation is
something this tool cannot interpret, rather than implying that it can.

Two things this tool will not do, because both would be inventions:

  It does not infer a unit, an aggregation or a dependency list. A definition
  that does not declare one is reported and the run is incomplete. In
  particular, an absent "dependsOn" is NOT read as "depends on nothing".

  It does not report how many cyclic groups a graph has when an edge leaves
  the registry. That count over a pruned graph would be a conclusion drawn
  from evidence that was discarded, so it is withheld and the report says the
  graph is not known to be acyclic. The groups the resolved edges PROVE are
  still reported -- adding edges can never destroy a cycle -- and each says
  "at least N metrics" and that the group may be larger.

What a cycle finding names is a GROUP of metrics that all depend on each other,
with one witness cycle through it. Every group is reported, each once, and every
metric that takes part in any cycle is named in exactly one of them. Enumerating
every elementary cycle is not offered: that count is exponential in the number
of metrics, so it cannot be produced inside a memory bound derived from the
input size.

Usage:
  metric-definition-registry --root DIR --registry FILE [--previous FILE]
                             [--json] [limits]

Options:
  --root DIR                 Directory holding the registry documents (required)
  --registry FILE            The registry to validate, relative to --root (required)
  --previous FILE            The registry that came before, relative to --root.
                             Without it no comparison is made, and the report
                             says so rather than reporting that nothing changed
  --json                     Suppress the human summary on stderr

Limits (documents that could not be read completely, reported -- never silently
truncated, never a pass):
  --max-document-bytes N     Maximum size of either registry (default ${DEFAULT_LIMITS.maxDocumentBytes})
  --max-field-length N       Maximum characters in any one string field
                             (default ${DEFAULT_LIMITS.maxFieldLength})
  --max-findings N           Maximum findings in one report (default ${DEFAULT_LIMITS.maxFindings})
  --max-list-entries N       Maximum entries in one grain, filters or dependsOn
                             list (default ${DEFAULT_LIMITS.maxListEntries})
  --max-metrics N            Maximum definitions in one registry (default ${DEFAULT_LIMITS.maxMetrics})
  -h, --help                 Show this help
  -v, --version              Show the version

Every option that carries a value may be given once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused, and
so is an unknown field in a registry document.

This tool writes nothing. It has no --out, creates no directory and modifies no
file, so no destination check applies to it. Both registries are confined to
--root and a symbolic link out of that root is refused.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

Where the line falls between exit 1 and exit 2:
  A dependency cycle, a name two definitions disagree about, and a definition
  changed without moving its definitionVersion are facts about documents that
  were read completely, and they fail (exit 1). A document this tool could not
  read, a definition that did not declare its unit, aggregation or
  dependencies, and a dependency pointing outside the registry are evidence it
  does not have -- that is incomplete (exit 2), never a pass.

Exit codes:
  0  the registry was read completely and no error-severity rule fired
  1  the registry was read completely and at least one error-severity rule fired
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const VALUE_FLAGS = new Map([
  ['--root', 'root'],
  ['--registry', 'registry'],
  ['--previous', 'previous'],
])

const LIMIT_FLAGS = new Map([
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-field-length', 'maxFieldLength'],
  ['--max-findings', 'maxFindings'],
  ['--max-list-entries', 'maxListEntries'],
  ['--max-metrics', 'maxMetrics'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, registry: null, previous: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag carrying a value is accepted once. Letting it repeat discards the
   * earlier value with no diagnostic, so `--previous a.json --previous b.json`
   * would compare against a registry nobody asked about.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once(argument)
      options.json = true
    } else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else {
      // argv is the one untrusted string that reaches a stream without passing
      // through a finding, so it is flattened exactly as a finding would be.
      throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
    }
  }

  if (options.root === null) throw new Error('--root is required')
  if (options.registry === null) throw new Error('--registry is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await checkRegistry({
      root: options.root,
      registry: options.registry,
      previous: options.previous,
      limits: options.limits,
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty rather
    // than carrying a fabricated report.
    const message = error instanceof ConfigError ? error.message : `unexpected failure: ${error.message}`
    process.stderr.write(`${excerpt(message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  if (report.status === 'incomplete') {
    process.stderr.write('incomplete: this run is not a pass. Part of the registry was never evaluated.\n')
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
