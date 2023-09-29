import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { runFixtureSuite } from '../src/index.mjs'
import { FORBIDDEN, cliRun, findingsFor, fixture, fixtureCase, policy, raisedRules, suiteOf, withRoot } from './support.mjs'

/**
 * Confinement, and the false refusals that hardening causes when it is done
 * lexically.
 *
 * Rejecting `..` and absolute paths is a usage check, not confinement: a
 * symbolic link planted inside the root contains no `..` at all. The real
 * paths of both sides are resolved and compared -- *both*, because comparing a
 * real root against an unresolved target refuses perfectly legitimate files
 * whenever the root itself is reached through a link, which on macOS is as
 * ordinary as a temporary directory under `/var`.
 */

const inputs = () => fixture(policy(), [fixtureCase(), fixtureCase({ id: 'reject', filename: 'setup.exe', content: { kind: 'padding', byte: 0, bytes: 4 }, expect: { decision: 'reject', reason: 'extension-unknown' } })])

test('a symbolic link out of the root is refused unread, and what it pointed at is never echoed', async () => {
  await withRoot({}, async (outside) => {
    await writeFile(join(outside, 'secret.json'), JSON.stringify({ schemaVersion: '1', cases: [], canary: 'AKIAIOSFODNN7EXAMPLE' }))

    await withRoot({ 'policy.json': policy() }, async (root) => {
      await symlink(join(outside, 'secret.json'), join(root, 'suite.json'))
      const result = await cliRun(['--root', root, '--json'])
      const report = JSON.parse(result.stdout)

      assert.equal(result.code, 2)
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(raisedRules(report), ['path-escapes-root'])
      assert.equal(findingsFor(report, 'path-escapes-root')[0].location.file, '@suite')
      assert.equal(result.stdout.includes('AKIAIOSFODNN7EXAMPLE'), false)
      assert.equal(result.stderr.includes('AKIAIOSFODNN7EXAMPLE'), false)
    })
  })
})

test('a root reached through a symbolic link is not refused, because both sides are resolved', async () => {
  await withRoot(inputs(), async (root) => {
    await withRoot({}, async (holder) => {
      const alias = join(holder, 'alias')
      await symlink(root, alias)

      const result = await cliRun(['--root', alias, '--json'])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).summary.checked, 2)
    })
  })
})

test('an input in a directory below the root is read, not refused', async () => {
  await withRoot({ 'policy.json': policy() }, async (root) => {
    await mkdir(join(root, 'suites'))
    await writeFile(join(root, 'suites', 'upload.json'), JSON.stringify(suiteOf([fixtureCase()])))

    const result = await cliRun(['--root', root, '--suite', 'suites/upload.json', '--json'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).summary.checked, 1)
  })
})

test('a name that steps outside the root is a configuration error with an empty stdout', async () => {
  await withRoot(inputs(), async (root) => {
    for (const name of ['../elsewhere.json', '/etc/passwd', `suite${FORBIDDEN['C0 LF']}.json`, '']) {
      const result = await cliRun(['--root', root, '--suite', name, '--json'])
      assert.equal(result.code, 2, `"${name}" must be refused`)
      assert.equal(result.stdout, '', 'a configuration error never had a subject, so stdout stays empty')
    }
  })
})

test('an input that is missing, or is a directory, is reported as unreadable and never as a pass', async () => {
  await withRoot({ 'policy.json': policy() }, async (root) => {
    const missing = await cliRun(['--root', root, '--json'])
    const missingReport = JSON.parse(missing.stdout)
    assert.equal(missing.code, 2)
    assert.equal(missingReport.status, 'incomplete')
    assert.deepEqual(raisedRules(missingReport), ['input-unreadable'])

    await mkdir(join(root, 'suite.json'))
    const directory = await cliRun(['--root', root, '--json'])
    const directoryReport = JSON.parse(directory.stdout)
    assert.equal(directory.code, 2)
    assert.equal(directoryReport.status, 'incomplete')
    assert.equal(findingsFor(directoryReport, 'input-unreadable')[0].message.includes('not a regular file'), true)
  })
})

test('a root that is not a directory is a configuration error, and the API throws rather than reporting', async () => {
  await withRoot(inputs(), async (root) => {
    await assert.rejects(
      () => runFixtureSuite({ root: join(root, 'policy.json') }),
      /--root must be a directory/,
    )
    await assert.rejects(() => runFixtureSuite({ root: join(root, 'nowhere') }), /--root could not be resolved/)
  })
})

test('an unknown option to the API throws, naming the options that exist', async () => {
  await withRoot(inputs(), async (root) => {
    await assert.rejects(() => runFixtureSuite({ root, policies: 'policy.json' }), /Unknown option "policies"/)
  })
})
