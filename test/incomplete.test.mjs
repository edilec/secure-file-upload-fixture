import assert from 'node:assert/strict'
import test from 'node:test'

import { cliReport, findingsFor, fixture, fixtureCase, policy, raisedRules, rejectCase, suiteOf } from './support.mjs'

/**
 * What must never be a pass.
 *
 * Every scenario here is a run that failed to obtain some piece of the
 * evidence it set out to obtain. The report contract has one word for that --
 * `incomplete` -- and it is not interchangeable with `pass`. A green run on no
 * evidence is worse than a red one: it is a claim.
 */

const NOT_UTF8 = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])

test('a suite with no cases is refused explicitly rather than passing on no evidence', async () => {
  const { code, report } = await cliReport(fixture(policy(), []))

  // Both halves are pinned here. Remove the `incomplete` flag and the status
  // becomes "fail"; remove the finding and the error count becomes 0. Neither
  // mutation can leave this test green.
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(code, 2)
  assert.deepEqual(raisedRules(report), ['no-cases-evaluated'])
  assert.match(findingsFor(report, 'no-cases-evaluated')[0].message, /no evidence to be green on/)
})

test('a suite whose every case is refused evaluates nothing, and says so', async () => {
  const { code, report } = await cliReport(fixture(policy(), [
    fixtureCase({ id: 'bad-one', expect: { decision: 'perhaps' } }),
    fixtureCase({ id: 'bad-two', content: { kind: 'padding', byte: 999, bytes: 4 } }),
  ]))

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.cases, 2)
  assert.equal(report.summary.unevaluated, 2)
  assert.equal(code, 2)
  assert.deepEqual(raisedRules(report), ['case-invalid', 'no-cases-evaluated'])
})

test('an input that is not UTF-8 is reported by the decoder, not inferred from the text', async () => {
  for (const name of ['policy.json', 'suite.json']) {
    const files = fixture(policy(), [fixtureCase()])
    files[name] = NOT_UTF8
    const { code, report } = await cliReport(files)

    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    assert.equal(findingsFor(report, 'input-not-utf8')[0].location.file, name)
    assert.equal(report.summary.checked, 0)
  }
})

test('an input that is not JSON is reported, and its text is not echoed', async () => {
  const files = fixture(policy(), [fixtureCase()])
  files['suite.json'] = '{ "cases": [ AKIAIOSFODNN7EXAMPLE ] }'
  const { code, report, stdout, stderr } = await cliReport(files)

  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(findingsFor(report, 'input-not-json').length, 1)
  assert.equal(stdout.includes('AKIAIOSFODNN7EXAMPLE'), false)
  assert.equal(stderr.includes('AKIAIOSFODNN7EXAMPLE'), false)
})

test('incomplete outranks fail: a run that both disagreed and stopped early is not a failure, it is unfinished', async () => {
  const { code, report } = await cliReport(fixture(policy(), [
    fixtureCase({ id: 'a-mismatch', expect: { decision: 'reject', reason: 'size-empty' } }),
    rejectCase({ id: 'b-fine' }),
    rejectCase({ id: 'c-never-built' }),
  ]), ['--max-cases', '2'])

  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.errors, 2, 'the disagreement is still reported')
  assert.equal(raisedRules(report).includes('expected-reject-but-accepted'), true)
  assert.equal(raisedRules(report).includes('too-many-cases'), true)
})

test('no scenario in which evidence was missing reaches pass or exit 0', async () => {
  const scenarios = [
    ['an unreadable suite', { 'policy.json': policy() }, []],
    ['a suite that is not JSON', { 'policy.json': policy(), 'suite.json': 'nope' }, []],
    ['a suite that is not an object', { 'policy.json': policy(), 'suite.json': suiteOf([]).cases }, []],
    ['a policy that is not an object', { 'policy.json': [], 'suite.json': suiteOf([fixtureCase()]) }, []],
    ['a policy asking to fail open', fixture(policy({ onUnknown: 'accept' }), [fixtureCase()]), []],
    ['a case this build cannot construct', fixture(policy(), [fixtureCase({ content: { kind: 'signature', signature: 'rar', bytes: 64 } })]), []],
    ['a suite cut short by a limit', fixture(policy(), [fixtureCase({ id: 'a' }), rejectCase({ id: 'b' })]), ['--max-cases', '1']],
    ['a report cut short by a limit', fixture(policy(), [
      fixtureCase({ id: 'a', expect: { decision: 'reject', reason: 'size-empty' } }),
      rejectCase({ id: 'b', expect: { decision: 'accept' } }),
    ]), ['--max-findings', '1']],
  ]

  for (const [label, files, args] of scenarios) {
    const { code, report } = await cliReport(files, args)
    assert.equal(report.status, 'incomplete', label)
    assert.notEqual(report.status, 'pass', label)
    assert.equal(code, 2, label)
  }
})

test('a run that obtained all of its evidence and agreed with all of it is the only pass', async () => {
  const { code, report } = await cliReport(fixture(policy(), [fixtureCase(), rejectCase()]))

  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.unevaluated, 0)
  assert.equal(report.summary.errors, 0)
})
