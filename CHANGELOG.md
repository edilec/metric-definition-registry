# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A rule id is part of the public interface: renaming one is a breaking change and
is recorded here.

## [0.1.0] - 2026-09-19

### Added

- Validate a registry of metric definitions: id, name, grain, aggregation, unit,
  formula, filters, owner, dependencies and definition version.
- Flag two definitions that share a name but disagree about grain, unit or
  aggregation, and note a name that two definitions share while agreeing.
  Definitions are grouped by the name as the report renders it, so a trailing
  space does not split one shared name into two unrelated metrics.
- Compare `grain`, `filters` and `dependsOn` entry by entry rather than as one
  joined string, and quote each entry where the report prints it, so
  `["date, region"]` and `["date", "region"]` are told apart in both directions.
- Compare every single-value field as the report renders it. Two values that
  differ only in characters the report removes -- a trailing space, a NEL, a
  bidi mark -- give `changed-invisibly` or `name-differs-invisibly` at warning
  severity, naming the field and the first differing code point, instead of a
  value change whose own evidence shows the two values alike.
- Find every cyclic group -- a set of metrics that all depend on each other --
  with an iterative search, so a chain deeper than the call stack is a report
  rather than a crash. Each group is reported once, ordered by its first member,
  with one witness cycle. `summary.cyclicGroupsFound` counts groups; enumerating
  every elementary cycle is a non-goal, because that count is exponential in the
  number of metrics and cannot be produced inside a memory bound derived from
  the input size.
- Withhold the *number* of cyclic groups when a dependency graph has an
  unresolved edge: `summary.cyclicGroupsFound` is `null` rather than `0` or a
  lower bound, and the run is `incomplete`. The groups the resolved edges prove
  are still reported, each saying "at least N metrics" and that it may be
  larger, because adding edges to a graph can never destroy a cycle.
- Require units, aggregations and dependency lists to be declared. None of the
  three is inferred, and an absent `dependsOn` is not read as an empty one.
- Compare with a previous registry, recording for each changed field whether
  `definitionVersion` moved with it. Without `--previous`, the report states
  that no comparison was made rather than reporting that nothing changed, and
  `summary.previousRegistryNamed` separates a previous registry nobody asked
  for from one that was named and could not be read.
- Bounds on document bytes, definitions, list entries, field length and
  findings, each enforced before the work it bounds.
- Input paths confined to `--root`, by lexical check and by resolved real path,
  so a symbolic link out of the root is refused.
- A 45-rule catalogue with one frozen severity table, documented in
  `docs/rules.md` and in the README.
