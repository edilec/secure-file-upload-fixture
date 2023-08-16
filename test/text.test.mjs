import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit, decodeUtf8, describeValue, excerpt, hasForbiddenCharacter, isCaseId, isPlainObject, unknownKeys } from '../src/text.mjs'
import { FORBIDDEN } from './support.mjs'

/** The module every untrusted string passes through on its way to a report. */

test('excerpt removes every forbidden class and collapses the whitespace controls', () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    const cleaned = excerpt(`before${character}after`)
    assert.equal(hasForbiddenCharacter(cleaned), false, label)
    assert.match(cleaned, /^before ?after$/, label)
  }
})

test('excerpt is bounded, and says that it truncated', () => {
  assert.equal(excerpt('a'.repeat(200)).length, 163)
  assert.equal(excerpt('a'.repeat(200)).endsWith('...'), true)
  assert.equal(excerpt('short'), 'short')
  assert.equal(excerpt('a'.repeat(20), 10), `${'a'.repeat(10)}...`)
})

test('hasForbiddenCharacter covers all four classes plus the ASCII whitespace controls', () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    assert.equal(hasForbiddenCharacter(`x${character}y`), true, label)
  }
  for (const character of ['\t', '\n', '\r']) assert.equal(hasForbiddenCharacter(character), true)
  for (const text of ['plain', 'a-b_c.d', 'Ünïcödé', 'مرحبا', '', ' ']) {
    assert.equal(hasForbiddenCharacter(text), false, `${text} is legitimate text`)
  }
})

test('a case id is a narrow, refusable label rather than something to clean up', () => {
  for (const id of ['a', 'A1', 'case-1', 'case_1', 'case.1', 'a'.repeat(64)]) {
    assert.equal(isCaseId(id), true, id)
  }
  for (const id of ['', '-leading', '.leading', 'a'.repeat(65), 'a/b', 'a b', '..', 'a..b', 7, null, `a${FORBIDDEN['C1 NEL']}b`]) {
    assert.equal(isCaseId(id), false, String(id))
  }
})

test('describeValue says what a value was without reproducing any of it', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(7), 'an integer')
  assert.equal(describeValue(7.5), 'a number')
  assert.equal(describeValue('AKIAIOSFODNN7EXAMPLE'), 'a string of 20 character(s)')
  assert.equal(describeValue(['a', 'b']), 'an array of 2 item(s)')
  assert.equal(describeValue({ a: 1 }), 'an object')
})

test('decoding is the decoder\'s decision and never an inference from the decoded text', () => {
  assert.deepEqual(decodeUtf8(new TextEncoder().encode('{"a":1}')), { ok: true, text: '{"a":1}' })
  assert.deepEqual(decodeUtf8(new Uint8Array([0xff, 0xfe, 0x00])), { ok: false, reason: 'not-utf8' })
  // A file that legitimately contains U+FFFD decodes; inferring from the text
  // would call this one undecodable, which is how a sibling tool let an unread
  // input report a pass.
  assert.equal(decodeUtf8(new TextEncoder().encode('replacement: �')).ok, true)
})

test('byCodeUnit is a strict order over UTF-16 code units', () => {
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.equal(byCodeUnit('b', 'a'), 1)
})

test('isPlainObject refuses arrays, null and anything with a foreign prototype', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Map()), false)
  assert.equal(isPlainObject('x'), false)
})

test('unknownKeys reports what is not allowed, in code-unit order', () => {
  assert.deepEqual(unknownKeys({ b: 1, a: 2, Z: 3 }, ['a']), ['Z', 'b'])
  assert.deepEqual(unknownKeys({ a: 1 }, ['a', 'b']), [])
})
