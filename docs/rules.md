# Rule catalogue

Every rule this tool can emit, with the severity it always carries and whether
it makes the run `incomplete`. Severity is read from one frozen table in
`src/index.mjs`; it is never written at a call site, and an id that is not in
that table throws rather than defaulting.

`incomplete` means the rule reports evidence the tool did not obtain or could
not evaluate. Any one of them makes the report `incomplete` and the process exit
`2` — never `0`, and never folded into a clean result.

## Where the line falls

A **fact about a registry that was read completely** fails (exit 1): a
dependency cycle, a name two definitions disagree about, a definition changed
without moving its `definitionVersion`, a metric that disappeared.

**Evidence the tool does not have** is incomplete (exit 2): a document it could
not read, a definition that did not declare its unit, aggregation or
dependencies, a duplicate id that makes the index ambiguous, or a dependency
pointing at something this registry does not define.

The second list is where the design differs from a validator that tries to be
helpful. An absent `dependsOn` is not read as "depends on nothing", and an
unresolved dependency never lets the tool report a *number* of cyclic groups: a
count over a pruned graph would be a conclusion drawn from evidence that was
discarded, so `summary.cyclicGroupsFound` is `null`.

The groups the resolved edges *prove* are still reported, because adding edges
to a graph can never destroy a cycle — a cycle among edges this registry
declares is a cycle whatever the missing edges turn out to be. Those findings
say `at least N metrics` and that the group may be larger. The distinction is
the whole point: a count is a claim about the graph, and a named group is a
claim about the edges in front of you.

## Declared and undeclared changes

Changing what a metric means is ordinary work. Doing it without moving
`definitionVersion` is what makes yesterday's number and today's number
incomparable while both claim to be the same metric at the same version. So each
comparison rule comes in two forms:

| Changed field | `definitionVersion` moved | `definitionVersion` did not move |
| --- | --- | --- |
| `name` | `name-changed-declared` (info) | `name-changed-undeclared` (error) |
| `grain` | `grain-changed-declared` (info) | `grain-changed-undeclared` (error) |
| `aggregation` | `aggregation-changed-declared` (info) | `aggregation-changed-undeclared` (error) |
| `unit` | `unit-changed-declared` (info) | `unit-changed-undeclared` (error) |
| `formula` | `formula-changed-declared` (info) | `formula-changed-undeclared` (error) |
| `filters` | `filters-changed-declared` (info) | `filters-changed-undeclared` (error) |
| `dependsOn` | `dependencies-changed-declared` (info) | `dependencies-changed-undeclared` (error) |

`grain` and `dependsOn` are compared as **sets**: the order of dimensions and of
dependencies carries no meaning. `filters` are compared as an **ordered list**,
because this tool does not parse a filter expression and so cannot know whether
their order matters — a reordering is reported, and the message says it was a
reordering rather than implying the expressions changed.

All three are compared **entry by entry**, never as one joined string, and each
entry is quoted where the report prints it. `["date, region"]` is one dimension
whose name contains a comma and `["date", "region"]` is two dimensions; joined
with `, ` they are the same text. Comparing that text made the two equal, which
had two consequences in opposite directions: two definitions at genuinely
different grains were reported as agreeing about grain at exit 0, and a real
grain change from `["date", "region"]` to `["date, region"]` with
`definitionVersion` unmoved produced no finding at all.

A `definitionVersion` that moves with nothing else changing is not reported.
Re-versioning a definition ahead of a change is ordinary work, and nagging about
it would be a finding on correct input.

## A difference this report cannot show

Every string that comes out of a registry is rendered before it reaches the
report: control characters, bidi marks and U+2028/U+2029 are removed, runs of
whitespace are collapsed to one space, and the result is trimmed. So two values
can be different strings and still render identically — `EUR` and `EUR ` are the
plainest case, and no control character is needed to reach it.

Comparing the raw strings and then printing the rendered ones produces a finding
that contradicts its own evidence:

```
ERROR  unit-changed-undeclared  "rev" changed unit from EUR to EUR
       evidence: EUR | EUR
```

That is an error-severity finding, exit 1, on a registry whose units nobody can
see change. It is the worst shape a checker has: it sends somebody to fix
correct data, and they cannot see what to fix.

So every single-value field is compared **as it will be rendered**, and a
difference that survives only in removed characters gets its own rule —
`changed-invisibly` across registries, `name-differs-invisibly` within one — at
warning severity, exit 0. The difference is still reported, because the two
documents really do differ. What changes is the sentence: instead of a value
change nobody can see, the finding names the field and the first differing code
point.

```
WARN   changed-invisibly  "rev" changed unit only in characters this report
                          removes, so the two values render identically here
       evidence: unit: at character 4: before the end of the value, after U+0020
```

Two consequences worth stating:

- Definitions are grouped by name **as rendered**, so two definitions whose
  names differ only by a trailing space are one shared name, not two unrelated
  metrics under a report that prints the same word twice.
- A `definitionVersion` that differs only in removed characters has not moved.
  Treating it as moved would downgrade every accompanying finding from error to
  info.

`grain`, `filters` and `dependsOn` are lists, and a list rendered into one
string can collide with a different list for reasons that have nothing to do
with removed characters. They are therefore not compared this way.
`aggregation` is a single string and is also excluded, because its vocabulary is
closed and every member of it is plain lowercase ASCII — two aggregations that
render identically are identical.

## Rules

| Rule | Severity | Makes the run incomplete | What it means |
| --- | --- | --- | --- |
| `aggregation-changed-declared` | info | no | The aggregation changed and `definitionVersion` moved with it. |
| `aggregation-changed-undeclared` | error | no | The aggregation changed and `definitionVersion` did not move. |
| `aggregation-undeclared` | error | yes | A definition does not declare an aggregation. This tool does not infer one from the formula. |
| `aggregation-unsupported` | error | yes | A definition declares an aggregation outside the vocabulary. Declare `custom` if it genuinely is. |
| `changed-invisibly` | warning | no | A field changed only in characters this report removes, so the two values render identically. The finding names the field and the first differing code point. |
| `dependencies-changed-declared` | info | no | The dependency set changed and `definitionVersion` moved with it. |
| `dependencies-changed-undeclared` | error | no | The dependency set changed and `definitionVersion` did not move. |
| `dependencies-undeclared` | error | yes | A definition has no `dependsOn`. An absent list is not an empty list. |
| `dependency-cycle` | error | no | A group of metrics depend on each other, so none of them can be computed. One finding per group, with one witness cycle. |
| `dependency-duplicate` | warning | no | A `dependsOn` list names the same dependency twice. |
| `dependency-unresolved` | error | yes | A dependency names a metric this registry does not define, so the graph has an edge leaving the evidence and the number of cyclic groups is not known. |
| `filters-changed-declared` | info | no | The filter list changed and `definitionVersion` moved with it. |
| `filters-changed-undeclared` | error | no | The filter list changed and `definitionVersion` did not move. |
| `formula-changed-declared` | info | no | The formula changed and `definitionVersion` moved with it. |
| `formula-changed-undeclared` | error | no | The formula changed and `definitionVersion` did not move. |
| `grain-changed-declared` | info | no | The grain changed and `definitionVersion` moved with it. |
| `grain-changed-undeclared` | error | no | The grain changed and `definitionVersion` did not move. |
| `input-not-json` | error | yes | A registry is not valid JSON. The failure is described without reproducing the document. |
| `input-not-utf8` | error | yes | A registry is not valid UTF-8. Decoding is strict; nothing is inferred from decoded content. |
| `input-too-large` | error | yes | A registry is larger than `--max-document-bytes`. It was not read. |
| `input-unreadable` | error | yes | A registry could not be opened. |
| `metric-added` | info | no | A definition is new since the previous registry. |
| `metric-id-duplicate` | error | yes | An id is declared twice, so an index by id is ambiguous. Nothing is analysed. |
| `metric-invalid` | error | yes | A definition is not an object, or a field is missing, mistyped, over `--max-field-length`, renders empty once control characters are removed, or declares two grain entries this report renders identically. |
| `metric-removed` | error | no | A definition that existed is gone. Anything citing it has no definition to resolve. |
| `metric-unknown-field` | error | yes | A definition declares a field this tool does not understand. |
| `name-aggregation-conflict` | error | no | Two definitions share a name and aggregate differently. |
| `name-changed-declared` | info | no | The name changed and `definitionVersion` moved with it. |
| `name-changed-undeclared` | error | no | The name changed and `definitionVersion` did not move. |
| `name-differs-invisibly` | warning | no | Two definitions share a name and one of their values differs only in characters this report removes. |
| `name-grain-conflict` | error | no | Two definitions share a name and are defined at different grains. |
| `name-reused` | warning | no | Two definitions share a name and agree about grain, unit and aggregation. They are still separate ids. |
| `name-unit-conflict` | error | no | Two definitions share a name and are measured in different units. |
| `no-metrics-declared` | error | yes | The registry declares no metrics. A clean result over nothing would mean nothing. |
| `owner-changed` | info | no | The declared owner changed. An owner is not part of what the number means, so this does not fail. |
| `path-escapes-root` | error | yes | An input path resolves outside `--root`, lexically or through a symbolic link. It was not read. |
| `registry-invalid` | error | yes | The registry is not a JSON object, or `metrics` is not an array. |
| `registry-unknown-field` | error | yes | The registry declares a top-level field this tool does not understand. |
| `registry-version-unsupported` | error | yes | `registryVersion` is not a version this tool understands. |
| `too-many-findings` | error | yes | More findings were produced than `--max-findings`. The list is truncated and says so. |
| `too-many-list-entries` | error | yes | A `grain`, `filters` or `dependsOn` list is over `--max-list-entries`. None of its entries were examined. |
| `too-many-metrics` | error | yes | The registry declares more definitions than `--max-metrics`. None were validated. |
| `unit-changed-declared` | info | no | The unit changed and `definitionVersion` moved with it. |
| `unit-changed-undeclared` | error | no | The unit changed and `definitionVersion` did not move. |
| `unit-undeclared` | error | yes | A definition does not declare a unit. This tool does not infer one from the formula. |

## Ordering

Findings sort by `(location.file, location.pointer, ruleId)`, compared by UTF-16
code unit. The one exception is `too-many-findings`, which is appended after the
sort rather than placed within it: it is a statement about the list, not an entry
in it. That means `Z.json` precedes `m.json` and `/metrics/10` precedes
`/metrics/2`. Both are deliberate: collation depends on ICU data that differs
between Node builds, and a report that two machines order differently is a
report nobody can diff. Cyclic groups are ordered by their first member, and the
witness cycle each one carries is the shortest cycle through that member over an
adjacency sorted by code unit, so the same graph always reads the same way
whichever definition the walk reached first.
