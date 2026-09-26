import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { projectDirectory } from './support.mjs'

/**
 * Boundaries that are easier to keep than to re-establish.
 *
 * These are source scans, and a source scan is a weak test: it pins a spelling
 * rather than a behaviour, which is exactly why `.localeCompare(` scans failed
 * elsewhere in this catalog. They are here as a second line only -- the
 * behaviour they stand behind is pinned by `test/ordering.test.mjs` (ordering),
 * `test/output.test.mjs` (what is written) and the absence of any network
 * capability in the API surface. What a scan *is* good for is catching a new
 * import added in a hurry.
 */

async function sources() {
  const files = []
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      files.push([`${directory}/${name}`, await readFile(join(projectDirectory, directory, name), 'utf8')])
    }
  }
  return files
}

test('nothing in src or bin can reach the network', async () => {
  const forbidden = [
    'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'node:dns',
    'fetch(', 'XMLHttpRequest', 'WebSocket', 'node:child_process', 'node:cluster',
  ]

  for (const [name, source] of await sources()) {
    for (const marker of forbidden) {
      assert.equal(source.includes(marker), false, `${name} must not mention ${marker}`)
    }
  }
})

test('nothing in src or bin reads a clock, a random source or a locale', async () => {
  const forbidden = ['localeCompare', 'Intl.', 'Date.now', 'new Date', 'Math.random', 'process.hrtime', 'performance.now']

  for (const [name, source] of await sources()) {
    for (const marker of forbidden) {
      assert.equal(source.includes(marker), false, `${name} must not mention ${marker}`)
    }
  }
})

test('the package has no dependencies of any kind', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
  assert.equal(manifest.engines.node, '>=22')
  assert.equal(manifest.version, '0.1.0')
})

test('the only cryptography is a named primitive from node:crypto', async () => {
  const validate = await readFile(join(projectDirectory, 'src/validate.mjs'), 'utf8')

  assert.match(validate, /import \{ createHash \} from 'node:crypto'/)
  assert.match(validate, /createHash\('sha256'\)/)
  for (const [name, source] of await sources()) {
    assert.equal(/createCipher|createDecipher|randomBytes|timingSafeEqual\(/.test(source), false, `${name}`)
  }
})
