import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { REJECTION_REASONS } from '../src/index.mjs'
import { cliRun, projectDirectory } from './support.mjs'

/**
 * The two examples in the repository, run as a user would run them.
 *
 * `examples/clean` is what `npm run example` runs, so it must exit 0; it also
 * exercises every rejection reason in the catalog, which makes it the readable
 * reference for what each one looks like. `examples/broken` is a suite that
 * has drifted away from its policy, and it must exit 1 -- not 2, because
 * nothing about it is unfinished: every fixture was built and judged.
 */

const example = (name) => join(projectDirectory, 'examples', name)

test('the clean example passes, and exercises every rejection reason there is', async () => {
  const result = await cliRun(['--root', example('clean')])
  const report = JSON.parse(result.stdout)

  assert.equal(result.code, 0)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [], 'a clean example with a finding in it is not a clean example')
  assert.equal(report.summary.checked, 19)
  assert.equal(report.summary.cases, 19)
  assert.equal(report.summary.accepted, 4)
  assert.equal(report.summary.rejected, 15)
  assert.equal(report.summary.rejected, REJECTION_REASONS.length, 'one fixture per reason')
  assert.equal(report.summary.types, 4)
  assert.equal(report.summary.unevaluated, 0)
  assert.match(result.stderr, /status pass/)
})

test('the broken example fails, and every finding in it is a real disagreement', async () => {
  const result = await cliRun(['--root', example('broken'), '--json'])
  const report = JSON.parse(result.stdout)

  assert.equal(result.code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.checked, 4)
  assert.equal(report.summary.unevaluated, 0, 'a failure is not an unfinished run')
  assert.deepEqual(
    report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId).sort(),
    ['expected-accept-but-rejected', 'expected-reject-but-accepted', 'generated-name-mismatch', 'generated-name-unsafe', 'reason-mismatch'],
  )
})

test('the clean example is what the example script runs, and the broken one is not', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(manifest.scripts.example, 'node bin/secure-file-upload-fixture.mjs --root examples/clean')
  assert.match(manifest.scripts.check, /npm run lint && npm test && npm run example && npm run pack:check/)
})

test('both examples declare only inert content, and no example declares a payload', async () => {
  for (const name of ['clean', 'broken']) {
    const suite = JSON.parse(await readFile(join(example(name), 'suite.json'), 'utf8'))
    for (const entry of suite.cases) {
      assert.equal(['empty', 'padding', 'signature'].includes(entry.content.kind), true, `${name}/${entry.id}`)
    }
  }
})
