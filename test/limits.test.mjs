import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, FindingSink, HARD_LIMITS, compareRows, validateLimits } from '../src/index.mjs'
import { apiReport, cliReport, findingsFor, fixture, fixtureCase, policy, raisedRules, rejectCase } from './support.mjs'

/**
 * Limits: declared, enforced, and reported by name when they fire.
 *
 * Exceeding one is never a silent truncation. Each case below asserts the
 * finding, the count that stopped, and that the run is `incomplete` -- because
 * the cases nobody built are not evidence that they would have passed. The
 * budgets are re-checked after the walk as well as inside it: a budget that
 * runs out mid-loop and lets the exit fall through to the success branch is
 * how a tool in this catalog came to report a conclusion it had never reached.
 */

test('the default limits and their hard caps are exactly these numbers', () => {
  assert.deepEqual({ ...DEFAULT_LIMITS }, {
    maxCaseBytes: 1048576,
    maxCases: 500,
    maxFileBytes: 5242880,
    maxFindings: 1000,
    maxTotalBytes: 8388608,
  })
  assert.deepEqual({ ...HARD_LIMITS }, {
    maxCaseBytes: 67108864,
    maxCases: 5000,
    maxFileBytes: 67108864,
    maxFindings: 20000,
    maxTotalBytes: 268435456,
  })
})

test('an unknown limit name throws instead of being ignored', () => {
  assert.throws(() => validateLimits({ maxCase: 10 }), /Unknown limit "maxCase"/)
  assert.throws(() => validateLimits({ maxCase: 10 }), /maxCaseBytes, maxCases, maxFileBytes, maxFindings, maxTotalBytes/)
  assert.throws(() => validateLimits('none'), /limits must be an object/)
})

test('a limit may be lowered but never raised past its cap, and must be a positive integer', () => {
  assert.equal(validateLimits({ maxCases: 10 }).maxCases, 10)
  for (const value of [0, -1, 1.5, '10', null, HARD_LIMITS.maxCases + 1]) {
    assert.throws(() => validateLimits({ maxCases: value }), /maxCases must be an integer between 1 and 5000/)
  }
})

test('an input above maxFileBytes is not read, and the run is incomplete', async () => {
  const report = await apiReport(fixture(policy(), [fixtureCase()]), { limits: { maxFileBytes: 40 } })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(findingsFor(report, 'input-too-large').length, 2)
  assert.match(findingsFor(report, 'input-too-large')[0].message, /maxFileBytes limit of 40/)
})

test('a case above maxCaseBytes is not built, and is not counted as evidence', async () => {
  const report = await apiReport(fixture(policy(), [
    fixtureCase({ id: 'small' }),
    fixtureCase({ id: 'huge', content: { kind: 'padding', byte: 0, bytes: 5000 }, expect: { decision: 'reject', reason: 'size-over-limit' } }),
  ]), { limits: { maxCaseBytes: 1000 } })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.unevaluated, 1)
  assert.match(findingsFor(report, 'case-too-large')[0].message, /maxCaseBytes limit of 1000/)
})

test('the walk stops at maxCases, says how many were left, and does not report a pass', async () => {
  const { code, report } = await cliReport(fixture(policy(), [
    fixtureCase({ id: 'a-one' }),
    rejectCase({ id: 'b-two' }),
    fixtureCase({ id: 'c-three' }),
  ]), ['--max-cases', '2'])

  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.unevaluated, 1)
  assert.match(findingsFor(report, 'too-many-cases')[0].message, /maxCases limit of 2/)
  assert.match(findingsFor(report, 'too-many-cases')[0].message, /1 case\(s\) were not evaluated/)
})

test('the walk stops at maxTotalBytes, and the bytes it did build are reported', async () => {
  const report = await apiReport(fixture(policy(), [
    fixtureCase({ id: 'a-first', content: { kind: 'signature', signature: 'png', bytes: 1024 } }),
    fixtureCase({ id: 'b-second', content: { kind: 'signature', signature: 'png', bytes: 1024 } }),
  ]), { limits: { maxTotalBytes: 1500 } })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.bytesGenerated, 1024)
  assert.match(findingsFor(report, 'total-bytes-exceeded')[0].message, /maxTotalBytes limit of 1500/)
})

test('a report above maxFindings is truncated explicitly, and says the report is partial', async () => {
  const failing = [1, 2, 3, 4].map((index) => fixtureCase({
    id: `case-${index}`,
    expect: { decision: 'reject', reason: 'size-empty' },
  }))
  const { code, report } = await cliReport(fixture(policy(), failing), ['--max-findings', '2'])

  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(report.findings.length, 2)
  assert.equal(raisedRules(report).includes('too-many-findings'), true)
  assert.match(findingsFor(report, 'too-many-findings')[0].message, /maxFindings limit of 2/)
})

test('every limit flag on the command line reaches the limit it names', async () => {
  const cases = [fixtureCase({ id: 'a' }), fixtureCase({ id: 'b' })]
  const wired = [
    ['--max-cases', '1', 'too-many-cases'],
    ['--max-case-bytes', '1', 'case-too-large'],
    ['--max-total-bytes', '1', 'total-bytes-exceeded'],
    ['--max-file-bytes', '1', 'input-too-large'],
  ]

  for (const [flag, value, ruleId] of wired) {
    const { report } = await cliReport(fixture(policy(), cases), [flag, value])
    assert.equal(raisedRules(report).includes(ruleId), true, `${flag} must reach ${ruleId}`)
    assert.equal(report.status, 'incomplete', `${flag} must not report a pass`)
  }
})

/**
 * The finding sink, bounded by the report cap rather than by the input.
 *
 * Every row a run produced was kept until the report was assembled, so peak
 * memory tracked the number of *declared* cases and not the number of findings
 * anybody would read: a 64 MiB suite of malformed cases held gigabytes to
 * produce a report of 1000 findings. `maxCases` cannot bound it -- the compile
 * walk has to see every declared case before the cases are ordered by code
 * unit and cut, which is what test/ordering.test.mjs pins -- so the bound is
 * in the sink.
 *
 * The bound must not change the report, so the property asserted is equality
 * with the rows an unbounded sink would have handed to `compareRows`, not
 * merely "some rows survived". The rows arrive worst-case: each one sorts
 * before every row already held, so every trim has to discard rows it is
 * holding rather than rows arriving later.
 */
test('the finding sink holds the report cap, not the input, and keeps exactly the rows the report wants', () => {
  const limit = 4
  const arriving = 100
  const bounded = new FindingSink(limit)
  const unbounded = []

  for (let n = arriving; n > 0; n -= 1) {
    const row = {
      file: 'suite.json',
      pointer: `/cases/${String(n).padStart(4, '0')}`,
      ruleId: 'case-invalid',
      message: `case ${n}`,
    }
    bounded.add(row)
    unbounded.push({ pointer: '', ...row, order: unbounded.length })
    assert.equal(bounded.rows.length <= limit * 2, true, `the sink grew to ${bounded.rows.length}, past twice the cap`)
  }

  assert.equal(bounded.total, arriving, 'the truncation notice counts every row ever added')
  assert.deepEqual(
    [...bounded.rows].sort(compareRows).slice(0, limit),
    [...unbounded].sort(compareRows).slice(0, limit),
    'the rows kept are not the rows the report would have printed',
  )
})

test('a truncated report is the same report the unbounded sink would have produced', async () => {
  const failing = Array.from({ length: 40 }, (unused, index) => fixtureCase({
    id: `case-${String(index).padStart(3, '0')}`,
    expect: { decision: 'reject', reason: 'size-empty' },
  }))

  const whole = await apiReport(fixture(policy(), failing), { limits: { maxFindings: 1000 } })
  const cut = await apiReport(fixture(policy(), failing), { limits: { maxFindings: 5 } })

  assert.equal(whole.findings.length > 5, true, 'the corpus must really exceed the cut')
  assert.equal(cut.findings.length, 5)
  // The truncation notice carries an empty pointer, so it sorts ahead of every
  // `/cases` finding; what the cut keeps is the first four of the whole report
  // and that notice, in the report's own order.
  assert.deepEqual(
    cut.findings.filter((finding) => finding.ruleId !== 'too-many-findings'),
    whole.findings.slice(0, 4),
    'the cut report is not a prefix of the whole one',
  )
  const notice = cut.findings.filter((finding) => finding.ruleId === 'too-many-findings')
  assert.equal(notice.length, 1)
  assert.match(notice[0].message, new RegExp(`${whole.findings.length - 4} were not reported`))
})
