/**
 * The CLI surface, including the part of the contract that is easy to get
 * wrong: exit 2 has two shapes. A configuration error never had a subject, so
 * stdout is EMPTY; an input that could not be read did have one, so stdout
 * carries an `incomplete` report.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { makeRoot, metric, oneRegistry, registryDoc, runCli, writeDocument } from './support.mjs'

test('--help explains the tool and exits 0', async () => {
  const run = await runCli(['--help'])

  assert.equal(run.code, 0)
  assert.match(run.stdout, /metric-definition-registry/)
  assert.match(run.stdout, /Exit codes:/)
  assert.match(run.stdout, /This tool writes nothing/)
  assert.match(run.stdout, /reads no clock/)
  assert.match(run.stdout, /does not report how many cyclic groups a graph has when an edge leaves/)
})

test('--version prints a version and exits 0', async () => {
  const run = await runCli(['--version'])
  assert.equal(run.code, 0)
  assert.match(run.stdout.trim(), /^\d+\.\d+\.\d+$/)
})

test('an unknown option is refused with an empty stdout', async () => {
  const run = await runCli(['--root', '.', '--registry', 'a.json', '--max-metric', '5'])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /Unknown option "--max-metric"/)
})

test('a repeated value flag is refused rather than silently last-wins', async () => {
  const run = await runCli(['--root', '.', '--registry', 'a.json', '--previous', 'b.json', '--previous', 'c.json'])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--previous was given more than once/)
})

test('a missing required flag is refused', async () => {
  for (const argv of [[], ['--root', '.']]) {
    const run = await runCli(argv)
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /is required/)
  }
})

test('a flag with no value is refused', async () => {
  const run = await runCli(['--registry'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--registry requires a value/)
})

test('a non-integer limit is refused', async () => {
  const run = await runCli(['--root', '.', '--registry', 'a.json', '--max-metrics', 'lots'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--max-metrics requires a positive integer/)
})

test('a root that does not exist is a configuration error', async () => {
  const run = await runCli(['--root', '/no/such/root/here', '--registry', 'a.json'])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /root could not be resolved/)
})

test('an input that could not be read still produces a report on stdout', async () => {
  const root = await makeRoot()
  const run = await runCli(['--root', root, '--registry', 'missing.json'])

  assert.equal(run.code, 2)
  assert.notEqual(run.stdout, '')
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'input-unreadable')
})

test('stdout carries the report and nothing else, so it pipes into a parser', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'a', dependsOn: ['b'] }),
    metric({ id: 'b', name: 'b', dependsOn: ['a'] }),
  ]))
  const run = await runCli(['--root', documents.root, '--registry', documents.registry])

  assert.equal(run.code, 1)
  const report = JSON.parse(run.stdout)
  assert.equal(report.tool, 'metric-definition-registry')
  assert.equal(report.schemaVersion, '1')
  // The human summary is on stderr, where it cannot corrupt the JSON.
  assert.match(run.stderr, /metric-definition-registry: fail/)
})

test('--json silences the human summary without changing stdout', async () => {
  const documents = await oneRegistry(registryDoc([
    metric({ id: 'a', name: 'a', dependsOn: ['b'] }),
    metric({ id: 'b', name: 'b', dependsOn: ['a'] }),
  ]))
  const args = ['--root', documents.root, '--registry', documents.registry]
  const loud = await runCli(args)
  const quiet = await runCli([...args, '--json'])

  assert.equal(quiet.stderr, '')
  assert.equal(quiet.stdout, loud.stdout)
  assert.equal(quiet.code, loud.code)
})

test('a location never carries an absolute host path', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', registryDoc([metric({ dependsOn: ['ghost'] })]))
  const run = await runCli(['--root', root, '--registry', 'metrics.json'])
  const report = JSON.parse(run.stdout)

  for (const item of report.findings) {
    assert.ok(!item.location.file.startsWith('/'), `${item.location.file} is an absolute path`)
    assert.ok(!item.location.file.includes(root))
  }
})
