import assert from 'node:assert/strict'
import test from 'node:test'

import { hasForbiddenCharacter } from '../src/index.mjs'
import { FORBIDDEN, apiReport, cliRun, findingsFor, fixture, fixtureCase, policy, suiteOf, withRoot } from './support.mjs'

/**
 * Sanitising every untrusted string that reaches output.
 *
 * The report contract names four classes -- C0, DEL, C1, the line and
 * paragraph separators, and the bidi controls -- and records that four tools
 * in this catalog stripped the first two and let C1 through. It also records
 * the subtler failure: a tool that sanitised its evidence field carefully and
 * left an identifier raw, so a record id holding a newline forged a whole line
 * in the human report.
 *
 * So each case here walks the *entire* serialised report and the entire stderr
 * stream, rather than the one field somebody remembered, and the arrival
 * points include an identifier as well as a value.
 */

const classes = Object.entries(FORBIDDEN)

/**
 * A stream's own line feeds are the one control it is allowed to carry, and
 * only because they are the stream's structure rather than content: they are
 * removed before the check so that everything else is still caught, and the
 * line *count* is asserted separately where forging a line would show.
 */
function assertClean(label, ...streams) {
  for (const stream of streams) {
    assert.equal(
      hasForbiddenCharacter(stream.split('\n').join('')),
      false,
      `${label}: a forbidden character survived into output`,
    )
  }
}

test('a forbidden character arriving through an identifier is refused and never echoed', async () => {
  for (const [label, character] of classes) {
    const report = await apiReport(fixture(policy(), [fixtureCase({ id: `case${character}two` })]))
    const serialised = JSON.stringify(report)

    assert.equal(findingsFor(report, 'case-invalid').length, 1, label)
    assert.match(findingsFor(report, 'case-invalid')[0].message, /id that is not/, label)
    assertClean(label, serialised)
    assert.equal(report.status, 'incomplete', `${label}: a case that was refused is not evidence`)
  }
})

test('a forbidden character arriving through a filename is evaluated, refused and sanitised', async () => {
  for (const [label, character] of classes) {
    const report = await apiReport(fixture(policy(), [fixtureCase({
      filename: `photo${character}.png`,
      expect: { decision: 'reject', reason: 'filename-unsafe-characters' },
    })]))

    assert.equal(report.status, 'pass', `${label}: the validator refuses it, which is the expected outcome`)
    assertClean(label, JSON.stringify(report))
  }
})

test('a forbidden character arriving through a declared media type is not echoed in evidence', async () => {
  for (const [label, character] of classes) {
    // The expectation is deliberately one this candidate cannot meet, so a
    // finding about the declared type is always emitted --
    // whether the validator refused the type or, for the classes that are
    // whitespace to `String.prototype.trim`, accepted the trimmed value.
    const report = await apiReport(fixture(policy(), [fixtureCase({
      declaredMimeType: `image/png${character}`,
      expect: { decision: 'reject', reason: 'size-empty' },
    })]))

    const about = report.findings.filter((finding) => finding.location.pointer === '/cases/0')
    assert.equal(about.length, 1, label)
    assert.equal(about[0].evidence.includes('image/png'), false, label)
    assert.match(about[0].evidence, /redacted/, label)
    assertClean(label, JSON.stringify(report))
  }
})

test('a forbidden character arriving through an unknown document key is sanitised in the message', async () => {
  for (const [label, character] of classes) {
    const report = await apiReport({
      'policy.json': { ...policy(), [`extra${character}key`]: true },
      'suite.json': suiteOf([fixtureCase()]),
    })

    assert.equal(findingsFor(report, 'policy-invalid').length, 1, label)
    assertClean(label, JSON.stringify(report))
  }
})

test('no forbidden character can forge a line in the human summary on stderr', async () => {
  const character = FORBIDDEN['C1 NEL']
  await withRoot(fixture(policy(), [fixtureCase({
    filename: `photo${character}ERROR   forged.json/ line${character}.png`,
    expect: { decision: 'accept' },
  })]), async (root) => {
    const result = await cliRun(['--root', root])

    assert.equal(result.code, 1)
    assertClean('stderr', result.stderr, result.stdout)
    // Three summary lines and one line per finding, and not one more.
    const lines = result.stderr.trimEnd().split('\n')
    assert.equal(lines.length, 3 + JSON.parse(result.stdout).findings.length)
  })
})

test('every string field of a finding is bounded as well as sanitised', async () => {
  const report = await apiReport(fixture(policy(), [fixtureCase({
    filename: `${'a'.repeat(1000)}.png`,
    expect: { decision: 'accept' },
  })]))

  for (const finding of report.findings) {
    assert.equal(finding.message.length <= 400, true)
    assert.equal((finding.evidence ?? '').length <= 163, true)
    assert.equal((finding.suggestion ?? '').length <= 300, true)
    assert.equal(finding.location.file.length <= 200, true)
    assert.equal(finding.location.pointer.length <= 200, true)
  }
  assert.match(findingsFor(report, 'expected-accept-but-rejected')[0].evidence, /redacted/)
  assert.equal(findingsFor(report, 'expected-accept-but-rejected')[0].evidence.includes('a'.repeat(100)), false)
})
