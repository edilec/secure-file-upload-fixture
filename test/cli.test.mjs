import assert from 'node:assert/strict'
import { access, constants, readFile } from 'node:fs/promises'
import test from 'node:test'

import { CLI, cliRun, fixture, fixtureCase, policy, rejectCase, withRoot } from './support.mjs'

/**
 * The command line, including the two shapes of exit 2.
 *
 * A configuration error means the run never had a subject, so stdout stays
 * empty and a consumer that pipes it gets nothing rather than a fabricated
 * report. An input that could not be read means the run had a subject and
 * failed to learn about it, so stdout carries an `incomplete` report naming
 * which input that was.
 */

const good = () => fixture(policy(), [fixtureCase(), rejectCase()])
const bad = () => fixture(policy(), [fixtureCase({ expect: { decision: 'reject', reason: 'size-empty' } }), rejectCase()])

test('--help and --version go to stdout and exit 0', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await cliRun([flag])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /Usage:/)
    assert.match(result.stdout, /Exit codes/)
    assert.match(result.stdout, /inert/)
    assert.equal(result.stderr, '')
  }
  for (const flag of ['-v', '--version']) {
    const result = await cliRun([flag])
    assert.equal(result.code, 0)
    assert.equal(result.stdout, '0.1.0\n')
  }
})

/**
 * "Exit 0 means stdout is the report" is a contract a consumer writes code
 * against, and it is false for `--help` and `--version`: both exit 0 with text
 * that is not JSON. They are not runs -- they answer about the tool, read
 * neither input and reach no policy decision -- so the fix is to say so where
 * a consumer reads the contract rather than to leave a parser to discover it.
 *
 * Both halves are pinned here so the wording cannot drift back: every way of
 * asking for the answer-about-the-tool must say in its own text that it is
 * outside the exit table, and every run that exits 0 must really put a
 * parseable report on stdout.
 */
test('the exit-0 contract is stated for runs, and the two flags outside it say so', async () => {
  const help = await cliRun(['--help'])

  assert.equal(help.code, 0)
  assert.throws(() => JSON.parse(help.stdout), 'the help text is not a report, which is the whole point')
  assert.match(help.stdout, /--help and --version are not runs/)
  assert.match(help.stdout, /Exit codes \(of a run; --help and --version exit 0 with their own text\):/)

  const manual = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(manual, /`--help` and `--version` are outside this table/)

  await withRoot(fixture(policy(), [fixtureCase()]), async (root) => {
    const run = await cliRun(['--root', root, '--json'])

    assert.equal(run.code, 0)
    assert.equal(JSON.parse(run.stdout).status, 'pass', 'a run that exits 0 really does put the report on stdout')
  })
})

test('the version the binary prints is the version in package.json', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const result = await cliRun(['--version'])

  assert.equal(result.stdout.trim(), manifest.version)
})

test('the binary is executable and starts with a shebang', async () => {
  await access(CLI, constants.X_OK)
  const source = await readFile(CLI, 'utf8')

  assert.equal(source.startsWith('#!/usr/bin/env node\n'), true)
})

test('a usage error keeps stdout empty and puts the message and the help on stderr', async () => {
  for (const argv of [[], ['--root'], ['--root', 'x', '--nope'], ['--root', 'x', '--max-cases'], ['--root', 'x', '--max-cases', 'many'], ['--root', 'x', '--max-cases', '0']]) {
    const result = await cliRun(argv)
    assert.equal(result.code, 2, argv.join(' '))
    assert.equal(result.stdout, '', `stdout must stay empty for: ${argv.join(' ')}`)
    assert.equal(result.stderr.length > 0, true)
  }
})

test('a value flag given twice is refused rather than silently last-wins', async () => {
  await withRoot(good(), async (root) => {
    const repeated = await cliRun(['--root', root, '--suite', 'suite.json', '--suite', 'other.json'])
    assert.equal(repeated.code, 2)
    assert.equal(repeated.stdout, '')
    assert.match(repeated.stderr, /--suite was given more than once/)

    const repeatedLimit = await cliRun(['--root', root, '--max-cases', '2', '--max-cases', '5'])
    assert.equal(repeatedLimit.code, 2)
    assert.match(repeatedLimit.stderr, /--max-cases was given more than once/)
  })
})

test('stdout carries the JSON report and nothing else, and stderr carries the summary', async () => {
  await withRoot(good(), async (root) => {
    const plain = await cliRun(['--root', root])
    assert.equal(plain.code, 0)
    const report = JSON.parse(plain.stdout)
    assert.equal(report.tool, 'secure-file-upload-fixture')
    assert.equal(report.schemaVersion, '1')
    assert.equal(plain.stdout.trimStart().startsWith('{'), true)
    assert.match(plain.stderr, /status pass/)
    assert.match(plain.stderr, /1 accepted, 1 rejected/)

    const quiet = await cliRun(['--root', root, '--json'])
    assert.equal(quiet.stderr, '', '--json suppresses the human summary')
    assert.equal(quiet.stdout, plain.stdout, 'the report does not change with the summary')
  })
})

test('exit 0, 1 and 2 follow the status, and an incomplete run says so on stderr', async () => {
  await withRoot(good(), async (root) => {
    assert.equal((await cliRun(['--root', root])).code, 0)
  })
  await withRoot(bad(), async (root) => {
    const failed = await cliRun(['--root', root, '--json'])
    assert.equal(failed.code, 1)
    assert.equal(JSON.parse(failed.stdout).status, 'fail')
  })
  await withRoot({ 'policy.json': policy(), 'suite.json': '{ not json' }, async (root) => {
    const incomplete = await cliRun(['--root', root])
    assert.equal(incomplete.code, 2)
    assert.equal(JSON.parse(incomplete.stdout).status, 'incomplete')
    assert.match(incomplete.stderr, /this run is not a pass/)
  })
})

test('two runs over identical inputs produce byte-identical stdout', async () => {
  await withRoot(good(), async (root) => {
    const first = await cliRun(['--root', root, '--json'])
    const second = await cliRun(['--root', root, '--json'])

    assert.equal(first.stdout, second.stdout)
    assert.equal(first.stdout.length > 0, true)
  })
})

test('the default input names are policy.json and suite.json, and both can be renamed', async () => {
  await withRoot({ 'upload-policy.json': policy(), 'cases.json': { schemaVersion: '1', cases: [fixtureCase()] } }, async (root) => {
    const defaults = await cliRun(['--root', root, '--json'])
    assert.equal(defaults.code, 2, 'the defaults are not there')

    const named = await cliRun(['--root', root, '--policy', 'upload-policy.json', '--suite', 'cases.json'])
    assert.equal(named.code, 0, named.stderr)
    assert.match(named.stderr, /policy @policy:/)
    assert.match(named.stderr, /suite @suite:/)
    assert.equal(named.stderr.includes('upload-policy.json'), false)
    assert.equal(named.stderr.includes('cases.json'), false)
  })
})
