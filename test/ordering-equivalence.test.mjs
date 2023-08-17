import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, RULE_SEVERITY, SIGNATURE_NAMES, byCodeUnit } from '../src/index.mjs'

/**
 * The ordering sites that cannot be pinned, proved equivalent instead of left
 * as gaps.
 *
 * `test/ordering.test.mjs` pins the sites whose values are untrusted -- case
 * ids, document keys, file names, pointers -- by emitting a sequence a
 * collator would emit differently. Five sites remain, and all five order
 * values drawn from alphabets on which code-unit order and English collation
 * agree on every pair: this package's rule ids, its limit names, and the names
 * of the published signatures (which are ordered at three separate sites).
 *
 * Substituting a collator at those five is an *equivalent* mutation: the
 * output cannot change, so no test can catch it, and saying so with an
 * enumeration is more honest than either claiming coverage or staying quiet.
 * Each case enumerates every ordered pair of the real values and asserts the
 * two comparisons agree in sign, and each also pins the alphabet the proof
 * rests on -- so a rule id with an underscore in it, where the two comparators
 * famously disagree, fails this test rather than quietly widening the claim.
 */

const collator = new Intl.Collator('en')

function everyOrderedPairAgrees(values, label) {
  let compared = 0
  for (const left of values) {
    for (const right of values) {
      assert.equal(
        Math.sign(byCodeUnit(left, right)),
        Math.sign(collator.compare(left, right)),
        `${label}: "${left}" vs "${right}" would move under collation`,
      )
      compared += 1
    }
  }
  return compared
}

test('every ordered pair of real rule ids collates exactly as it compares by code unit', () => {
  const ruleIds = Object.keys(RULE_SEVERITY)

  assert.equal(ruleIds.length, 25, 'the catalog is the real one, not a sample')
  for (const ruleId of ruleIds) assert.match(ruleId, /^[a-z][a-z0-9-]*[a-z0-9]$/, 'the alphabet this proof rests on')
  assert.equal(everyOrderedPairAgrees(ruleIds, 'rule id'), ruleIds.length ** 2)
})

test('every ordered pair of real limit names collates exactly as it compares by code unit', () => {
  const names = Object.keys(DEFAULT_LIMITS)

  assert.equal(names.length, 5)
  for (const name of names) assert.match(name, /^[a-zA-Z]+$/, 'the alphabet this proof rests on')
  assert.equal(everyOrderedPairAgrees(names, 'limit name'), names.length ** 2)
})

test('every ordered pair of published signature names collates exactly as it compares by code unit', () => {
  assert.equal(SIGNATURE_NAMES.length, 5)
  for (const name of SIGNATURE_NAMES) assert.match(name, /^[a-z0-9]+$/, 'the alphabet this proof rests on')
  assert.equal(everyOrderedPairAgrees(SIGNATURE_NAMES, 'signature name'), SIGNATURE_NAMES.length ** 2)
})

test('the comparator itself is a total order with no ties beyond equality', () => {
  const values = ['', 'a', 'A', 'a-b', 'a_b', 'ab', 'Zebra', 'apple', 'assets', 'README']

  for (const left of values) {
    assert.equal(byCodeUnit(left, left), 0)
    for (const right of values) {
      if (left === right) continue
      assert.equal(byCodeUnit(left, right), -byCodeUnit(right, left), `${left} vs ${right} must be antisymmetric`)
      assert.notEqual(byCodeUnit(left, right), 0)
    }
  }
  // The pair the catalog's own report contract names: an underscore is
  // punctuation to a collator and 0x5F to a code unit.
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.equal(collator.compare('a-b', 'a_b') > 0, true, 'the disagreement that makes code-unit ordering necessary')
})
