import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, RULE_SEVERITY, SIGNATURE_NAMES, byCodeUnit } from '../src/index.mjs'

/**
 * The ordering sites that cannot be pinned, proved equivalent instead of left
 * as gaps.
 *
 * `test/ordering.test.mjs` pins the case-id walk by emitting a sequence a
 * collator would emit differently. Unknown document-key names are refused but
 * no longer rendered. Report source roles and pointers are fixed labels or
 * source ordinals, rather than untrusted names. Other sites order values drawn from
 * alphabets on which code-unit order and English collation agree on every
 * pair: rule ids, limit names and published signature names.
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

/**
 * Every ordered pair on which the two comparisons disagree, and nothing else.
 *
 * The earlier shape of this helper asserted inside the loop and returned the
 * number of pairs it had walked, which it incremented unconditionally -- so
 * `assert.equal(everyOrderedPairAgrees(values), values.length ** 2)` compared a
 * counter against the only value it could hold. It could not fail, and it sat
 * on the line that reads like the one carrying the proof.
 *
 * Returning the disagreements puts the claim in the caller, where a
 * disagreement is a value the assertion can show rather than a throw from
 * inside a helper.
 */
function orderedPairsThatDisagree(values) {
  const disagreements = []
  for (const left of values) {
    for (const right of values) {
      if (Math.sign(byCodeUnit(left, right)) !== Math.sign(collator.compare(left, right))) {
        disagreements.push(`"${left}" vs "${right}"`)
      }
    }
  }
  return disagreements
}

/**
 * The size of the enumeration. A proof over 676 pairs that quietly became a
 * proof over 625 because a rule was dropped is a weaker proof than the one
 * claimed, and this is the line that says so.
 */
function assertEnumerated(values, pairs, label) {
  assert.equal(new Set(values).size, values.length, `${label}: a duplicate would shrink the enumeration`)
  assert.equal(values.length ** 2, pairs, `${label}: the enumeration is no longer the ${pairs} pairs claimed`)
}

test('every ordered pair of real rule ids collates exactly as it compares by code unit', () => {
  const ruleIds = Object.keys(RULE_SEVERITY)

  assert.equal(ruleIds.length, 26, 'the catalog is the real one, not a sample')
  for (const ruleId of ruleIds) assert.match(ruleId, /^[a-z][a-z0-9-]*[a-z0-9]$/, 'the alphabet this proof rests on')
  assertEnumerated(ruleIds, 676, 'rule id')
  assert.deepEqual(orderedPairsThatDisagree(ruleIds), [], 'these rule ids would move under collation')
})

test('every ordered pair of real limit names collates exactly as it compares by code unit', () => {
  const names = Object.keys(DEFAULT_LIMITS)

  assert.equal(names.length, 5)
  for (const name of names) assert.match(name, /^[a-zA-Z]+$/, 'the alphabet this proof rests on')
  assertEnumerated(names, 25, 'limit name')
  assert.deepEqual(orderedPairsThatDisagree(names), [], 'these limit names would move under collation')
})

test('every ordered pair of published signature names collates exactly as it compares by code unit', () => {
  assert.equal(SIGNATURE_NAMES.length, 5)
  for (const name of SIGNATURE_NAMES) assert.match(name, /^[a-z0-9]+$/, 'the alphabet this proof rests on')
  assertEnumerated(SIGNATURE_NAMES, 25, 'signature name')
  assert.deepEqual(orderedPairsThatDisagree(SIGNATURE_NAMES), [], 'these signature names would move under collation')
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
