# metric-definition-registry

Validate a registry of metric definitions — formula, grain, filters, unit,
aggregation, owner and semantic dependencies — and compare it with the registry
that came before. It refuses to call a dependency graph acyclic when one of its
edges leaves the evidence, and it never fills in a unit, an aggregation or a
dependency list that nobody declared.

- **Repository:** [edilec/metric-definition-registry](https://github.com/edilec/metric-definition-registry)
- **Area:** Data & Analytics
- **License:** MIT

## Why this exists

Two dashboards show "revenue" and the numbers differ by four percent. Somebody
spends a day on it and finds that one is daily and one is regional-daily, that
one filters out internal orders and the other does not, and that the formula
changed in March without the version moving — so the cached figures from
February and the live figures from April both claim to be `revenue v2`.

None of that is a bug in a query. It is a registry that let two definitions
answer to one name, and let a definition change underneath its own version
number. Both are visible in the documents, and both are what this tool looks
for.

The third thing it looks for is the one that bites hardest in a semantic layer:
a dependency cycle. A metric defined in terms of another metric that is defined
in terms of the first can never be computed, and the failure shows up as a
timeout or a stack overflow somewhere else entirely.

## What it reads, and what it never does

It reads one JSON document, or two when `--previous` is given. It connects to no
warehouse, resolves no host, runs no query, evaluates no formula and reads no
clock. A formula and a filter expression are **opaque text** here: they are
compared, never parsed.

It writes nothing. There is no `--out`, it creates no directory and it modifies
no file, so no destination check applies to it.

## Quick start

This package is not published to the npm registry. From a checkout of this
repository, run the public fixtures with the checked-in CLI:

```sh
# A registry that is in order, compared with the one before it.
node bin/metric-definition-registry.mjs \
  --root examples/valid \
  --registry metrics.2026-07.json \
  --previous metrics.2026-04.json
# exit 0

# A registry with a name two definitions disagree about and a dependency cycle.
node bin/metric-definition-registry.mjs \
  --root examples/conflicts \
  --registry metrics.json
# exit 1
```

To run it from another project, npm can fetch the public GitHub source directly.
Pass paths from that project's working directory:

```sh
npm exec --yes --package=git+https://github.com/edilec/metric-definition-registry.git -- metric-definition-registry --help
```

`stdout` carries the JSON report and nothing else, so it pipes straight into a
parser. `stderr` carries the human summary; `--json` silences it.

## The registry format

```json
{
  "registryVersion": "1",
  "metrics": [
    {
      "id": "orders_net_daily",
      "name": "net orders",
      "grain": ["date"],
      "aggregation": "sum",
      "unit": "EUR",
      "formula": "orders_gross_daily - sum(refund_total)",
      "filters": ["order_status = 'placed'"],
      "owner": "analytics-platform",
      "dependsOn": ["orders_gross_daily"],
      "definitionVersion": "3"
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The stable identity. Dependencies name this. |
| `name` | yes | How the metric is cited by people and dashboards. |
| `grain` | yes | The dimensions it is defined at, as an array. `[]` is a scalar over the whole dataset, and it is a declared answer. Compared entry by entry, so `["date, region"]` is one dimension and `["date", "region"]` is two. |
| `aggregation` | yes | One of the vocabulary below. |
| `unit` | yes | What the numbers are in: `EUR`, `orders`, `ratio`, anything non-empty. |
| `formula` | yes | Opaque text. Compared, never parsed. |
| `filters` | no | Opaque text, as an ordered array. Absent means the empty list. |
| `owner` | yes | A team. Not a person — this tool holds no personal data. |
| `dependsOn` | yes | Other metric ids in this registry, as an array. **`[]` must be written explicitly.** |
| `definitionVersion` | yes | Moved whenever the definition moves. |
| `description` | no | Ignored by the comparison. |

An unknown field, at either level, is refused: a registry that says something
this tool does not understand is a registry it cannot claim to have read.

### Aggregations

`avg`, `count`, `count_distinct`, `custom`, `first`, `last`, `max`, `median`,
`min`, `percentile`, `ratio`, `sum`.

The vocabulary is closed on purpose. "Units and aggregation are explicit" means
a reader of the registry can tell what the number is, and a free-text
aggregation is a field that looks declared and says nothing. `custom` is the
escape hatch and it is honest: it declares that the aggregation is something
this tool cannot interpret, rather than implying that it can.

### Why `dependsOn` must be written even when it is empty

An absent list is not an empty list. "This metric depends on nothing" is a claim
somebody has to make; assuming it would let a registry that never declared its
edges be reported as an acyclic graph. So an absent `dependsOn` is
`dependencies-undeclared` and the run is `incomplete`.

## The dependency graph

What is reported is a **cyclic group**: a set of metrics that all depend on each
other, none of which can ever be computed. That is a strongly connected
component of two or more metrics, or one metric that depends on itself. Every
such group is found, each exactly once, ordered by the member that sorts first
by code unit, and every metric that takes part in any cycle is named in exactly
one of them. Each group carries one witness cycle — the shortest through its
first member — so a reader has somewhere to start.

The search is iterative, so a chain deeper than the call stack is a report
rather than a crash; a stack overflow would be an exit code outside this tool's
contract. It runs in time and memory linear in the size of the graph.

**Why a group and not every cycle.** The number of elementary cycles in a graph
is exponential in the number of metrics: a registry of 4880 definitions with
fourteen dependencies each — 1,045,409 bytes, legal on every limit below — drove
an earlier enumeration to 3.2 GB of resident memory and over eight minutes, and
it still undercounted, because a cycle whose entry point the walk had already
left was never seen. A group is the unit a reader has to act on anyway: every
metric in it is unusable until the group is broken, and naming the group names
all of them. Nothing is hidden by it — a registry with any cycle left in it is
never reported as acyclic.

**A graph with a dangling edge is not an acyclic graph.** When any `dependsOn`
entry names a metric this registry does not define, two different questions get
two different answers.

*How many groups are there* is **unknown**. An edge that leaves this registry
could come back into it, so resolving it could merge two groups or create one:

- `dependency-unresolved` is raised for each such edge,
- `summary.dependencyGraphComplete` is `false`,
- `summary.cyclicGroupsFound` is `null` — **not `0`**, and not the number of
  groups visible either, because that number is a lower bound and a field called
  `cyclicGroupsFound` is read as a count,
- the human summary says the graph is *not known to be acyclic*,
- the run is `incomplete` and exits 2.

*Whether these particular metrics depend on each other* is **known**, for any
group built only from edges this registry declares. Adding edges to a graph can
never destroy a cycle, so such a group is a real one whatever the missing edges
turn out to be. Those groups are reported, at error severity, with the message
saying `at least N metrics` and that the group may have more members than are
visible. Withholding them would make the report say less than the evidence
supports and leave a reader to find the cycle on the next run, after fixing the
dangling edge.

What never happens is the thing this tool exists not to do: a pruned graph
searched to exhaustion and its *count* reported as though the pruning had not
happened. Reporting "no cycles" over a graph that is not the one in the document
is a claim; reporting a cycle that the document proves is not.

## Comparing with the previous registry

Without `--previous`, no comparison is made — and the report says so rather than
reporting that nothing changed. `summary.comparedWithPrevious` is `false` and the
human summary states it. Absent history is unknown, not clean.

With `--previous`, each definition that exists in both is compared field by
field, and the rule id records whether `definitionVersion` moved with the
change. The full table is in [docs/rules.md](docs/rules.md).

Values are compared **as this report renders them**. A unit of `EUR` and a unit
of `EUR ` are different strings that render identically, and reporting that as
`changed unit from EUR to EUR` at error severity would send somebody to fix a
registry whose units nobody can see change. The difference is still reported —
as `changed-invisibly` within a comparison, or `name-differs-invisibly` within
one registry — at warning severity, naming the field and the first differing
code point instead of printing two values that look the same.

## Rules

| Rule | Severity | Makes the run incomplete | What it means |
| --- | --- | --- | --- |
| `aggregation-changed-declared` | info | no | The aggregation changed and `definitionVersion` moved with it. |
| `aggregation-changed-undeclared` | error | no | The aggregation changed and `definitionVersion` did not move. |
| `aggregation-undeclared` | error | yes | A definition does not declare an aggregation. |
| `aggregation-unsupported` | error | yes | A definition declares an aggregation outside the vocabulary. |
| `changed-invisibly` | warning | no | A field changed only in characters this report removes, so the two values render identically. |
| `dependencies-changed-declared` | info | no | The dependency set changed and `definitionVersion` moved with it. |
| `dependencies-changed-undeclared` | error | no | The dependency set changed and `definitionVersion` did not move. |
| `dependencies-undeclared` | error | yes | A definition has no `dependsOn`. An absent list is not an empty list. |
| `dependency-cycle` | error | no | A group of metrics depend on each other, so none of them can be computed. |
| `dependency-duplicate` | warning | no | A `dependsOn` list names the same dependency twice. |
| `dependency-unresolved` | error | yes | A dependency names a metric this registry does not define, so the number of cyclic groups is not known. |
| `filters-changed-declared` | info | no | The filter list changed and `definitionVersion` moved with it. |
| `filters-changed-undeclared` | error | no | The filter list changed and `definitionVersion` did not move. |
| `formula-changed-declared` | info | no | The formula changed and `definitionVersion` moved with it. |
| `formula-changed-undeclared` | error | no | The formula changed and `definitionVersion` did not move. |
| `grain-changed-declared` | info | no | The grain changed and `definitionVersion` moved with it. |
| `grain-changed-undeclared` | error | no | The grain changed and `definitionVersion` did not move. |
| `input-not-json` | error | yes | A registry is not valid JSON. |
| `input-not-utf8` | error | yes | A registry is not valid UTF-8. |
| `input-too-large` | error | yes | A registry is over `--max-document-bytes`, so it was not read. |
| `input-unreadable` | error | yes | A registry could not be opened. |
| `metric-added` | info | no | A definition is new since the previous registry. |
| `metric-id-duplicate` | error | yes | An id is declared twice, so an index by id is ambiguous. |
| `metric-invalid` | error | yes | A definition is unusable: not an object, a missing or mistyped field, over `--max-field-length`, a value that renders empty, or two grain entries that render identically. |
| `metric-removed` | error | no | A definition that existed is gone. |
| `metric-unknown-field` | error | yes | A definition declares a field this tool does not understand. |
| `name-aggregation-conflict` | error | no | Two definitions share a name and aggregate differently. |
| `name-changed-declared` | info | no | The name changed and `definitionVersion` moved with it. |
| `name-changed-undeclared` | error | no | The name changed and `definitionVersion` did not move. |
| `name-differs-invisibly` | warning | no | Two definitions share a name and one of their values differs only in characters this report removes. |
| `name-grain-conflict` | error | no | Two definitions share a name and are defined at different grains. |
| `name-reused` | warning | no | Two definitions share a name and agree about grain, unit and aggregation. |
| `name-unit-conflict` | error | no | Two definitions share a name and are measured in different units. |
| `no-metrics-declared` | error | yes | The registry declares no metrics. |
| `owner-changed` | info | no | The declared owner changed. |
| `path-escapes-root` | error | yes | An input path resolves outside `--root`. |
| `registry-invalid` | error | yes | The registry is not a JSON object, or `metrics` is not an array. |
| `registry-unknown-field` | error | yes | The registry declares a top-level field this tool does not understand. |
| `registry-version-unsupported` | error | yes | `registryVersion` is not a version this tool understands. |
| `too-many-findings` | error | yes | The report is over `--max-findings` and was truncated. |
| `too-many-list-entries` | error | yes | A list is over `--max-list-entries`, so none of its entries were examined. |
| `too-many-metrics` | error | yes | The registry is over `--max-metrics`, so none of its definitions were validated. |
| `unit-changed-declared` | info | no | The unit changed and `definitionVersion` moved with it. |
| `unit-changed-undeclared` | error | no | The unit changed and `definitionVersion` did not move. |
| `unit-undeclared` | error | yes | A definition does not declare a unit. |

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | The registry was read completely and no error-severity rule fired. | the report |
| `1` | The registry was read completely and at least one error-severity rule fired. | the report |
| `2` | Invalid configuration — the run never had a subject. | **empty** |
| `2` | Evidence that could not be obtained: an unreadable document, an undeclared unit, aggregation or dependency list, a duplicate id, an unresolved dependency, or a limit reached. | an `incomplete` report |

A consumer that pipes `stdout` must handle an empty `stdout` on exit 2. That is
documented rather than papered over: emitting a fake report for a run that never
started would be worse.

## Limits

Each is enforced **before** the work it bounds, so a legal-sized input cannot
exhaust memory. Exceeding one is an `incomplete` result with a finding naming
the limit — never a silent truncation, never a pass. Every one is tested from
both sides: that it fires at N+1, and that it stays silent at exactly N.

| Flag | Default | Enforced |
| --- | ---: | --- |
| `--max-document-bytes` | 1048576 | Against the file size before a byte is read, and against the buffer after. |
| `--max-metrics` | 5000 | Against the declared array length before any definition is read. |
| `--max-list-entries` | 50 | Against each `grain`, `filters` and `dependsOn` length before any entry is read. |
| `--max-field-length` | 400 | Against every string field. |
| `--max-findings` | 1000 | The list is truncated and `too-many-findings` says so. |

`summary.errors` and `summary.warnings` count every finding detected, including
any the `--max-findings` truncation removed from the list.

## Report shape

The envelope follows the Edilec tool report contract. `summary` carries these
extra fields:

| Field | Meaning |
| --- | --- |
| `registryRead` | **False means the registry was never validated as a whole.** An empty `findings` list says nothing about it. |
| `metrics` | How many definitions were indexed. |
| `dependencyGraphComplete` | False means an edge leaves the evidence. |
| `cyclicGroupsFound` | How many groups of mutually dependent metrics were found: an integer, or `null` when no search was run. Never `0` in that case. |
| `namesSharedBySeveralMetrics` | How many names more than one definition answers to. |
| `comparedWithPrevious` | **False means no previous registry was read**, so nothing in the report is a claim about what changed. |
| `previousRegistryNamed` | Whether `--previous` was given at all. With the field above it separates "no history was asked for" from "history was asked for and could not be read"; the human summary says which. |
| `metricsAdded` / `metricsRemoved` / `metricsChanged` | Counts from the comparison; all zero when there was none. |

`checked` is the number of definitions indexed plus, when a previous registry
was read, one unit per id in the union of the two registries.

## Non-goals

This tool does not, and will not without a deliberate decision:

- **Parse a formula or a filter.** They are opaque text, compared and never
  interpreted. A dependency that exists only inside formula text is invisible
  here — `dependsOn` is the evidence, which is why it must be explicit.
- **Run anything.** No query, no warehouse, no clock, no network.
- **Check that a formula computes the metric.** Nothing here has seen a number.
- **Infer a unit or an aggregation from a formula.** `sum(...)` in a formula is
  not a declared aggregation, and a currency column is not a declared unit.
- **Rank or merge conflicting definitions.** Two definitions sharing a name are
  reported; which one is right is not a question the documents answer.
- **Report a number of cyclic groups for a graph it could not resolve.** See
  *The dependency graph*. The groups the resolved edges prove are still
  reported; the count is not.
- **Enumerate every elementary cycle.** That count is exponential in the number
  of metrics and cannot be produced inside a memory bound derived from the input
  size. Every cyclic *group* is reported instead, which names every metric that
  takes part in any cycle.
- **Write anything.** No `--out`, no directory creation, no auto-fix.

## Verification

```sh
npm run check   # lint, tests, both examples, and a packaging dry run
```

## License

MIT. See [LICENSE](./LICENSE).
