import assert from 'node:assert/strict'
import test from 'node:test'

import { runFixtureSuite, validateLimits } from '../src/index.mjs'
import { apiReport, cliReport, fixture, fixtureCase, findingsFor, policy, rejectCase, suiteOf, withRoot } from './support.mjs'

/**
 * Ordering, pinned by what the tool emits.
 *
 * A source scan for `.localeCompare(` is not a determinism test: `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output starts depending on the ICU data of whichever Node build is running.
 * Every case here feeds in values an English collator orders the other way
 * round, pushes them through the real path, and asserts the exact emitted
 * order -- so substituting a collator at that site fails a test rather than
 * going unnoticed.
 *
 * The collator is constructed in each test and asserted to disagree, which is
 * what makes these cases cases at all. The sites that cannot be pinned,
 * because their values are drawn from alphabets the two comparators order
 * identically, are enumerated and proved equivalent in
 * `test/ordering-equivalence.test.mjs` rather than left as gaps.
 */

const collator = new Intl.Collator('en')

const disagrees = (left, right) => {
  assert.equal(left < right, true, `${left} precedes ${right} by code unit`)
  assert.equal(collator.compare(left, right) > 0, true, `a collator would put ${right} first, which is what makes this a test`)
}

test('the case walk is ordered by code unit, so it decides which cases survive a cut-off', async () => {
  disagrees('Zebra', 'apple')

  // The two cases are deliberately not interchangeable: "apple" declares an
  // expectation it cannot meet, so if it were the case that ran -- which is
  // what an English collator would decide -- the report would carry a
  // disagreement. Under code-unit order it is never built, and the only
  // findings are the cut-off and the coverage notes.
  const { report } = await cliReport(fixture(policy(), [
    fixtureCase({ id: 'apple', expect: { decision: 'reject', reason: 'size-empty' } }),
    fixtureCase({ id: 'Zebra', filename: 'other.png' }),
  ]), ['--max-cases', '1'])

  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.unevaluated, 1)
  assert.equal(report.summary.accepted, 1)
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['no-rejection-exercised', 'reason-unexercised', 'too-many-cases'],
  )
  assert.equal(findingsFor(report, 'expected-reject-but-accepted').length, 0, '"apple" was never built')
})

test('the stored-name counter follows the same code-unit walk', async () => {
  disagrees('README', 'assets')

  const report = await apiReport(fixture(policy({ filenamePolicy: { style: 'sequence' } }), [
    fixtureCase({ id: 'assets', expect: { decision: 'accept', generatedName: 'upload-000001.png' } }),
    fixtureCase({ id: 'README', expect: { decision: 'accept', generatedName: 'upload-000002.png' } }),
  ]))

  // README is built first and takes counter 1, so both expectations above are
  // wrong under code-unit order and both are reported. Under collation they
  // would both be right and this test would see no findings at all.
  const mismatches = findingsFor(report, 'generated-name-mismatch')
  assert.equal(mismatches.length, 2)
  assert.deepEqual(mismatches.map((finding) => finding.location.pointer), ['/cases/0', '/cases/1'])
  assert.match(mismatches[0].message, /expected a different stored name/)
})

test('unknown keys in a document are listed by code unit', async () => {
  disagrees('Zebra', 'apple')

  const report = await apiReport({
    'policy.json': { ...policy(), apple: 1, Zebra: 2 },
    'suite.json': suiteOf([fixtureCase()]),
  })

  assert.match(findingsFor(report, 'policy-invalid')[0].message, /unknown key\(s\): Zebra, apple\./)
})

test('unknown keys in a case are listed by code unit too', async () => {
  const report = await apiReport(fixture(policy(), [{ ...fixtureCase(), apple: 1, Zebra: 2 }]))

  assert.match(findingsFor(report, 'case-invalid')[0].message, /unknown key\(s\): Zebra, apple\./)
})

test('the first unknown limit name reported is the first by code unit', () => {
  disagrees('Zebra', 'apple')

  assert.throws(() => validateLimits({ apple: 1, Zebra: 2 }), /Unknown limit "Zebra"/)
})

test('the first unknown option name reported is the first by code unit', async () => {
  await withRoot(fixture(policy(), [fixtureCase()]), async (root) => {
    await assert.rejects(() => runFixtureSuite({ root, apple: 1, Zebra: 2 }), /Unknown option "Zebra"/)
  })
})

test('findings are grouped by fixed input source role', async () => {
  const report = await apiReport({
    'Zebra.json': policy({ types: [] }),
    'apple.json': suiteOf([fixtureCase({ id: 'only', expect: { decision: 'accept' } })]),
  }, { policy: 'Zebra.json', suite: 'apple.json' })

  assert.deepEqual(report.findings.map((finding) => finding.location.file), ['@policy', '@suite', '@suite'])
  assert.equal(report.findings[0].ruleId, 'policy-no-types')
})

test('findings inside one source role are ordered by source pointer', async () => {
  const report = await apiReport(fixture(policy(), [
    fixtureCase({ id: 'apple', expect: { decision: 'reject', reason: 'size-empty' } }),
    fixtureCase({ id: 'Zebra', expect: { decision: 'reject', reason: 'size-empty' } }),
  ]))

  assert.deepEqual(
    report.findings.map((finding) => `${finding.location.pointer} ${finding.ruleId}`),
    [
      '/cases no-rejection-exercised',
      '/cases reason-unexercised',
      '/cases/0 expected-reject-but-accepted',
      '/cases/1 expected-reject-but-accepted',
    ],
  )
})

test('two findings about one case are ordered by rule id, then by emission order', async () => {
  // These two rule ids are ordered the same way by both comparators -- that
  // site is proved equivalent in test/ordering-equivalence.test.mjs rather
  // than pinned here. The pair is emitted in one fixed order even though the
  // stored name itself is private in the report.
  const report = await apiReport(fixture(
    policy({ filenamePolicy: { preserveOriginalName: true } }),
    [fixtureCase({ id: 'one', expect: { decision: 'accept', generatedName: 'upload-stale.png' } })],
  ))

  const about = report.findings.filter((finding) => finding.location.pointer === '/cases/0')
  assert.deepEqual(about.map((finding) => finding.ruleId), ['generated-name-mismatch', 'generated-name-unsafe'])
  assert.equal((about[1].evidence ?? '').includes('photo'), false)
})

test('two runs over the same inputs emit the same bytes, in the same order', async () => {
  const files = fixture(policy(), [
    fixtureCase({ id: 'Zebra', expect: { decision: 'reject', reason: 'size-empty' } }),
    fixtureCase({ id: 'apple' }),
    rejectCase({ id: 'README' }),
  ])
  const first = await cliReport(files)
  const second = await cliReport(files)

  assert.equal(first.stdout, second.stdout)
  assert.deepEqual(
    first.report.findings.map((finding) => `${finding.location.pointer} ${finding.ruleId}`),
    ['/cases reason-unexercised', '/cases/0 expected-reject-but-accepted'],
  )
})
