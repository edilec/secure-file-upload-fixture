import assert from 'node:assert/strict'
import { link, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliRun, findingsFor, fixture, fixtureCase, policy, rejectCase, withRoot } from './support.mjs'

/**
 * Materialising fixtures, and every destination that is refused.
 *
 * This is the only part of the tool that writes anything, so it is the only
 * part that can destroy something. It writes with an exclusive-create flag and
 * never overwrites; when a destination already exists it is inspected by
 * device and inode, because a *hard link* has no target to resolve and a
 * second name for an input file compares equal to nothing under a path check.
 * A sibling tool in this catalog destroyed its own input exactly that way.
 */

const suite = () => fixture(policy(), [fixtureCase({ id: 'accept-png' }), rejectCase({ id: 'reject-exe' })])

async function run(root, args) {
  const result = await cliRun(['--root', root, '--json', ...args])
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

test('one file per evaluated case is written, named for the case and not for the upload', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      const { code, report } = await run(root, ['--out', out])

      assert.equal(code, 0)
      assert.equal(report.summary.written, 2)
      assert.deepEqual((await readdir(out)).sort(), ['accept-png.fixture', 'reject-exe.fixture'])
    })
  })
})

test('nothing is written when --out is not given', async () => {
  await withRoot(suite(), async (root) => {
    const before = (await readdir(root)).sort()
    const { code, report } = await run(root, [])

    assert.equal(code, 0)
    assert.equal(report.summary.written, 0)
    assert.deepEqual((await readdir(root)).sort(), before, 'the root is read-only without --out')
  })
})

test('an existing destination is refused, and the file that was there is untouched', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      await writeFile(join(out, 'accept-png.fixture'), 'this was here first')
      const { code, report } = await run(root, ['--out', out])

      assert.equal(report.status, 'incomplete')
      assert.equal(code, 2)
      assert.equal(report.summary.written, 1, 'the other case is still written')
      const refusals = findingsFor(report, 'output-not-written')
      assert.equal(refusals.length, 1)
      assert.match(refusals[0].message, /already exists/)
      assert.equal(await readFile(join(out, 'accept-png.fixture'), 'utf8'), 'this was here first')
    })
  })
})

test('a hard link to one of this run\'s own inputs is refused by device and inode, and the input survives', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      // A second name for the suite file. Its real path is its own, so no path
      // comparison can see what it is; the inode can.
      await link(join(root, 'suite.json'), join(out, 'accept-png.fixture'))
      const original = await readFile(join(root, 'suite.json'))

      const { code, report } = await run(root, ['--out', out])

      assert.equal(report.status, 'incomplete')
      assert.equal(code, 2)
      const refusals = findingsFor(report, 'output-not-written')
      assert.equal(refusals.length, 1)
      // Refused by the guard now, before the write is attempted at all, so the
      // message names the device and inode it compared rather than describing
      // a collision discovered by the exclusive-create flag afterwards.
      assert.match(refusals[0].message, /share device \d+ and inode \d+/)
      assert.deepEqual(await readFile(join(root, 'suite.json')), original, 'the input must survive byte for byte')
    })
  })
})

test('a case that did not compile is never written', async () => {
  await withRoot(fixture(policy(), [
    fixtureCase({ id: 'good' }),
    fixtureCase({ id: 'bad', content: { kind: 'signature', signature: 'zip', bytes: 64 } }),
  ]), async (root) => {
    await withRoot({}, async (out) => {
      const { report } = await run(root, ['--out', out])

      assert.equal(report.summary.written, 1)
      assert.deepEqual(await readdir(out), ['good.fixture'])
    })
  })
})

test('a destination that is not an existing directory is a configuration error with an empty stdout', async () => {
  await withRoot(suite(), async (root) => {
    const missing = await run(root, ['--out', join(root, 'nowhere')])
    assert.equal(missing.code, 2)
    assert.equal(missing.stdout, '')
    assert.match(missing.stderr, /--out could not be resolved/)

    const notADirectory = await run(root, ['--out', join(root, 'policy.json')])
    assert.equal(notADirectory.code, 2)
    assert.equal(notADirectory.stdout, '')
    assert.match(notADirectory.stderr, /--out must be a directory/)
  })
})

test('writing into a directory below the root is allowed, and touches nothing else', async () => {
  await withRoot(suite(), async (root) => {
    const out = join(root, 'built')
    await mkdir(out)
    const { code, report } = await run(root, ['--out', out])

    assert.equal(code, 0)
    assert.equal(report.summary.written, 2)
    assert.deepEqual((await readdir(root)).sort(), ['built', 'policy.json', 'suite.json'])
  })
})
