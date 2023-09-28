import assert from 'node:assert/strict'
import test from 'node:test'

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { byCodeUnit } from '../src/index.mjs'
import { apiReport, cliReport, cliRun, findingsFor, fixture, fixtureCase, pngType, policy, suiteOf, txtType, withRoot } from './support.mjs'

/**
 * What a private value must never do: appear in the report.
 *
 * A field this tool reads is arbitrary content from a file it did not write,
 * and the report goes to stdout -- a stream that is piped into CI logs, pasted
 * into issues and attached to builds. Echoing either a refused or accepted
 * private value back hands it a wider audience than it had in the input file.
 *
 * The scan below is deliberately unlike a field-by-field assertion: it walks
 * the whole of stdout and the whole of stderr, and it looks for *every prefix*
 * of each canary from six characters up. A redaction test that checks the one
 * field somebody remembered is a test the next field passes for free, and a
 * test for the whole canary is one a truncation passes for free.
 *
 * None of these canaries is a credential. They are the published placeholders:
 * the key AWS documents, the card number every payment processor reserves for
 * tests, a domain RFC 2606 reserves, and a nonsense marker with no hex and no
 * base64 run in it so that no prefix of it can collide with a digest.
 */

const CANARIES = Object.freeze({
  'AWS documented example key': 'AKIAIOSFODNN7EXAMPLE',
  'the reserved test card': '4111111111111111',
  'an RFC 2606 reserved address': 'billing@example.invalid',
  'a marker with no hex run': 'Zq-Wubble-Xyzzy-Plugh-Frobnitz',
})

/** Every prefix of six characters or more, longest first. */
function prefixes(value) {
  const result = []
  for (let length = value.length; length >= 6; length -= 1) result.push(value.slice(0, length))
  return result
}

function assertUnseen(label, ...streams) {
  for (const [name, canary] of Object.entries(CANARIES)) {
    for (const prefix of prefixes(canary)) {
      for (const stream of streams) {
        assert.equal(
          stream.includes(prefix),
          false,
          `${label}: ${name} reached the output as "${prefix}"`,
        )
      }
    }
  }
}

const value = (index) => Object.values(CANARIES)[index]

test('a value refused by the policy compiler is described, never reproduced', async () => {
  const document = {
    ...policy(),
    [`awsAccessKeyId`]: value(0),
    maxBytes: value(1),
  }

  await withRoot({ 'policy.json': document, 'suite.json': suiteOf([fixtureCase()]) }, async (root) => {
    const result = await cliRun(['--root', root])

    assert.equal(result.code, 2)
    assert.match(result.stdout, /policy-invalid/)
    assertUnseen('policy compiler', result.stdout, result.stderr)
  })
})

test('a value refused by the suite compiler is described, never reproduced', async () => {
  const cases = [
    { ...fixtureCase({ id: 'a' }), secretNote: value(0) },
    fixtureCase({ id: `${value(1)}-${value(3)}-and-more-than-sixty-four-characters-of-id-here` }),
    fixtureCase({ id: 'c', description: [value(2)] }),
    fixtureCase({ id: 'd', expect: { decision: value(3) } }),
    fixtureCase({ id: 'e', content: { kind: 'padding', byte: 0, bytes: 4, note: value(0) } }),
    fixtureCase({ id: 'f', content: { kind: value(3), bytes: 4 } }),
    fixtureCase({ id: 'g', filename: { name: value(2) } }),
    fixtureCase({ id: 'h', declaredMimeType: 7 }),
  ]

  await withRoot({ 'policy.json': policy(), 'suite.json': suiteOf(cases) }, async (root) => {
    const result = await cliRun(['--root', root])
    const report = JSON.parse(result.stdout)

    assert.equal(result.code, 2)
    assert.equal(report.summary.errors >= 8, true, 'every one of these is refused')
    assertUnseen('suite compiler', result.stdout, result.stderr)
  })
})

test('an input that could not be parsed is never quoted back', async () => {
  const text = `{ "schemaVersion": "1", "cases": [ ${value(0)} ${value(3)} ] `

  await withRoot({ 'policy.json': policy(), 'suite.json': text }, async (root) => {
    const result = await cliRun(['--root', root])

    assert.equal(result.code, 2)
    assert.match(result.stdout, /input-not-json/)
    // The parser's own message quotes the text around the error, so it is not
    // passed through. This scan is what found that, in this exact place.
    assert.equal(result.stdout.includes('Unexpected token'), false)
    assertUnseen('the JSON parser', result.stdout, result.stderr)
  })
})

test('a limit or option nobody defined is refused without its value', async () => {
  await withRoot(fixture(policy(), [fixtureCase()]), async (root) => {
    const result = await cliRun(['--root', root, '--max-cases', '1', '--secret', value(0)])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assertUnseen('the argument parser', result.stdout, result.stderr.replace('--secret', ''))
  })
})

test('an accepted candidate filename remains private while its mismatch finding remains actionable', async () => {
  const marker = 'SYNTHETIC_SECRET_CANARY'
  const files = fixture(policy({ allowMultipleExtensions: true }), [fixtureCase({
    filename: `token=${marker}.pdf.png`,
    expect: { decision: 'reject', reason: 'extension-multiple' },
  })])
  const api = await apiReport(files)
  const cli = await cliReport(files)

  for (const report of [api, cli.report]) {
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.accepted, 1)
    const finding = findingsFor(report, 'expected-reject-but-accepted')[0]
    assert.equal(finding.severity, 'error')
    assert.equal(finding.location.pointer, '/cases/accept-png')
    assert.match(finding.evidence, /redacted/)
    assert.equal(JSON.stringify(report).includes(marker), false)
  }
  assert.equal(cli.code, 1)
  assert.equal(cli.stdout.includes(marker), false)
  assert.equal(cli.stderr.includes(marker), false)
})

test('an accepted declared media type stays private in both report entry points', async () => {
  const marker = 'synthetic-secret-canary'
  const type = `application/x-${marker}`
  const files = fixture(policy({ types: [pngType({ mimeTypes: [type] }), txtType()] }), [fixtureCase({
    declaredMimeType: type,
    expect: { decision: 'reject', reason: 'size-empty' },
  })])
  const api = await apiReport(files)
  const cli = await cliReport(files)

  for (const report of [api, cli.report]) {
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.accepted, 1)
    const finding = findingsFor(report, 'expected-reject-but-accepted')[0]
    assert.equal(finding.location.pointer, '/cases/accept-png')
    assert.match(finding.evidence, /redacted/)
    assert.equal(JSON.stringify(report).includes(marker), false)
  }
  assert.equal(cli.code, 1)
  assert.equal(cli.stdout.includes(marker), false)
  assert.equal(cli.stderr.includes(marker), false)
})

test('an accepted filename extension stays private in the unverifiable-signature finding', async () => {
  const marker = 'pvt12345'
  const files = fixture(policy({ types: [
    { extension: marker, mimeTypes: ['application/x-private-fixture'], signature: null },
  ] }), [fixtureCase({
    filename: `document.${marker}`,
    declaredMimeType: 'application/x-private-fixture',
  })])
  const api = await apiReport(files)
  const cli = await cliReport(files)

  for (const report of [api, cli.report]) {
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.accepted, 1)
    const finding = findingsFor(report, 'signature-unverifiable')[0]
    assert.equal(finding.location.pointer, '/cases')
    assert.equal(finding.severity, 'info')
    assert.equal(JSON.stringify(report).includes(marker), false)
  }
  assert.equal(cli.code, 0)
  assert.equal(cli.stdout.includes(marker), false)
  assert.equal(cli.stderr.includes(marker), false)
})

test('an unknown extension remains private even when the policy reports why it rejected the case', async () => {
  const marker = 'synthetic-secret-canary'
  const files = fixture(policy(), [fixtureCase({ filename: `photo.${marker}`, expect: { decision: 'accept' } })])
  const api = await apiReport(files)
  const cli = await cliReport(files)

  for (const report of [api, cli.report]) {
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.rejected, 1)
    const finding = findingsFor(report, 'expected-accept-but-rejected')[0]
    assert.equal(finding.location.pointer, '/cases/accept-png')
    assert.match(finding.message, /extension-unknown/)
    assert.equal(JSON.stringify(report).includes(marker), false)
  }
  assert.equal(cli.code, 1)
  assert.equal(cli.stdout.includes(marker), false)
  assert.equal(cli.stderr.includes(marker), false)
})

test('a preserved original stem is not published through generated-name findings', async () => {
  const marker = 'synthetic-secret-canary'
  const files = fixture(policy({ filenamePolicy: { preserveOriginalName: true } }), [fixtureCase({
    filename: `${marker}.png`,
    expect: { decision: 'accept', generatedName: `upload-${marker}.png` },
  })])
  const api = await apiReport(files)
  const cli = await cliReport(files)

  for (const report of [api, cli.report]) {
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.accepted, 1)
    assert.equal(findingsFor(report, 'generated-name-unsafe')[0].location.pointer, '/cases/accept-png')
    assert.equal(findingsFor(report, 'generated-name-mismatch')[0].location.pointer, '/cases/accept-png')
    assert.equal(JSON.stringify(report).includes(marker), false)
  }
  assert.equal(cli.code, 1)
  assert.equal(cli.stdout.includes(marker), false)
  assert.equal(cli.stderr.includes(marker), false)
})

/**
 * The echo boundary, enumerated rather than recalled.
 *
 * Accepted filenames, declared media types and stored names are private in
 * the report. A valid case id and the NAME of any key the tool does not know
 * still reach output as identifiers.
 *
 * Each remaining carrier is there for a reason. A finding that cannot say
 * which case or which key is a finding nobody can act on.
 * The risk is drift: one more field quoted into one more message and a
 * boundary everybody still believes has quietly moved. So it is measured --
 * every plausible carrier of a string gets the canary in turn, and the set
 * that comes back must be exactly the declared set. A new echo fails this
 * test; so does an echo that disappears, because a stale list is the thing
 * being guarded against.
 */

const ECHOED_ON_PURPOSE = Object.freeze([
  'an unknown key name in a case',
  'an unknown key name in a policy type',
  'an unknown key name in content',
  'an unknown key name in expect',
  'an unknown key name in filenamePolicy',
  'an unknown key name in the policy',
  'an unknown key name in the suite',
  'the id of an evaluated case',
])

const MISMATCH = Object.freeze({ decision: 'reject', reason: 'size-empty' })

function echoPlantings(canary) {
  const plant = (policyDocument, cases) => fixture(policyDocument, cases)
  return {
    'an unknown key name in the policy': plant({ ...policy(), [canary]: 1 }, [fixtureCase()]),
    'an unknown key value in the policy': plant({ ...policy(), spare: canary }, [fixtureCase()]),
    'an unknown key name in a policy type': plant(policy({ types: [pngType({ [canary]: 1 }), txtType()] }), [fixtureCase()]),
    'an unknown key name in filenamePolicy': plant(policy({ filenamePolicy: { [canary]: 1 } }), [fixtureCase()]),
    'a refused filenamePolicy prefix': plant(policy({ filenamePolicy: { prefix: canary } }), [fixtureCase()]),
    'a refused type extension': plant(policy({ types: [pngType({ extension: canary }), txtType()] }), [fixtureCase()]),
    'a refused type media type': plant(policy({ types: [pngType({ mimeTypes: [canary] }), txtType()] }), [fixtureCase()]),
    'an unknown key name in the suite': { 'policy.json': policy(), 'suite.json': { ...suiteOf([fixtureCase()]), [canary]: 1 } },
    'an unknown key name in a case': plant(policy(), [{ ...fixtureCase(), [canary]: 1 }]),
    'an unknown key name in content': plant(policy(), [fixtureCase({ content: { kind: 'padding', byte: 0, bytes: 4, [canary]: 1 } })]),
    'an unknown key name in expect': plant(policy(), [fixtureCase({ expect: { decision: 'accept', [canary]: 1 } })]),
    'the id of an evaluated case': plant(policy(), [fixtureCase({ id: canary, expect: MISMATCH })]),
    'a refused case id': plant(policy(), [fixtureCase({ id: `${canary} not a valid id!` })]),
    'the description of an evaluated case': plant(policy(), [fixtureCase({ description: canary, expect: MISMATCH })]),
    'the filename of an evaluated case': plant(policy(), [fixtureCase({ filename: `${canary}.png`, expect: MISMATCH })]),
    'the declared media type of an evaluated case': plant(policy(), [fixtureCase({ declaredMimeType: canary })]),
    'the generatedName an expectation declared': plant(policy(), [fixtureCase({ expect: { decision: 'accept', generatedName: canary } })]),
    'a refused expectation reason': plant(policy(), [fixtureCase({ expect: { decision: 'reject', reason: canary } })]),
  }
}

test('exactly eight identifier and key carriers put a string from a file into output', async () => {
  const canary = CANARIES['AWS documented example key']
  const echoed = []

  for (const [where, files] of Object.entries(echoPlantings(canary))) {
    await withRoot(files, async (root) => {
      await withRoot({}, async (out) => {
        const result = await cliRun(['--root', root, '--out', out])
        let written = ''
        for (const name of await readdir(out)) {
          written += `${name}\n${await readFile(join(out, name), 'latin1')}`
        }
        if ([result.stdout, result.stderr, written].some((text) => text.includes(canary))) echoed.push(where)
      })
    })
  }

  assert.deepEqual(echoed.sort(byCodeUnit), [...ECHOED_ON_PURPOSE], 'the set of strings this tool echoes has changed')
})
