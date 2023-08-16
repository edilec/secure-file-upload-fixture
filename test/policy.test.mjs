import assert from 'node:assert/strict'
import test from 'node:test'

import { compilePolicy } from '../src/index.mjs'
import { apiReport, collectingSink, compiled, fixture, fixtureCase, policy, pngType, raisedRules, txtType } from './support.mjs'

/**
 * The policy compiler.
 *
 * A policy is configuration that decides what may be uploaded, so every field
 * is required to be present and well-formed and every unknown key is refused.
 * A key the tool does not read is a key whose value nobody checks, and a
 * one-character typo that silently disables a rule is the difference between
 * a policy and a decoration.
 */

function refuse(document) {
  const sink = collectingSink()
  const result = compilePolicy(sink, 'policy.json', document)
  return { result, rows: sink.rows }
}

test('a complete policy compiles into an allow-list and a media-type index', () => {
  const subject = compiled(policy())

  assert.deepEqual([...subject.types.keys()], ['png', 'txt'])
  assert.equal(subject.types.get('png').signature, 'png')
  assert.equal(subject.types.get('txt').signature, null)
  assert.deepEqual([...subject.mimeIndex].sort(), ['image/png', 'text/plain'])
  assert.equal(subject.compiledTypes, 2)
  assert.equal(subject.declaredTypes, 2)
})

test('every malformed policy field is refused under policy-invalid, at its own pointer', () => {
  const cases = [
    ['', 'a policy that is not an object', []],
    ['/schemaVersion', 'the wrong schema version', policy({ schemaVersion: '2' })],
    ['/maxBytes', 'a maxBytes that is not a positive integer', policy({ maxBytes: 0 })],
    ['/maxBytes', 'a maxBytes that is a string', policy({ maxBytes: '4096' })],
    ['/allowEmpty', 'an unstated allowEmpty', policy({ allowEmpty: undefined })],
    ['/allowMultipleExtensions', 'an unstated allowMultipleExtensions', policy({ allowMultipleExtensions: 'no' })],
    ['/onUnknown', 'an onUnknown nobody stated', policy({ onUnknown: undefined })],
    ['/onUnknown', 'an onUnknown with an invented value', policy({ onUnknown: 'warn' })],
    ['/filenamePolicy', 'a filenamePolicy that is not an object', { ...policy(), filenamePolicy: null }],
    ['/filenamePolicy/style', 'an unknown stored-name style', policy({ filenamePolicy: { style: 'original' } })],
    ['/filenamePolicy/prefix', 'a prefix with a path segment in it', policy({ filenamePolicy: { prefix: '../up' } })],
    ['/filenamePolicy/preserveOriginalName', 'an unstated preserveOriginalName', policy({ filenamePolicy: { preserveOriginalName: undefined } })],
    ['/types', 'types that are not an array', policy({ types: {} })],
    ['/types/0/extension', 'an extension with a dot in it', policy({ types: [pngType({ extension: '.png' })] })],
    ['/types/0/extension', 'an uppercase extension', policy({ types: [pngType({ extension: 'PNG' })] })],
    ['/types/0/mimeTypes', 'a type with no media types', policy({ types: [pngType({ mimeTypes: [] })] })],
    ['/types/0/mimeTypes/0', 'a media type carrying parameters', policy({ types: [pngType({ mimeTypes: ['image/png; charset=binary'] })] })],
    ['/types/0/signature', 'a signature nobody has published', policy({ types: [pngType({ signature: 'magic' })] })],
    ['/types/0/signature', 'a signature key left out entirely', policy({ types: [{ extension: 'png', mimeTypes: ['image/png'] }] })],
    ['/types/0/maxBytes', 'a per-type maxBytes that is not an integer', policy({ types: [pngType({ maxBytes: 1.5 })] })],
  ]

  for (const [pointer, label, document] of cases) {
    const { result, rows } = refuse(document)
    assert.equal(rows.length, 1, label)
    assert.equal(rows[0].ruleId, 'policy-invalid', label)
    assert.equal(rows[0].pointer, pointer, label)
    if (pointer.startsWith('/types/')) {
      // One refused entry leaves the rest of the document standing, and the
      // caller turns the shortfall into an incomplete run; a refused document
      // reaches no decision at all.
      assert.equal(result.compiledTypes < result.declaredTypes, true, `${label} must not quietly become part of the allow-list`)
    } else {
      assert.equal(result, null, `${label} must not compile`)
    }
  }
})

test('an unknown key is refused and its value is never reported', () => {
  const { result, rows } = refuse(policy({ allowExecutables: 'AKIAIOSFODNN7EXAMPLE' }))

  assert.equal(result, null)
  assert.equal(rows[0].ruleId, 'policy-invalid')
  assert.match(rows[0].message, /allowExecutables/)
  assert.equal(JSON.stringify(rows).includes('AKIAIOSFODNN7EXAMPLE'), false, 'the key is named; the value is not')
})

test('a duplicate extension is refused rather than resolved by document order', async () => {
  const report = await apiReport(fixture(
    policy({ types: [pngType(), pngType({ mimeTypes: ['image/apng'] })] }),
    [fixtureCase()],
  ))

  assert.equal(raisedRules(report).includes('policy-invalid'), true)
  assert.equal(report.status, 'incomplete', 'a policy missing one of its types is not the policy its author wrote')
  assert.equal(report.summary.types, 1)
})

test('one refused type does not quietly become a narrower policy', async () => {
  const report = await apiReport(fixture(
    policy({ types: [pngType(), txtType({ signature: 'gzip' })] }),
    [fixtureCase()],
  ))

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.types, 1)
  assert.equal(raisedRules(report).includes('policy-invalid'), true)
})

test('a fail-open policy is named under its own rule and stops the run', () => {
  const { result, rows } = refuse(policy({ onUnknown: 'accept' }))

  assert.equal(result, null)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ruleId, 'policy-fail-open')
  assert.equal(rows[0].pointer, '/onUnknown')
})
