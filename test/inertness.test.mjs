import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { SIGNATURES, SIGNATURE_NAMES, buildContent, signatureLength, withSignature } from '../src/index.mjs'
import { cliRun, fixture, fixtureCase, policy, suiteOf, withRoot } from './support.mjs'

/**
 * Inertness, asserted on the bytes themselves.
 *
 * The claim in the README is narrow and absolute: every fixture this tool can
 * build is zero bytes, one byte value repeated, or a published signature
 * followed by zeros. These tests read the bytes back -- in memory and from
 * disk -- and assert exactly that, so a content kind that could carry
 * something else would have to break one of them.
 */

test('an empty fixture is zero bytes and nothing else', () => {
  const bytes = buildContent({ kind: 'empty', bytes: 0 })

  assert.equal(bytes.length, 0)
  assert.equal(bytes instanceof Uint8Array, true)
})

test('a padding fixture is one byte value repeated, with no header and no tail', () => {
  for (const value of [0, 0x41, 0xff]) {
    const bytes = buildContent({ kind: 'padding', byte: value, bytes: 512 })
    assert.equal(bytes.length, 512)
    assert.equal(bytes.every((byte) => byte === value), true, `every byte must be ${value}`)
  }
})

test('a signature fixture is the published header and then zeros, at every declared offset', () => {
  for (const name of SIGNATURE_NAMES) {
    const length = signatureLength(name) + 32
    const bytes = buildContent({ kind: 'signature', signature: name, bytes: length })
    assert.equal(bytes.length, length)

    const covered = new Set()
    for (const segment of SIGNATURES[name]) {
      for (let index = 0; index < segment.bytes.length; index += 1) {
        assert.equal(bytes[segment.offset + index], segment.bytes[index], `${name} byte ${segment.offset + index}`)
        covered.add(segment.offset + index)
      }
    }
    for (let index = 0; index < bytes.length; index += 1) {
      if (!covered.has(index)) assert.equal(bytes[index], 0, `${name} padding byte ${index} must be zero`)
    }
  }
})

test('no signature in the table is long enough to be a file, and none of them is an archive', () => {
  for (const name of SIGNATURE_NAMES) {
    assert.equal(signatureLength(name) <= 12, true, `${name} is a header, not a file`)
  }
  assert.deepEqual([...SIGNATURE_NAMES], ['gif89a', 'jpeg', 'pdf', 'png', 'webp'])
})

test('a fixture written to disk is byte-identical to the inert shape that was declared', async () => {
  await withRoot({
    ...fixture(policy({ allowEmpty: true }), [
      fixtureCase({ id: 'a-empty', filename: 'empty.txt', declaredMimeType: 'text/plain', content: { kind: 'empty' }, expect: { decision: 'accept' } }),
      fixtureCase({ id: 'b-padding', filename: 'notes.txt', declaredMimeType: 'text/plain', content: { kind: 'padding', byte: 65, bytes: 100 }, expect: { decision: 'accept' } }),
      fixtureCase({ id: 'c-signature', content: { kind: 'signature', signature: 'png', bytes: 64 }, expect: { decision: 'accept' } }),
    ]),
  }, async (root) => {
    await withRoot({}, async (outside) => {
      const result = await cliRun(['--root', root, '--suite', 'suite.json', '--out', outside, '--json'])
      assert.equal(result.code, 0, result.stderr)

      const written = (await readdir(outside)).sort()
      assert.deepEqual(written, ['a-empty.fixture', 'b-padding.fixture', 'c-signature.fixture'])

      assert.deepEqual(await readFile(join(outside, 'a-empty.fixture')), Buffer.alloc(0))
      assert.deepEqual(await readFile(join(outside, 'b-padding.fixture')), Buffer.alloc(100, 0x41))
      assert.deepEqual(await readFile(join(outside, 'c-signature.fixture')), Buffer.from(withSignature('png', 64)))
    })
  })
})

test('a written fixture is named for its case and carries an inert extension, never the declared one', async () => {
  await withRoot(fixture(policy(), [
    fixtureCase({ id: 'looks-like-an-installer', filename: 'setup.exe', declaredMimeType: 'image/png', content: { kind: 'padding', byte: 0, bytes: 8 }, expect: { decision: 'reject', reason: 'extension-unknown' } }),
  ]), async (root) => {
    await withRoot({}, async (outside) => {
      const result = await cliRun(['--root', root, '--out', outside, '--json'])
      assert.equal(result.code, 0, result.stderr)

      const written = await readdir(outside)
      assert.deepEqual(written, ['looks-like-an-installer.fixture'])
      assert.equal(written[0].endsWith('.exe'), false, 'the declared filename never names a file on disk')
    })
  })
})

test('the suite document is not a place to put bytes: a declared payload does not compile', async () => {
  const document = suiteOf([{
    id: 'smuggle',
    filename: 'photo.png',
    declaredMimeType: 'image/png',
    content: { kind: 'padding', byte: 0, bytes: 8, base64: 'TVqQAAMAAAAEAAAA' },
    expect: { decision: 'accept' },
  }])

  await withRoot({ 'policy.json': policy(), 'suite.json': document }, async (root) => {
    const result = await cliRun(['--root', root, '--json'])
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.bytesGenerated, 0)
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['no-cases-evaluated', 'case-invalid'])
    assert.equal(result.stdout.includes('TVqQAAMAAAAEAAAA'), false, 'a refused value is never reproduced')
  })
})
