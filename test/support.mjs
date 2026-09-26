import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PROJECT = dirname(HERE)
export const BIN = join(PROJECT, 'bin', 'metric-definition-registry.mjs')

const roots = []

/** A temporary directory, removed when the process exits. */
export async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'metric-definition-registry-'))
  roots.push(root)
  return root
}

process.on('exit', () => {
  for (const root of roots) {
    try {
      // Synchronous on purpose: an exit handler cannot await.
      rmSync(root, { recursive: true, force: true })
    } catch {
      // A leftover temp directory is not worth failing a test run over.
    }
  }
})

export async function removeRoot(root) {
  await rm(root, { recursive: true, force: true })
}

/** Write one document into a root. `body` may be an object or raw text/bytes. */
export async function writeDocument(root, name, body) {
  const path = join(root, name)
  const content = typeof body === 'string' || body instanceof Uint8Array ? body : `${JSON.stringify(body, null, 2)}\n`
  await writeFile(path, content)
  return path
}

/** A metric definition with every required field declared. */
export function metric(overrides = {}) {
  return {
    id: 'orders_daily',
    name: 'orders',
    grain: ['date'],
    aggregation: 'sum',
    unit: 'orders',
    formula: 'count(order_id)',
    filters: [],
    owner: 'analytics-platform',
    dependsOn: [],
    definitionVersion: '1',
    ...overrides,
  }
}

/** A registry document holding the given definitions. */
export function registryDoc(metrics = [metric()], overrides = {}) {
  return { registryVersion: '1', metrics, ...overrides }
}

/** Run the CLI and resolve with its exit code and streams, whatever the code. */
export function runCli(args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: options.cwd ?? PROJECT, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
      },
    )
  })
}

/** A root holding one registry, and the argument names for it. */
export async function oneRegistry(document) {
  const root = await makeRoot()
  await writeDocument(root, 'metrics.json', document)
  return { root, registry: 'metrics.json' }
}

/** A root holding a registry and the one before it. */
export async function twoRegistries(previous, current) {
  const root = await makeRoot()
  await writeDocument(root, 'previous.json', previous)
  await writeDocument(root, 'metrics.json', current)
  return { root, registry: 'metrics.json', previous: 'previous.json' }
}
