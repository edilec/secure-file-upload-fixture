/**
 * The output destination, one test per hole and one per allowed shape.
 *
 * This tool was luckier than its siblings: the exclusive-create flag refused a
 * symbolic link at a fixture destination by accident, so nothing was ever
 * destroyed here. Two things were still wrong, and both are the kind of thing
 * that stops being true the moment someone touches the code:
 *
 * 1. The refusal was reported as "already exists in the output directory" --
 *    the right outcome with the wrong reason. Nobody reading that message, or
 *    the test asserting it, would know a symlink was involved at all.
 * 2. `--out` itself was resolved with `realpath`, so a symbolic link AT `--out`
 *    put all nineteen fixtures in a directory outside the tree the caller
 *    named, at exit 0 with status pass, while the README said "nothing outside
 *    this directory is touched".
 *
 * So the refusals are now made deliberately, by the same guard the rest of the
 * catalog uses, and pinned here. The allowed cases are not decoration: a guard
 * that refuses everything passes every data-loss test while making the tool
 * useless.
 */
import assert from 'node:assert/strict'
import { link, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { assertWritableDestination } from '../src/index.mjs'
import { cliRun, findingsFor, fixture, fixtureCase, policy, rejectCase, withRoot } from './support.mjs'

const PRECIOUS = 'a file this tool was never asked to touch\n'

const suite = () => fixture(policy(), [fixtureCase({ id: 'accept-png' }), rejectCase({ id: 'reject-exe' })])

async function run(root, args) {
  const result = await cliRun(['--root', root, '--json', ...args])
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

async function exists(path) {
  return stat(path).then(() => true, () => false)
}

// ---------------------------------------------------------------------------
// Hole 1: a symbolic link at a destination.
// ---------------------------------------------------------------------------

test('a symlink at a fixture destination is refused by name, and its target survives', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      const precious = join(out, 'precious.bin')
      await writeFile(precious, PRECIOUS)
      await symlink(precious, join(out, 'accept-png.fixture'))

      const { code, report } = await run(root, ['--out', out])

      assert.equal(code, 2)
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.written, 1, 'the other case is still written')
      const refusals = findingsFor(report, 'output-not-written')
      assert.equal(refusals.length, 1)
      assert.match(refusals[0].message, /symbolic link/, 'not "already exists", which is the right outcome for the wrong reason')
      assert.equal(await readFile(precious, 'utf8'), PRECIOUS)
    })
  })
})

test('a symlink at a fixture destination whose target does not exist yet creates nothing', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      await withRoot({}, async (elsewhere) => {
        const wouldBeCreated = join(elsewhere, 'created.bin')
        await symlink(wouldBeCreated, join(out, 'accept-png.fixture'))

        const { code, report } = await run(root, ['--out', out])

        assert.equal(code, 2)
        assert.match(findingsFor(report, 'output-not-written')[0].message, /symbolic link/)
        assert.equal(await exists(wouldBeCreated), false, 'the fixture was created outside the output directory')
      })
    })
  })
})

test('--out that is itself a symbolic link is a configuration error, and nothing is written through it', async () => {
  // `realpath` on --out hands back whatever tree the link points at, and every
  // fixture then lands there. Nineteen of them did, at exit 0 with status pass.
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (elsewhere) => {
      await withRoot({}, async (here) => {
        const alias = join(here, 'outlink')
        await symlink(elsewhere, alias)

        const { code, stdout, stderr } = await cliRun(['--root', root, '--json', '--out', alias])

        assert.equal(code, 2)
        assert.equal(stdout, '', 'a configuration error never had a subject, so stdout stays empty')
        assert.match(stderr, /--out is a symbolic link/)
        assert.deepEqual(await readdir(elsewhere), [], 'not one fixture reached the linked directory')
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Hole 2: a symlinked directory on the way to a destination.
// ---------------------------------------------------------------------------

test('a case id can never spell a path segment, so no fixture destination can leave --out', async () => {
  // A fixture destination is `join(realOut, id + '.fixture')`, so the only way
  // one could acquire a symlinked parent is through the id itself. The suite
  // validator refuses an id that is not letters, digits, dot, hyphen or
  // underscore -- and refuses `..` outright -- so the destination is always a
  // direct child of the directory --out resolved to.
  await withRoot(fixture(policy(), [
    fixtureCase({ id: 'good' }),
    fixtureCase({ id: '../escape' }),
  ]), async (root) => {
    await withRoot({}, async (out) => {
      const { code, report } = await run(root, ['--out', out])

      assert.equal(code, 2)
      assert.equal(report.status, 'incomplete')
      assert.equal(findingsFor(report, 'case-invalid').length, 1)
      assert.deepEqual(await readdir(out), ['good.fixture'])
      assert.equal(await exists(join(out, '..', 'escape.fixture')), false)
    })
  })
})

test('the guard refuses a destination whose parent resolves outside the permitted root', async () => {
  // The unit-level half of the same property. The CLI cannot reach this shape
  // today because ids are constrained, which is exactly why it is pinned here:
  // the confinement is what makes that constraint non-load-bearing.
  await withRoot({}, async (out) => {
    await withRoot({}, async (elsewhere) => {
      const precious = join(elsewhere, 'precious.bin')
      await writeFile(precious, PRECIOUS)
      await symlink(elsewhere, join(out, 'linked'))

      await assert.rejects(
        () => assertWritableDestination(join(out, 'linked', 'precious.bin'), { root: out, label: '--out' }),
        /outside the permitted root/,
      )
      assert.equal(await readFile(precious, 'utf8'), PRECIOUS)

      // And the legitimate shape it must not refuse.
      await mkdir(join(out, 'real'))
      const allowed = await assertWritableDestination(join(out, 'real', 'x.fixture'), { root: out, label: '--out' })
      assert.equal(allowed.endsWith(join('real', 'x.fixture')), true)
    })
  })
})

// ---------------------------------------------------------------------------
// Hole 3: a hard link to an input.
// ---------------------------------------------------------------------------

test('a hard link to an input is refused before the write, and the input survives', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      await link(join(root, 'suite.json'), join(out, 'accept-png.fixture'))
      const original = await readFile(join(root, 'suite.json'))

      const { code, report } = await run(root, ['--out', out])

      assert.equal(code, 2)
      assert.equal(report.status, 'incomplete')
      const refusals = findingsFor(report, 'output-not-written')
      assert.equal(refusals.length, 1)
      assert.match(refusals[0].message, /share device \d+ and inode \d+/)
      assert.deepEqual(await readFile(join(root, 'suite.json')), original, 'the input must survive byte for byte')
    })
  })
})

test('a hard link to the policy is refused too, not only to the suite', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      await link(join(root, 'policy.json'), join(out, 'reject-exe.fixture'))
      const original = await readFile(join(root, 'policy.json'))

      const { code, report } = await run(root, ['--out', out])

      assert.equal(code, 2)
      assert.match(findingsFor(report, 'output-not-written')[0].message, /share device \d+ and inode \d+/)
      assert.deepEqual(await readFile(join(root, 'policy.json')), original)
    })
  })
})

// ---------------------------------------------------------------------------
// Shapes that cannot be written at all.
// ---------------------------------------------------------------------------

test('a fixture destination that is a directory is refused', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      await mkdir(join(out, 'accept-png.fixture'))

      const { code, report } = await run(root, ['--out', out])

      assert.equal(code, 2)
      assert.match(findingsFor(report, 'output-not-written')[0].message, /not a regular file/)
      assert.equal((await stat(join(out, 'accept-png.fixture'))).isDirectory(), true)
    })
  })
})

test('an existing regular file is refused, and the file that was there is untouched', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      await writeFile(join(out, 'accept-png.fixture'), PRECIOUS)

      const { code, report } = await run(root, ['--out', out])

      assert.equal(code, 2)
      assert.match(findingsFor(report, 'output-not-written')[0].message, /already exists/)
      assert.equal(await readFile(join(out, 'accept-png.fixture'), 'utf8'), PRECIOUS)
    })
  })
})

// ---------------------------------------------------------------------------
// The allowed cases. A guard that refuses these is a guard that broke the tool.
// ---------------------------------------------------------------------------

test('an ordinary empty output directory takes one file per evaluated case', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      const { code, report } = await run(root, ['--out', out])

      assert.equal(code, 0)
      assert.equal(report.summary.written, 2)
      assert.deepEqual((await readdir(out)).sort(), ['accept-png.fixture', 'reject-exe.fixture'])
    })
  })
})

test('a directory below the root is still a legitimate output directory', async () => {
  await withRoot(suite(), async (root) => {
    const out = join(root, 'built')
    await mkdir(out)

    const { code, report } = await run(root, ['--out', out])

    assert.equal(code, 0)
    assert.equal(report.summary.written, 2)
    assert.deepEqual((await readdir(root)).sort(), ['built', 'policy.json', 'suite.json'])
  })
})

test('an output directory reached through a symlinked ancestor still accepts its own files', async () => {
  // The mirror image of hole 2, and the reason the comparison is real path
  // against real path in both directions. On macOS the system temporary
  // directory is itself reached through a symlink, so a guard that compares a
  // resolved destination with an unresolved root refuses every legitimate
  // destination on the machine it is running on.
  //
  // The link has to lie ON THE WAY to --out, not AT it: a symlink at --out is
  // hole 1 and is refused. This test named the real directory instead, so it
  // traversed no link at all and stayed green with the symlink deleted -- the
  // allowed half of the guard was unpinned by the test written to pin it.
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      const real = join(out, 'real')
      const destination = join(real, 'fixtures')
      await mkdir(destination, { recursive: true })
      await symlink(real, join(out, 'alias'))

      // --out is named through the link: every segment before the last is
      // resolved by the OS, and the fixtures land in the real directory.
      const { code, report } = await run(root, ['--out', join(out, 'alias', 'fixtures')])

      assert.equal(code, 0)
      assert.equal(report.summary.written, 2)
      assert.deepEqual((await readdir(destination)).sort(), ['accept-png.fixture', 'reject-exe.fixture'])
      assert.deepEqual(await readdir(real), ['fixtures'], 'nothing landed beside the destination')
    })
  })
})

test('a second run into a directory already holding this tool\'s fixtures refuses rather than overwrites', async () => {
  await withRoot(suite(), async (root) => {
    await withRoot({}, async (out) => {
      const first = await run(root, ['--out', out])
      assert.equal(first.code, 0)
      const written = await readFile(join(out, 'accept-png.fixture'))

      const second = await run(root, ['--out', out])

      assert.equal(second.code, 2)
      assert.equal(second.report.summary.written, 0)
      assert.equal(findingsFor(second.report, 'output-not-written').length, 2)
      assert.deepEqual(await readFile(join(out, 'accept-png.fixture')), written, 'byte for byte, not rewritten')
    })
  })
})
