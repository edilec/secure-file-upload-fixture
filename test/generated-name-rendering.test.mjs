import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { apiReport, cliReport, findingsFor } from './support.mjs'

const cleanPolicy = JSON.parse(readFileSync(new URL('../examples/clean/policy.json', import.meta.url)))
const cleanSuite = JSON.parse(readFileSync(new URL('../examples/clean/suite.json', import.meta.url)))
const filesWithExpected = (value) => {
  const suite = structuredClone(cleanSuite)
  suite.cases[0].expect.generatedName = value
  return { 'policy.json': cleanPolicy, 'suite.json': suite }
}
const original = cleanSuite.cases[0].expect.generatedName

test('clean generated-name expectation passes and visible mismatch remains a failure', async () => {
  const clean = await apiReport(filesWithExpected(original))
  assert.equal(clean.status, 'pass')
  const visible = await apiReport(filesWithExpected(`${original}wrong-name.jpg`))
  assert.equal(visible.status, 'fail')
  const mismatch = findingsFor(visible, 'generated-name-mismatch')[0]
  assert.equal(mismatch.message.includes(`${original}wrong-name.jpg`), true)
  assert.equal(mismatch.message.includes(`produced "${original}"`), true)
})

test('a trailing-space generated name is incomplete before a same-looking mismatch can be reported', async () => {
  const exact = await cliReport(filesWithExpected(original))
  assert.equal(exact.code, 0)
  assert.equal(exact.report.status, 'pass')
  assert.equal(findingsFor(exact.report, 'generated-name-mismatch').length, 0)

  const visible = await cliReport(filesWithExpected(`${original}x`))
  assert.equal(visible.code, 1)
  assert.equal(visible.report.status, 'fail')
  assert.equal(findingsFor(visible.report, 'generated-name-mismatch').length, 1)

  const trailing = await cliReport(filesWithExpected(`${original} `))
  assert.equal(trailing.code, 2)
  assert.equal(trailing.report.status, 'incomplete')
  assert.equal(findingsFor(trailing.report, 'generated-name-mismatch').length, 0)
  assert.equal(findingsFor(trailing.report, 'case-invalid')[0].location.pointer,
    '/cases/0/expect/generatedName')
})

test('hidden controls in expected generated name are refused as incomplete before comparison', async () => {
  for (const character of ['\u0001', '\u0085', '\u034f']) {
    const files = filesWithExpected(`${original}${character}`)
    const api = await apiReport(files)
    assert.equal(api.status, 'incomplete')
    assert.equal(findingsFor(api, 'generated-name-mismatch').length, 0)
    assert.equal(findingsFor(api, 'case-invalid')[0].location.pointer,
      '/cases/0/expect/generatedName')
    assert.equal(JSON.stringify(api).includes(character), false)
    const cli = await cliReport(files)
    assert.equal(cli.code, 2)
    assert.equal(cli.report.status, 'incomplete')
    assert.equal(findingsFor(cli.report, 'generated-name-mismatch').length, 0)
    assert.equal(findingsFor(cli.report, 'case-invalid')[0].location.pointer,
      '/cases/0/expect/generatedName')
  }
})

test('generated-name length N is evaluated and N plus one is refused', async () => {
  const exact = await apiReport(filesWithExpected('a'.repeat(120)))
  assert.equal(exact.status, 'fail')
  assert.equal(findingsFor(exact, 'generated-name-mismatch').length, 1)
  const over = await apiReport(filesWithExpected('a'.repeat(121)))
  assert.equal(over.status, 'incomplete')
  assert.equal(findingsFor(over, 'case-invalid')[0].location.pointer,
    '/cases/0/expect/generatedName')
})
