import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, byCodeUnit, createFinding } from '../src/index.mjs'
import { projectDirectory } from './support.mjs'

/**
 * The frozen table against the documented catalog, in both directions.
 *
 * This is a source of truth and not the guarantee: a table, a catalog and a
 * hand-written expected map are three declarations, and an edit of all three
 * passes everything asserted here. `test/severity-exit.test.mjs` pins the
 * consequence instead. What this file is good for is the drift nobody meant:
 * a rule added to the code and never documented, a rule documented and never
 * raised, a severity word that is not one of the three.
 */

const DOCUMENTATION = join(projectDirectory, 'docs/upload-policy-rules.md')

async function documentedRules() {
  const text = await readFile(DOCUMENTATION, 'utf8')
  const section = text.split('## The rule catalog')[1]
  assert.equal(typeof section, 'string', 'the rule catalog section must exist')

  const rows = new Map()
  for (const line of section.split('\n## ')[0].split('\n')) {
    const match = /^\| `([a-z0-9-]+)` \| `(error|warning|info)` \| (yes|no) \|/.exec(line)
    if (match !== null) rows.set(match[1], { severity: match[2], incomplete: match[3] === 'yes' })
  }
  return rows
}

test('every rule in the table is documented with the same severity', async () => {
  const documented = await documentedRules()

  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(documented.has(ruleId), true, `${ruleId} is not in docs/upload-policy-rules.md`)
    assert.equal(documented.get(ruleId).severity, severity, `${ruleId} is documented as a different severity`)
  }
})

test('every documented rule exists in the table', async () => {
  const documented = await documentedRules()

  for (const ruleId of documented.keys()) {
    assert.equal(Object.hasOwn(RULE_SEVERITY, ruleId), true, `${ruleId} is documented but is not a rule`)
  }
  assert.equal(documented.size, Object.keys(RULE_SEVERITY).length)
})

test('the documented catalog is in code-unit order, so a reader can find a rule', async () => {
  const documented = [...(await documentedRules()).keys()]

  assert.deepEqual(documented, [...documented].sort(byCodeUnit))
  assert.deepEqual(Object.keys(RULE_SEVERITY), [...Object.keys(RULE_SEVERITY)].sort(byCodeUnit))
})

test('every severity is one of the three the report contract allows', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(['error', 'warning', 'info'].includes(severity), true, ruleId)
  }
})

test('every rule in the table is raised somewhere in the source', async () => {
  let source = ''
  for (const directory of ['src', 'bin']) {
    for (const name of await readdir(join(projectDirectory, directory))) {
      source += await readFile(join(projectDirectory, directory, name), 'utf8')
    }
  }

  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    const raised = source.includes(`'${ruleId}'`) || source.includes(`ruleId: '${ruleId}'`)
    assert.equal(raised, true, `${ruleId} is in the table but nothing raises it`)
  }
})

test('a finding with a rule id that is not in the table throws rather than defaulting', () => {
  assert.throws(
    () => createFinding({ ruleId: 'invented-rule', file: 'suite.json', pointer: '', message: 'x' }),
    /not in RULE_SEVERITY/,
  )
})

test('the table is frozen, so a rule cannot be demoted at runtime', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.throws(() => {
    'use strict'
    RULE_SEVERITY['policy-fail-open'] = 'info'
  }, TypeError)
})
