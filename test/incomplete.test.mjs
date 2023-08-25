import assert from 'node:assert/strict'
import test from 'node:test'

import { cliReport, findingsFor, fixture, fixtureCase, policy, raisedRules, rejectCase, suiteOf, txtType } from './support.mjs'

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

/**
 * A decision reached without the evidence the tool's name suggests.
 *
 * `"signature": null` is a deliberate statement that a type's bytes cannot be
 * checked -- `text/plain` has no magic number -- so it is not a defect and the
 * run is not incomplete. It is still something the report has to say. Before
 * it did, a run whose every type declared a null signature accepted a fixture
 * whose leading bytes are `MZ` under a `.txt` name, reported status `pass` at
 * exit 0, and was indistinguishable from a run where every type was
 * byte-checked. README claimed "the report counts those types"; nothing in
 * `src/` counted them and `summary.types` was the total compiled count.
 *
 * Both halves are pinned. Remove the count and `typesWithoutSignature` is
 * gone; remove the finding and a reader of the findings list is told nothing.
 */
test('an acceptance whose type has no signature is reported as never having been byte-checked', async () => {
  const csvType = { extension: 'csv', mimeTypes: ['text/csv'], signature: null }
  const { code, report } = await cliReport(fixture(
    policy({ types: [txtType(), csvType] }),
    [
      // Leading bytes 0x4d ('M'), which is where an MZ executable starts. The
      // policy has no signature for `txt`, so nothing looks at them.
      fixtureCase({
        id: 'accept-txt',
        filename: 'notes.txt',
        declaredMimeType: 'text/plain',
        content: { kind: 'padding', byte: 0x4d, bytes: 12 },
        expect: { decision: 'accept' },
      }),
      rejectCase({ id: 'reject-exe', expect: { decision: 'reject', reason: 'extension-unknown' } }),
    ],
  ))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass', 'a null signature is a statement, not a defect')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)

  assert.equal(report.summary.types, 2)
  assert.equal(report.summary.typesWithoutSignature, 2, 'the report counts the types whose bytes cannot be checked')

  const disclosed = findingsFor(report, 'signature-unverifiable')
  assert.equal(disclosed.length, 1)
  assert.match(disclosed[0].message, /^1 of 1 acceptance\(s\) are for a type declaring no signature/)
  assert.match(disclosed[0].message, /no byte of their content checked/)
  assert.equal(disclosed[0].evidence, 'unverifiable type(s): txt')
  assert.equal(disclosed[0].severity, 'info')
})

/**
 * The other half of the same rule: it is raised from the acceptances, not from
 * the policy. A policy that lists an unverifiable type no fixture ever reaches
 * made no claim this run relied on, and a finding about it on every report is
 * noise a reader learns to skip past -- which is how the one that matters goes
 * unread.
 */
test('an unverifiable type no fixture reached raises nothing, and is still counted', async () => {
  const { code, report } = await cliReport(fixture(
    policy(),
    [fixtureCase(), rejectCase()],
  ))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.typesWithoutSignature, 1, 'the txt type in the default policy declares no signature')
  assert.equal(report.summary.accepted, 1)
  assert.equal(findingsFor(report, 'signature-unverifiable').length, 0)
})
