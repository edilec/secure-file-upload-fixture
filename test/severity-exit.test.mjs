import assert from 'node:assert/strict'
import { link, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliRun, fixture, fixtureCase, policy, rejectCase, suiteOf, withRoot } from './support.mjs'

/**
 * Severity, pinned by what actually happens.
 *
 * `test/severity-table.test.mjs` asserts the frozen table against the
 * documented catalog. That is worth having and it is not this: a table, a
 * catalog and a hand-written expected map are three declarations agreeing with
 * each other, and a coordinated edit of all three passes every assertion made
 * about them. One tool in this catalog had 40 of its 52 error rules survive
 * exactly that flip.
 *
 * This file shares no map, imports no table, and parameterises no expectation.
 * Every number and every severity word below is written out literally, and
 * every case runs the real binary and reads the real exit code. Demoting a
 * rule changes `fail` to `pass` and exit 1 to exit 0, or drops an error count
 * to zero on an incomplete run -- and no edit to a declaration can satisfy an
 * exit code.
 *
 * `rejectCase()` rides along in most scenarios so that the run has a refusal
 * to be evidence about; it never produces a finding of its own.
 */

async function run(files, args = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--json', ...args])
    return { code: result.code, report: JSON.parse(result.stdout), stderr: result.stderr }
  })
}

const only = (report, ruleId) => {
  const matches = report.findings.filter((finding) => finding.ruleId === ruleId)
  assert.equal(matches.length, 1, `exactly one ${ruleId} was expected`)
  return matches[0]
}

test('case-content-unsupported is an error, and the run is unfinished', async () => {
  const { code, report } = await run(fixture(policy(), [
    rejectCase(),
    fixtureCase({ content: { kind: 'signature', signature: 'zip', bytes: 64 } }),
  ]))

  assert.equal(only(report, 'case-content-unsupported').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(code, 2)
})

test('case-duplicate is an error, and the run is unfinished', async () => {
  const { code, report } = await run(fixture(policy(), [
    rejectCase(),
    fixtureCase({ id: 'twin' }),
    fixtureCase({ id: 'twin', filename: 'other.png' }),
  ]))

  assert.equal(only(report, 'case-duplicate').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(code, 2)
})

test('case-invalid is an error, and the run is unfinished', async () => {
  const { code, report } = await run(fixture(policy(), [rejectCase(), fixtureCase({ filename: 5 })]))

  assert.equal(only(report, 'case-invalid').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(code, 2)
})

test('case-too-large is an error, and the run is unfinished', async () => {
  const { code, report } = await run(fixture(policy(), [
    rejectCase(),
    fixtureCase({ id: 'big', content: { kind: 'padding', byte: 0, bytes: 5000 } }),
  ]), ['--max-case-bytes', '1000'])

  assert.equal(only(report, 'case-too-large').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(code, 2)
})

test('expected-accept-but-rejected is an error, and the run fails', async () => {
  const { code, report } = await run(fixture(policy(), [
    rejectCase(),
    fixtureCase({ id: 'x', filename: 'setup.exe', content: { kind: 'padding', byte: 0, bytes: 8 } }),
  ]))

  assert.equal(only(report, 'expected-accept-but-rejected').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.checked, 2)
  assert.equal(code, 1)
})

test('expected-reject-but-accepted is an error, and the run fails', async () => {
  const { code, report } = await run(fixture(policy(), [
    rejectCase(),
    fixtureCase({ id: 'x', expect: { decision: 'reject', reason: 'size-empty' } }),
  ]))

  assert.equal(only(report, 'expected-reject-but-accepted').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.checked, 2)
  assert.equal(code, 1)
})

test('generated-name-mismatch is an error, and the run fails', async () => {
  const { code, report } = await run(fixture(policy(), [
    rejectCase(),
    fixtureCase({ id: 'x', expect: { decision: 'accept', generatedName: 'upload-stale.png' } }),
  ]))

  assert.equal(only(report, 'generated-name-mismatch').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(code, 1)
})

test('generated-name-unsafe is an error, and the run fails', async () => {
  const { code, report } = await run(fixture(
    policy({ filenamePolicy: { preserveOriginalName: true } }),
    [rejectCase(), fixtureCase({ id: 'x' })],
  ))

  assert.equal(only(report, 'generated-name-unsafe').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(code, 1)
})

test('input-not-json is an error, and the run is unfinished', async () => {
  const { code, report } = await run({ 'policy.json': policy(), 'suite.json': 'nope' })

  assert.equal(only(report, 'input-not-json').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(code, 2)
})

test('input-not-utf8 is an error, and the run is unfinished', async () => {
  const { code, report } = await run({ 'policy.json': policy(), 'suite.json': new Uint8Array([0xff, 0xfe]) })

  assert.equal(only(report, 'input-not-utf8').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(code, 2)
})

test('input-too-large is an error, and the run is unfinished', async () => {
  const { code, report } = await run(fixture(policy(), [fixtureCase()]), ['--max-file-bytes', '10'])

  assert.equal(report.findings.filter((finding) => finding.ruleId === 'input-too-large').length, 2)
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.findings[1].severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(code, 2)
})

test('input-unreadable is an error, and the run is unfinished', async () => {
  const { code, report } = await run({ 'policy.json': policy() })

  assert.equal(only(report, 'input-unreadable').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(code, 2)
})

test('no-cases-evaluated is an error, and the run is unfinished', async () => {
  const { code, report } = await run(fixture(policy(), []))

  assert.equal(only(report, 'no-cases-evaluated').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(code, 2)
})

test('no-rejection-exercised is a warning: it is reported, and it does not fail the run', async () => {
  const { code, report } = await run(fixture(policy(), [fixtureCase()]))

  assert.equal(only(report, 'no-rejection-exercised').severity, 'warning')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(code, 0)
})

test('output-not-written is an error, and the run is unfinished', async () => {
  await withRoot(fixture(policy(), [fixtureCase({ id: 'x' }), rejectCase()]), async (root) => {
    await withRoot({}, async (out) => {
      await writeFile(join(out, 'x.fixture'), 'already here')
      const result = await cliRun(['--root', root, '--json', '--out', out])
      const report = JSON.parse(result.stdout)

      assert.equal(only(report, 'output-not-written').severity, 'error')
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.errors, 1)
      assert.equal(report.summary.written, 1)
      assert.equal(result.code, 2)
    })
  })
})

test('output-not-written is still an error when the destination is a hard link to an input', async () => {
  await withRoot(fixture(policy(), [fixtureCase({ id: 'x' }), rejectCase()]), async (root) => {
    await withRoot({}, async (out) => {
      await link(join(root, 'policy.json'), join(out, 'x.fixture'))
      const result = await cliRun(['--root', root, '--json', '--out', out])
      const report = JSON.parse(result.stdout)

      assert.equal(only(report, 'output-not-written').severity, 'error')
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.errors, 1)
      assert.equal(result.code, 2)
    })
  })
})

test('path-escapes-root is an error, and the run is unfinished', async () => {
  await withRoot({}, async (outside) => {
    await writeFile(join(outside, 'elsewhere.json'), JSON.stringify(suiteOf([])))
    await withRoot({ 'policy.json': policy() }, async (root) => {
      await symlink(join(outside, 'elsewhere.json'), join(root, 'suite.json'))
      const result = await cliRun(['--root', root, '--json'])
      const report = JSON.parse(result.stdout)

      assert.equal(only(report, 'path-escapes-root').severity, 'error')
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.errors, 1)
      assert.equal(report.summary.checked, 0)
      assert.equal(result.code, 2)
    })
  })
})

test('policy-fail-open is an error, and no decision is reached', async () => {
  const { code, report } = await run(fixture(policy({ onUnknown: 'accept' }), [fixtureCase()]))

  assert.equal(only(report, 'policy-fail-open').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(code, 2)
})

test('policy-invalid is an error, and no decision is reached', async () => {
  const { code, report } = await run(fixture(policy({ maxBytes: 0 }), [fixtureCase()]))

  assert.equal(only(report, 'policy-invalid').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(code, 2)
})

test('policy-no-types is an error, and the run fails while still reaching decisions', async () => {
  const { code, report } = await run(fixture(policy({ types: [] }), [
    fixtureCase({ expect: { decision: 'reject', reason: 'extension-unknown' } }),
  ]))

  assert.equal(only(report, 'policy-no-types').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.checked, 1)
  assert.equal(code, 1)
})

test('reason-mismatch is an error, and the run fails', async () => {
  const { code, report } = await run(fixture(policy(), [
    rejectCase(),
    fixtureCase({ id: 'x', filename: 'setup.exe', content: { kind: 'padding', byte: 0, bytes: 8 }, expect: { decision: 'reject', reason: 'size-empty' } }),
  ]))

  assert.equal(only(report, 'reason-mismatch').severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(code, 1)
})

test('reason-unexercised is information: it is reported, and it changes nothing', async () => {
  const { code, report } = await run(fixture(policy(), [fixtureCase(), rejectCase()]))

  assert.equal(only(report, 'reason-unexercised').severity, 'info')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(code, 0)
})

test('suite-invalid is an error, and no decision is reached', async () => {
  const { code, report } = await run({ 'policy.json': policy(), 'suite.json': { schemaVersion: '1', cases: {} } })

  assert.equal(only(report, 'suite-invalid').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(code, 2)
})

test('too-many-cases is an error, and the run is unfinished', async () => {
  const { code, report } = await run(fixture(policy(), [fixtureCase({ id: 'a' }), rejectCase({ id: 'b' })]), ['--max-cases', '1'])

  assert.equal(only(report, 'too-many-cases').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.checked, 1)
  assert.equal(code, 2)
})

test('too-many-findings is an error, and the report says it is partial', async () => {
  const { code, report } = await run(fixture(policy(), [
    fixtureCase({ id: 'a', expect: { decision: 'reject', reason: 'size-empty' } }),
    rejectCase({ id: 'b', expect: { decision: 'accept' } }),
  ]), ['--max-findings', '1'])

  assert.equal(only(report, 'too-many-findings').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.findings.length, 1)
  assert.equal(code, 2)
})

test('total-bytes-exceeded is an error, and the run is unfinished', async () => {
  const { code, report } = await run(fixture(policy(), [
    fixtureCase({ id: 'a', content: { kind: 'signature', signature: 'png', bytes: 1024 } }),
    fixtureCase({ id: 'b', content: { kind: 'signature', signature: 'png', bytes: 1024 } }),
  ]), ['--max-total-bytes', '1500'])

  assert.equal(only(report, 'total-bytes-exceeded').severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(code, 2)
})

test('a run in which every fixture reached the outcome it declared is the only exit 0', async () => {
  const { code, report } = await run(fixture(policy(), [fixtureCase(), rejectCase()]))

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.accepted, 1)
  assert.equal(report.summary.rejected, 1)
  assert.equal(code, 0)
})
