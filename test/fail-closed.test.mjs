import assert from 'node:assert/strict'
import test from 'node:test'

import { decide } from '../src/index.mjs'
import { cliReport, compiled, fixture, fixtureCase, policy, raisedRules, txtType } from './support.mjs'

/**
 * Fail closed: the property the whole tool exists to hold.
 *
 * An upload validator with a default-accept path has no allow-list, whatever
 * its allow-list says. These tests drive unknown extensions, unknown media
 * types and mismatched pairs through the real decision path and assert that
 * every one of them is refused -- and that a policy asking for the opposite
 * does not run at all.
 *
 * They are written so that removing the allow-list check is *observable*: the
 * corpus below is refused as a whole, and a single acceptance anywhere in it
 * fails a literal assertion here.
 */

const known = () => compiled(policy())

const candidate = (overrides = {}) => ({
  filename: 'photo.png',
  declaredMimeType: 'image/png',
  bytes: new Uint8Array(16).fill(0x41),
  ...overrides,
})

/** Extensions no reasonable image-and-text policy declares. */
const UNKNOWN_EXTENSIONS = [
  'exe', 'dll', 'so', 'sh', 'bat', 'cmd', 'com', 'scr', 'jar', 'php', 'phtml',
  'js', 'mjs', 'py', 'rb', 'pl', 'ps1', 'zip', 'tar', 'gz', 'svg', 'html',
  'htm', 'xml', 'ico', 'webp', 'bin', 'dat', 'unknown', 'PNG2', '',
]

const UNKNOWN_MEDIA_TYPES = [
  'application/x-msdownload', 'application/x-sh', 'application/zip',
  'text/html', 'image/svg+xml', 'application/octet-stream',
  'application/javascript', 'multipart/form-data', 'image/png2', 'x', '',
]

test('every unknown extension is refused, and none of them is refused for some other reason', () => {
  const subject = known()
  let refused = 0

  for (const extension of UNKNOWN_EXTENSIONS) {
    const filename = extension === '' ? 'payload' : `payload.${extension}`
    const outcome = decide(subject, candidate({ filename }))
    assert.equal(outcome.decision, 'reject', `"${filename}" must be refused`)
    assert.equal(
      ['extension-unknown', 'extension-missing'].includes(outcome.reason),
      true,
      `"${filename}" was refused for ${outcome.reason}, which is not the allow-list refusing it`,
    )
    refused += 1
  }

  assert.equal(refused, 31, 'the corpus is the one this assertion was written for')
})

test('every unknown media type is refused even when the extension is on the list', () => {
  const subject = known()

  for (const mediaType of UNKNOWN_MEDIA_TYPES) {
    const outcome = decide(subject, candidate({ filename: 'notes.txt', declaredMimeType: mediaType }))
    assert.equal(outcome.decision, 'reject', `"${mediaType}" must be refused`)
    assert.equal(['mime-unknown', 'mime-missing'].includes(outcome.reason), true, `refused for ${outcome.reason}`)
  }
})

test('a media type the policy knows, declared against the wrong extension, is refused', () => {
  const subject = known()
  const outcome = decide(subject, candidate({ filename: 'notes.txt', declaredMimeType: 'image/png' }))

  assert.equal(outcome.decision, 'reject')
  assert.equal(outcome.reason, 'mime-extension-mismatch')
})

test('a policy whose allow-list is empty accepts nothing at all', async () => {
  const { code, report } = await cliReport(fixture(policy({ types: [] }), [
    fixtureCase({ id: 'png', expect: { decision: 'reject', reason: 'extension-unknown' } }),
    fixtureCase({ id: 'txt', filename: 'notes.txt', declaredMimeType: 'text/plain', content: { kind: 'padding', byte: 65, bytes: 8 }, expect: { decision: 'reject', reason: 'extension-unknown' } }),
  ]))

  assert.equal(report.summary.accepted, 0)
  assert.equal(report.summary.rejected, 2)
  assert.equal(report.status, 'fail', 'an allow-list with nothing on it is reported, not quietly honoured')
  assert.equal(raisedRules(report).includes('policy-no-types'), true)
  assert.equal(code, 1)
})

test('a policy that asks to accept the unknown does not run, and reaches no decision at all', async () => {
  const { code, report, stderr } = await cliReport(fixture(policy({ onUnknown: 'accept' }), [fixtureCase()]))

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0, 'no decision was made under a fail-open policy')
  assert.equal(report.summary.accepted, 0)
  assert.deepEqual(raisedRules(report), ['policy-fail-open'])
  assert.equal(code, 2)
  assert.match(stderr, /incomplete/)
})

test('the accepted path needs every check to agree, so weakening any one of them is visible here', async () => {
  const bytes = { kind: 'signature', signature: 'png', bytes: 64 }
  const { code, report } = await cliReport(fixture(policy({ types: [txtType()] }), [
    // The extension is not on the list. Nothing else about this case is wrong.
    fixtureCase({ id: 'png-not-declared', content: bytes, expect: { decision: 'reject', reason: 'extension-unknown' } }),
  ]))

  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.accepted, 0)
  assert.equal(report.summary.rejected, 1)
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
})
