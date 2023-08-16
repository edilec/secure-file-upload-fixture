import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTENT_KINDS, DEFAULT_LIMITS, compileSuite } from '../src/index.mjs'
import { FORBIDDEN, apiReport, collectingSink, fixture, fixtureCase, findingsFor, policy, raisedRules, suiteOf } from './support.mjs'

/**
 * The fixture suite compiler.
 *
 * A case that does not compile is not evaluated, and a case that is not
 * evaluated is not evidence. Every refusal here therefore makes the run
 * incomplete rather than failed: the tool learned nothing about that fixture,
 * which is a different statement from "that fixture disagreed".
 */

function compile(cases, limits = DEFAULT_LIMITS) {
  const sink = collectingSink()
  const result = compileSuite(sink, 'suite.json', suiteOf(cases), limits)
  return { result, rows: sink.rows }
}

test('a valid suite compiles in code-unit order by id, whatever order it was written in', () => {
  const { result, rows } = compile([
    fixtureCase({ id: 'zulu' }),
    fixtureCase({ id: 'Alpha' }),
    fixtureCase({ id: 'alpha' }),
  ])

  assert.deepEqual(rows, [])
  assert.deepEqual(result.cases.map((entry) => entry.id), ['Alpha', 'alpha', 'zulu'])
  assert.equal(result.declared, 3)
})

test('the suite document itself is refused under suite-invalid', () => {
  for (const [pointer, document] of [
    ['', 42],
    ['/schemaVersion', { schemaVersion: '9', cases: [] }],
    ['/cases', { schemaVersion: '1', cases: 'none' }],
    ['', { schemaVersion: '1', cases: [], extra: true }],
  ]) {
    const sink = collectingSink()
    const result = compileSuite(sink, 'suite.json', document, DEFAULT_LIMITS)
    assert.equal(result, null)
    assert.equal(sink.rows.length, 1)
    assert.equal(sink.rows[0].ruleId, 'suite-invalid')
    assert.equal(sink.rows[0].pointer, pointer)
  }
})

test('every malformed case field is refused under case-invalid, at its own pointer', () => {
  const cases = [
    ['/cases/0', 'a case that is not an object', 'case'],
    ['/cases/0/id', 'an id with a path segment', fixtureCase({ id: '../escape' })],
    ['/cases/0/id', 'an id with a control character', fixtureCase({ id: `case${FORBIDDEN['C0 LF']}two` })],
    ['/cases/0/id', 'an id that is not a string', fixtureCase({ id: 7 })],
    ['/cases/0', 'an unknown case key', fixtureCase({ payload: 'x' })],
    ['/cases/0/filename', 'a filename that is not a string', fixtureCase({ filename: null })],
    ['/cases/0/declaredMimeType', 'a media type that is not a string', fixtureCase({ declaredMimeType: 7 })],
    ['/cases/0/description', 'a description that is not a string', fixtureCase({ description: [] })],
    ['/cases/0/content', 'content that is not an object', fixtureCase({ content: 'png' })],
    ['/cases/0/content/kind', 'a content kind that does not exist', fixtureCase({ content: { kind: 'base64', data: 'AAAA' } })],
    ['/cases/0/content', 'an unknown content key', fixtureCase({ content: { kind: 'empty', data: 'AAAA' } })],
    ['/cases/0/content/bytes', 'a negative byte count', fixtureCase({ content: { kind: 'padding', byte: 0, bytes: -1 } })],
    ['/cases/0/content/byte', 'a padding byte outside a byte', fixtureCase({ content: { kind: 'padding', byte: 256, bytes: 4 } })],
    ['/cases/0/content/bytes', 'a signature that does not fit', fixtureCase({ content: { kind: 'signature', signature: 'png', bytes: 4 } })],
    ['/cases/0/expect', 'an expectation that is not an object', fixtureCase({ expect: 'accept' })],
    ['/cases/0/expect/decision', 'a decision nobody defined', fixtureCase({ expect: { decision: 'maybe' } })],
    ['/cases/0/expect/reason', 'a rejection with no reason', fixtureCase({ expect: { decision: 'reject' } })],
    ['/cases/0/expect/reason', 'a rejection reason that is not in the catalog', fixtureCase({ expect: { decision: 'reject', reason: 'looks-wrong' } })],
    ['/cases/0/expect/reason', 'an acceptance carrying a rejection reason', fixtureCase({ expect: { decision: 'accept', reason: 'size-empty' } })],
    ['/cases/0/expect/generatedName', 'a rejection carrying a stored name', fixtureCase({ expect: { decision: 'reject', reason: 'size-empty', generatedName: 'upload-1.png' } })],
    ['/cases/0/expect/generatedName', 'a stored name that is not a string', fixtureCase({ expect: { decision: 'accept', generatedName: 5 } })],
  ]

  for (const [pointer, label, entry] of cases) {
    const { result, rows } = compile([entry])
    assert.equal(rows.length, 1, label)
    assert.equal(rows[0].ruleId, 'case-invalid', label)
    assert.equal(rows[0].pointer, pointer, label)
    assert.equal(result.cases.length, 0, `${label} must not be evaluated`)
    assert.equal(result.declared, 1, label)
  }
})

test('a case may declare a filename the validator will refuse, because that is the point', () => {
  const { result, rows } = compile([
    fixtureCase({ id: 'long', filename: `${'a'.repeat(300)}.png`, expect: { decision: 'reject', reason: 'filename-too-long' } }),
    fixtureCase({ id: 'empty-name', filename: '', expect: { decision: 'reject', reason: 'filename-empty' } }),
    fixtureCase({ id: 'no-type', declaredMimeType: '', expect: { decision: 'reject', reason: 'mime-missing' } }),
  ])

  assert.deepEqual(rows, [])
  assert.equal(result.cases.length, 3)
})

test('a duplicate id is refused, and the later declaration is not evaluated', async () => {
  const report = await apiReport(fixture(policy(), [
    fixtureCase({ id: 'twice' }),
    fixtureCase({ id: 'twice', filename: 'other.png' }),
  ]))

  assert.deepEqual(raisedRules(report), ['case-duplicate', 'no-rejection-exercised', 'reason-unexercised'])
  assert.equal(report.summary.cases, 2)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.unevaluated, 1)
  assert.equal(report.status, 'incomplete')
})

test('a signature this build does not know is unsupported, and is never guessed at', async () => {
  const report = await apiReport(fixture(policy(), [
    fixtureCase({ content: { kind: 'signature', signature: 'zip', bytes: 64 } }),
  ]))

  assert.equal(findingsFor(report, 'case-content-unsupported').length, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
})

test('there are exactly three content kinds, and none of them carries arbitrary bytes', () => {
  assert.deepEqual([...CONTENT_KINDS], ['empty', 'padding', 'signature'])

  for (const attempt of [
    { kind: 'base64', data: 'TUZQAA==' },
    { kind: 'text', text: '<script>alert(1)</script>' },
    { kind: 'file', path: '/etc/passwd' },
    { kind: 'raw', bytes: [0x4d, 0x5a] },
  ]) {
    const { result, rows } = compile([fixtureCase({ content: attempt })])
    assert.equal(result.cases.length, 0, `${attempt.kind} must not compile`)
    assert.equal(rows[0].ruleId, 'case-invalid')
    assert.equal(rows[0].pointer, '/cases/0/content/kind')
  }
})
