import assert from 'node:assert/strict'
import test from 'node:test'

import { REJECTION_REASONS, decide, splitFilename, storedName, withSignature } from '../src/index.mjs'
import { FORBIDDEN, compiled, digestName, pngType, policy, txtType } from './support.mjs'

/**
 * The validator, one decision at a time.
 *
 * Each case names the exact reason, not "a rejection": the checks run in a
 * documented order, and a fixture that stops distinguishing "the extension is
 * not on the list" from "the file was empty" has stopped testing anything.
 */

const png = (bytes = 64) => withSignature('png', bytes)
const padding = (length, byte = 0x41) => new Uint8Array(length).fill(byte)

const candidate = (overrides = {}) => ({
  filename: 'photo.png',
  declaredMimeType: 'image/png',
  bytes: png(64),
  ...overrides,
})

test('a candidate that satisfies every rule is accepted, and that is the only way in', () => {
  const outcome = decide(compiled(policy()), candidate())

  assert.equal(outcome.decision, 'accept')
  assert.equal(outcome.reason, 'accepted')
  assert.equal(outcome.type.extension, 'png')
})

test('every rejection reason in the catalog is reachable, and each names itself', () => {
  const wide = compiled(policy({ maxBytes: 128 }))
  const cases = [
    ['filename-empty', candidate({ filename: '' })],
    ['filename-too-long', candidate({ filename: `${'a'.repeat(300)}.png` })],
    ['filename-unsafe-characters', candidate({ filename: `photo${FORBIDDEN['bidi RLO']}gnp.exe` })],
    ['filename-path-segment', candidate({ filename: 'images/photo.png' })],
    ['filename-reserved', candidate({ filename: 'CON.png' })],
    ['extension-missing', candidate({ filename: 'README' })],
    ['extension-multiple', candidate({ filename: 'invoice.pdf.png' })],
    ['extension-unknown', candidate({ filename: 'setup.exe' })],
    ['mime-missing', candidate({ declaredMimeType: '' })],
    ['mime-unknown', candidate({ declaredMimeType: 'application/x-msdownload' })],
    ['mime-extension-mismatch', candidate({ filename: 'notes.txt', declaredMimeType: 'image/png', bytes: padding(16) })],
    ['size-empty', candidate({ bytes: new Uint8Array(0) })],
    ['size-over-limit', candidate({ bytes: png(256) })],
    ['content-signature-absent', candidate({ bytes: padding(4) })],
    ['content-signature-mismatch', candidate({ bytes: padding(64) })],
  ]

  for (const [reason, subject] of cases) {
    const outcome = decide(wide, subject)
    assert.equal(outcome.decision, 'reject', `${reason} must be a rejection`)
    assert.equal(outcome.reason, reason)
    assert.equal(typeof outcome.detail, 'string')
    assert.equal(outcome.detail.length > 0, true, `${reason} must say why`)
  }
  assert.deepEqual(cases.map(([reason]) => reason), [...REJECTION_REASONS], 'every catalog reason is covered here, in catalog order')
})

test('the check order is fixed, so a candidate that trips two rules reports the first', () => {
  const subject = compiled(policy({ maxBytes: 8 }))

  // Oversized *and* the wrong media type: the media type is checked first.
  assert.equal(decide(subject, candidate({ declaredMimeType: 'text/plain', bytes: png(64) })).reason, 'mime-extension-mismatch')
  // An unknown extension *and* an unknown media type: the extension is first.
  assert.equal(decide(subject, candidate({ filename: 'setup.exe', declaredMimeType: 'application/x-msdownload' })).reason, 'extension-unknown')
  // A path segment *and* an unknown extension: the filename is first.
  assert.equal(decide(subject, candidate({ filename: 'bin/setup.exe' })).reason, 'filename-path-segment')
  // Empty *and* over a limit is not possible; empty is checked before size.
  assert.equal(decide(subject, candidate({ bytes: new Uint8Array(0) })).reason, 'size-empty')
})

test('a media type is matched case-insensitively and never by prefix', () => {
  const subject = compiled(policy())

  assert.equal(decide(subject, candidate({ declaredMimeType: 'IMAGE/PNG' })).decision, 'accept')
  assert.equal(decide(subject, candidate({ declaredMimeType: '  image/png  ' })).decision, 'accept')
  assert.equal(decide(subject, candidate({ declaredMimeType: 'image/png; charset=binary' })).reason, 'mime-unknown')
  assert.equal(decide(subject, candidate({ declaredMimeType: 'image/png2' })).reason, 'mime-unknown')
})

test('a per-type size limit overrides the policy limit in both directions', () => {
  const tight = compiled(policy({ maxBytes: 4096, types: [pngType({ maxBytes: 100 }), txtType()] }))
  const loose = compiled(policy({ maxBytes: 32, types: [pngType({ maxBytes: 4096 }), txtType()] }))

  assert.equal(decide(tight, candidate({ bytes: png(128) })).reason, 'size-over-limit')
  assert.equal(decide(tight, candidate({ bytes: png(100) })).decision, 'accept')
  assert.equal(decide(loose, candidate({ bytes: png(128) })).decision, 'accept')
})

test('a type with no signature is accepted on its declared type alone, and says so by declaring null', () => {
  const subject = compiled(policy())
  const outcome = decide(subject, candidate({ filename: 'notes.txt', declaredMimeType: 'text/plain', bytes: padding(16) }))

  assert.equal(outcome.decision, 'accept')
  assert.equal(outcome.type.signature, null, 'the policy stated on purpose that these bytes cannot be checked')
})

test('allowMultipleExtensions and allowEmpty are honoured, and are refusals by default', () => {
  const strict = compiled(policy())
  const permissive = compiled(policy({ allowMultipleExtensions: true, allowEmpty: true, types: [txtType()] }))

  assert.equal(decide(strict, candidate({ filename: 'invoice.pdf.png' })).reason, 'extension-multiple')
  assert.equal(decide(permissive, candidate({ filename: 'invoice.exe.txt', declaredMimeType: 'text/plain', bytes: padding(4) })).decision, 'accept')
  assert.equal(decide(permissive, candidate({ filename: 'empty.txt', declaredMimeType: 'text/plain', bytes: new Uint8Array(0) })).decision, 'accept')
})

test('splitFilename reports what is there and judges nothing', () => {
  assert.deepEqual(splitFilename('photo.png'), { stem: 'photo', extensions: ['png'] })
  assert.deepEqual(splitFilename('archive.tar.gz'), { stem: 'archive', extensions: ['tar', 'gz'] })
  assert.deepEqual(splitFilename('README'), { stem: 'README', extensions: [] })
  assert.deepEqual(splitFilename('.hidden'), { stem: '', extensions: ['hidden'] })
})

test('the stored name is derived from the bytes and the canonical extension, never from the upload', () => {
  const subject = compiled(policy())
  const bytes = png(64)
  const stored = storedName(subject, { extension: 'png', bytes, sequence: 1, filename: 'Holiday Photo (final).PNG' })

  assert.equal(stored.name, digestName(bytes, 'png'))
  assert.equal(stored.safe, true)
  assert.deepEqual(stored.problems, [])
  assert.equal(stored.name.includes('holiday'), false)
  assert.equal(stored.name.includes('Holiday'), false)
  assert.equal(stored.name.endsWith('.png'), true, 'the extension comes from the accepted type, not from the filename')
})

test('a sequence-style name is the counter and nothing else', () => {
  const subject = compiled(policy({ filenamePolicy: { style: 'sequence' } }))
  const stored = storedName(subject, { extension: 'png', bytes: png(64), sequence: 7, filename: 'whatever.png' })

  assert.equal(stored.name, 'upload-000007.png')
  assert.equal(stored.safe, true)
})

test('a policy that keeps the uploaded stem produces a name this tool calls unsafe', () => {
  const subject = compiled(policy({ filenamePolicy: { style: 'sequence', preserveOriginalName: true } }))
  const stored = storedName(subject, { extension: 'png', bytes: png(64), sequence: 2, filename: 'Holiday Photo (final).PNG' })

  assert.equal(stored.name, 'upload-000002-holiday-photo-final.png')
  assert.equal(stored.derived, 'upload-000002.png')
  assert.equal(stored.safe, false)
  assert.deepEqual(stored.problems, ['it carries text from the uploaded filename'])
})

test('the safety check compares against the derived name rather than searching for a substring', () => {
  // A stem that looks like hex would make a substring test fire at random
  // against a digest. The comparison is exact instead, so this accepted case
  // is safe and stays safe.
  const subject = compiled(policy())
  const bytes = png(64)
  const stored = storedName(subject, { extension: 'png', bytes, sequence: 1, filename: 'abc.png' })

  assert.equal(stored.safe, true)
  assert.equal(stored.name, stored.derived)
})
