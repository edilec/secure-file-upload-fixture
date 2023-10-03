import assert from 'node:assert/strict'
import test from 'node:test'

import { readFile, readdir, symlink, writeFile } from 'node:fs/promises'
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
  const cli = await withRoot(files, (root) => cliRun(['--root', root]))
  const cliReportValue = JSON.parse(cli.stdout)

  for (const report of [api, cliReportValue]) {
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.accepted, 1)
    const finding = findingsFor(report, 'expected-reject-but-accepted')[0]
    assert.equal(finding.severity, 'error')
    assert.equal(finding.location.pointer, '/cases/0')
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
    assert.equal(finding.location.pointer, '/cases/0')
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
    assert.equal(finding.location.pointer, '/cases/0')
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
    assert.equal(findingsFor(report, 'generated-name-unsafe')[0].location.pointer, '/cases/0')
    assert.equal(findingsFor(report, 'generated-name-mismatch')[0].location.pointer, '/cases/0')
    assert.equal(JSON.stringify(report).includes(marker), false)
  }
  assert.equal(cli.code, 1)
  assert.equal(cli.stdout.includes(marker), false)
  assert.equal(cli.stderr.includes(marker), false)
})

test('a valid private-shaped case id is located by source ordinal without appearing in report streams', async () => {
  const marker = 'SYNTHETIC_SECRET_CANARY'
  const files = fixture(policy(), [fixtureCase({
    id: marker,
    expect: { decision: 'reject', reason: 'size-empty' },
  })])
  const api = await apiReport(files)
  const cli = await withRoot(files, (root) => cliRun(['--root', root]))
  const cliReportValue = JSON.parse(cli.stdout)

  for (const report of [api, cliReportValue]) {
    assert.equal(report.status, 'fail')
    const finding = findingsFor(report, 'expected-reject-but-accepted')[0]
    assert.equal(finding.location.pointer, '/cases/0')
    assert.equal(finding.severity, 'error')
    assert.equal(JSON.stringify(report).includes(marker), false)
  }
  assert.equal(cli.code, 1)
  assert.equal(cli.stdout.includes(marker), false)
  assert.equal(cli.stderr.includes(marker), false)
})

test('a private-shaped case id is not echoed by compilation or output-not-written diagnostics', async () => {
  const marker = 'SYNTHETIC_SECRET_CANARY'
  const malformed = await apiReport(fixture(policy(), [fixtureCase({ id: marker, filename: 7 })]))
  assert.equal(malformed.status, 'incomplete')
  assert.equal(findingsFor(malformed, 'case-invalid')[0].location.pointer, '/cases/0/filename')
  assert.equal(JSON.stringify(malformed).includes(marker), false)

  await withRoot(fixture(policy(), [fixtureCase({ id: marker })]), async (root) => {
    await withRoot({}, async (out) => {
      await writeFile(join(out, `${marker}.fixture`), 'pre-existing synthetic fixture')
      const run = await cliRun(['--root', root, '--out', out])
      const report = JSON.parse(run.stdout)

      assert.equal(run.code, 2)
      assert.equal(report.status, 'incomplete')
      assert.equal(findingsFor(report, 'output-not-written')[0].location.pointer, '/cases/0')
      assert.equal((run.stdout + run.stderr).includes(marker), false)
    })
    await withRoot({}, async (out) => {
      await symlink('missing-synthetic-target', join(out, `${marker}.fixture`))
      const run = await cliRun(['--root', root, '--out', out])
      const report = JSON.parse(run.stdout)

      assert.equal(run.code, 2)
      assert.equal(report.status, 'incomplete')
      assert.equal(findingsFor(report, 'output-not-written')[0].location.pointer, '/cases/0')
      assert.match(findingsFor(report, 'output-not-written')[0].message, /symbolic link/)
      assert.equal((run.stdout + run.stderr).includes(marker), false)
    })
  })
})

test('valid private-shaped ids stay out of duplicate, content, expectation and generated-name findings', async () => {
  const marker = 'SYNTHETIC_SECRET_CANARY'
  const scenarios = [
    ['case-duplicate', fixture(policy(), [fixtureCase({ id: marker }), fixtureCase({ id: marker })]), '/cases/1/id'],
    ['case-invalid', fixture(policy(), [fixtureCase({ id: marker, content: 'not-an-object' })]), '/cases/0/content'],
    ['case-invalid', fixture(policy(), [fixtureCase({ id: marker, expect: { decision: 'reject', reason: 'not-a-reason' } })]), '/cases/0/expect/reason'],
    ['reason-mismatch', fixture(policy(), [fixtureCase({ id: marker, filename: 'setup.exe', expect: { decision: 'reject', reason: 'size-empty' } })]), '/cases/0'],
    ['generated-name-unsafe', fixture(policy({ filenamePolicy: { preserveOriginalName: true } }), [fixtureCase({ id: marker })]), '/cases/0'],
    ['generated-name-mismatch', fixture(policy(), [fixtureCase({ id: marker, expect: { decision: 'accept', generatedName: 'upload-wrong.png' } })]), '/cases/0'],
  ]

  for (const [ruleId, files, pointer] of scenarios) {
    const report = await apiReport(files)
    assert.equal(findingsFor(report, ruleId)[0].location.pointer, pointer, ruleId)
    assert.equal(JSON.stringify(report).includes(marker), false, ruleId)
  }
})

test('custom private-shaped input basenames are read but represented by fixed source roles', async () => {
  const marker = 'SYNTHETIC_SECRET_CANARY'
  const policyName = `${marker}-policy.json`
  const suiteName = `${marker}-suite.json`
  const files = {
    [policyName]: policy({ types: [] }),
    [suiteName]: suiteOf([fixtureCase()]),
  }
  const api = await apiReport(files, { policy: policyName, suite: suiteName })

  await withRoot(files, async (root) => {
    const run = await cliRun(['--root', root, '--policy', policyName, '--suite', suiteName])
    const report = JSON.parse(run.stdout)

    assert.equal(run.code, 1)
    assert.equal(report.status, 'fail')
    assert.deepEqual([api, report].map((value) => findingsFor(value, 'policy-no-types')[0].location), [
      { file: '@policy', pointer: '/types' },
      { file: '@policy', pointer: '/types' },
    ])
    assert.equal(findingsFor(report, 'expected-accept-but-rejected')[0].location.file, '@suite')
    assert.equal(findingsFor(report, 'expected-accept-but-rejected')[0].location.pointer, '/cases/0')
    assert.equal((run.stdout + run.stderr + JSON.stringify(api)).includes(marker), false)
    assert.match(run.stderr, /policy @policy:/)
    assert.match(run.stderr, /suite @suite:/)
  })
})

test('a missing private-shaped input basename is not echoed by its unreadable finding', async () => {
  const marker = 'SYNTHETIC_SECRET_CANARY'
  const missingSuite = `${marker}-missing.json`

  await withRoot({ 'policy.json': policy() }, async (root) => {
    const run = await cliRun(['--root', root, '--suite', missingSuite])
    const report = JSON.parse(run.stdout)

    assert.equal(run.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(findingsFor(report, 'input-unreadable')[0].location.file, '@suite')
    assert.equal((run.stdout + run.stderr).includes(marker), false)
  })
})

test('unknown policy key names are refused at their source position without being copied', async () => {
  const marker = 'SYNTHETIC_SECRET_CANARY'
  const scenarios = [
    [fixture({ ...policy(), [marker]: true }, [fixtureCase()]), '', 0],
    [fixture(policy({ types: [pngType({ [marker]: true }), txtType()] }), [fixtureCase()]), '/types/0', 1],
    [fixture(policy({ filenamePolicy: { [marker]: true } }), [fixtureCase()]), '/filenamePolicy', 0],
  ]

  for (const [files, pointer, checked] of scenarios) {
    const api = await apiReport(files)
    const cli = await cliReport(files)
    for (const report of [api, cli.report]) {
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.checked, checked)
      const finding = findingsFor(report, 'policy-invalid')[0]
      assert.equal(finding.location.file, '@policy')
      assert.equal(finding.location.pointer, pointer)
      assert.match(finding.message, /1 unknown key/)
      assert.equal(JSON.stringify(report).includes(marker), false)
    }
    assert.equal(cli.code, 2)
    assert.equal((cli.stdout + cli.stderr).includes(marker), false)
  }
})

test('unknown suite key names are refused at their source position without being copied', async () => {
  const marker = 'SYNTHETIC_SECRET_CANARY'
  const scenarios = [
    [{ 'policy.json': policy(), 'suite.json': { ...suiteOf([fixtureCase()]), [marker]: true } }, 'suite-invalid', ''],
    [fixture(policy(), [{ ...fixtureCase(), [marker]: true }]), 'case-invalid', '/cases/0'],
    [fixture(policy(), [fixtureCase({ content: { kind: 'padding', byte: 0, bytes: 4, [marker]: true } })]), 'case-invalid', '/cases/0/content'],
    [fixture(policy(), [fixtureCase({ expect: { decision: 'accept', [marker]: true } })]), 'case-invalid', '/cases/0/expect'],
  ]

  for (const [files, ruleId, pointer] of scenarios) {
    const api = await apiReport(files)
    const cli = await cliReport(files)
    for (const report of [api, cli.report]) {
      assert.equal(report.status, 'incomplete')
      assert.equal(report.summary.checked, 0)
      const finding = findingsFor(report, ruleId)[0]
      assert.equal(finding.location.file, '@suite')
      assert.equal(finding.location.pointer, pointer)
      assert.match(finding.message, /1 unknown key/)
      assert.equal(JSON.stringify(report).includes(marker), false)
    }
    assert.equal(cli.code, 2)
    assert.equal((cli.stdout + cli.stderr).includes(marker), false)
  }
})

/**
 * The echo boundary, enumerated rather than recalled.
 *
 * Candidate values, stored names, case ids and unknown document-key names are
 * private in the report. A valid case id still names a materialised output
 * file under --out.
 *
 * The risk is drift: one more field quoted into one more message and a
 * boundary everybody still believes has quietly moved. Every plausible
 * carrier gets the canary in turn; none belongs in report streams. The one
 * output-file carrier is measured separately so privacy does not change what
 * --out writes.
 */

const ECHOED_REPORT_KEYS = Object.freeze([])
const ECHOED_OUTPUT_FILENAMES = Object.freeze(['the id of an evaluated case'])

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

test('planted private strings stay out of reports; case ids still name output files', async () => {
  const canary = CANARIES['AWS documented example key']
  const reported = []
  const writtenNames = []

  for (const [where, files] of Object.entries(echoPlantings(canary))) {
    await withRoot(files, async (root) => {
      await withRoot({}, async (out) => {
        const result = await cliRun(['--root', root, '--out', out])
        let written = ''
        for (const name of await readdir(out)) {
          written += `${name}\n${await readFile(join(out, name), 'latin1')}`
        }
        if ([result.stdout, result.stderr].some((text) => text.includes(canary))) reported.push(where)
        if (written.includes(canary)) writtenNames.push(where)
      })
    })
  }

  assert.deepEqual(reported.sort(byCodeUnit), [...ECHOED_REPORT_KEYS], 'the report string carriers changed')
  assert.deepEqual(writtenNames.sort(byCodeUnit), [...ECHOED_OUTPUT_FILENAMES], 'the output filename carrier changed')
})
