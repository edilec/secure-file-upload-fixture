/**
 * secure-file-upload-fixture -- run inert local fixtures against an upload
 * policy and assert every acceptance and every rejection.
 *
 * The tool opens no socket, issues no request and posts nothing anywhere. It
 * reads two JSON documents -- a policy saying what may be accepted, and a
 * suite of fixture cases each declaring the outcome it expects -- builds every
 * fixture in memory from one of three inert shapes, runs the validator in
 * `src/validate.mjs` over it, and reports where the outcome and the
 * expectation disagree.
 *
 * What that is worth, and what it is not, is written out in the README and in
 * `docs/upload-policy-rules.md`. In short: a green run says this policy made
 * these decisions about these names, declared types, sizes and leading bytes.
 * It does not say the policy is sufficient, that the files are safe, or that
 * the service deploying the policy enforces it.
 */

import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import { compilePolicy } from './policy.mjs'
import { buildContent, compileSuite } from './suite.mjs'
import { byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isPlainObject } from './text.mjs'
import { REJECTION_REASONS, decide, storedName } from './validate.mjs'

export const TOOL_ID = 'secure-file-upload-fixture'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_POLICY_NAME = 'policy.json'
export const DEFAULT_SUITE_NAME = 'suite.json'

/**
 * Limits, each enforced and each reported by name when it is hit.
 *
 * Exceeding one is never a silent truncation: it produces a finding naming the
 * limit and marks the run `incomplete`, because the cases nobody built are not
 * evidence that they would have passed.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxCaseBytes: 1048576,
  maxCases: 500,
  maxFileBytes: 5242880,
  maxFindings: 1000,
  maxTotalBytes: 8388608,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxCaseBytes: 67108864,
  maxCases: 5000,
  maxFileBytes: 67108864,
  maxFindings: 20000,
  maxTotalBytes: 268435456,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at thirty construction sites it drifts
 * silently, and demoting `expected-reject-but-accepted` to a warning turns
 * "the validator accepted a file it should have refused" into a green build
 * with every test still green.
 *
 * `test/severity-table.test.mjs` asserts this table against the documented
 * catalog in both directions. That is worth having and it is not the test: a
 * table, a catalog and a hand-written expected map are three declarations
 * agreeing with each other, and a coordinated edit of all three passes every
 * assertion made about them. `test/severity-exit.test.mjs` drives real inputs
 * through the real binary and pins the status, the summary counts and the
 * process exit code, none of which can be edited.
 */
export const RULE_SEVERITY = Object.freeze({
  'case-content-unsupported': 'error',
  'case-duplicate': 'error',
  'case-invalid': 'error',
  'case-too-large': 'error',
  'expected-accept-but-rejected': 'error',
  'expected-reject-but-accepted': 'error',
  'generated-name-mismatch': 'error',
  'generated-name-unsafe': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'no-cases-evaluated': 'error',
  'no-rejection-exercised': 'warning',
  'output-not-written': 'error',
  'path-escapes-root': 'error',
  'policy-fail-open': 'error',
  'policy-invalid': 'error',
  'policy-no-types': 'error',
  'reason-mismatch': 'error',
  'reason-unexercised': 'info',
  'signature-unverifiable': 'info',
  'suite-invalid': 'error',
  'too-many-cases': 'error',
  'too-many-findings': 'error',
  'total-bytes-exceeded': 'error',
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze(['limits', 'out', 'policy', 'root', 'suite'])

/** The extension every materialised fixture is written under: inert, and never the declared one. */
export const FIXTURE_EXTENSION = '.fixture'

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored: a documented limit that a
 * typo silently disables is a decoration, not a bound. The CLI turns this
 * throw into a configuration error with an empty stdout.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(
        `Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`,
      )
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against an
 * unresolved path refuses legitimate files whenever the root is reached
 * through a symbolic link -- a `/var` that is really `/private/var` is enough
 * -- and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * This is emphatically *not* the confinement: a symbolic link planted inside
 * the root passes every check here and contains no `..` at all. `resolveInput`
 * is what catches that, by resolving the real path of both sides.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  if (normalize(name).split(/[\\/]/).includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row, order: this.rows.length })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only the evidence field. A sibling tool
 * in this catalog sanitised evidence carefully and left identifiers raw, so a
 * record id holding a newline forged a line in the human summary.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/upload-policy-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer ?? '', LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/**
 * The documented sort key: location.file, location.pointer, ruleId, then the
 * order the row was emitted in.
 *
 * The last key is an integer on purpose. Tie-breaking on the message or the
 * evidence would compare two pieces of untrusted text, which is a third and a
 * fourth place for a comparator to drift without any test being able to see
 * it; the emission sequence is already deterministic, because the walk that
 * produces it is ordered by code unit.
 */
export function compareRows(left, right) {
  return (
    byCodeUnit(left.file, right.file) ||
    byCodeUnit(left.pointer ?? '', right.pointer ?? '') ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    left.order - right.order
  )
}

function buildReport(sink, state, counts, limits) {
  let rows = [...sink.rows].sort(compareRows)
  let truncated = false

  if (rows.length > limits.maxFindings) {
    const dropped = rows.length - limits.maxFindings + 1
    rows = rows.slice(0, limits.maxFindings - 1)
    rows.push({
      file: counts.suiteName,
      ruleId: 'too-many-findings',
      pointer: '',
      order: Number.MAX_SAFE_INTEGER,
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or narrow the suite.',
    })
    rows.sort(compareRows)
    truncated = true
  }

  const findings = rows.map((row) => createFinding(row))

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      cases: counts.declaredCases,
      unevaluated: counts.declaredCases - state.checked,
      accepted: state.accepted,
      rejected: state.rejected,
      types: counts.compiledTypes,
      typesWithoutSignature: counts.unverifiableTypes.length,
      bytesGenerated: state.bytesGenerated,
      written: state.written,
    },
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically is not confinement: a symbolic link planted inside
 * the root points anywhere and contains no `..` at all.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    // The entry may exist as a link that resolves nowhere. Confine the nearest
    // existing ancestor first, so a symlinked parent cannot decide where a
    // "missing" file would have been read from.
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/** Read one confined input and parse it, or produce the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  try {
    return { value: JSON.parse(decoded.text), dev: info.dev, ino: info.ino }
  } catch {
    /**
     * The parser's own message is not reproduced, and that is not fussiness.
     * V8 builds its syntax errors by quoting the text around the offending
     * character -- `Unexpected token 'A', "...{ "cases": [ AKIA"... is not
     * valid JSON` -- so passing it through would copy a slice of an
     * unparseable file into the report. This tool's prefix scan for canaries
     * caught exactly that, in exactly this line, before release. The file name
     * says which input failed; the file itself says where.
     */
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON, so nothing in it was read. The parser's message quotes the text around the error, so it is not reproduced here.`,
      suggestion: 'Validate the file with a JSON parser locally; the position is in the file, where it started.',
    })
    return null
  }
}

/**
 * Materialise one fixture, refusing every destination that is already
 * something.
 *
 * The exclusive-create flag does most of the work: an existing file is never
 * opened for writing, so no fixture can overwrite anything. When it refuses,
 * the destination is inspected and compared with this run's inputs by device
 * and inode -- because a *hard link* has no target to resolve, so a second
 * name for the suite file resolves to its own real path and compares equal to
 * nothing. A sibling tool destroyed its own input exactly that way. Device and
 * inode see through the second name; a path comparison does not.
 */
async function materialise(sink, file, target, bytes, inputs, relative) {
  try {
    await writeFile(target, bytes, { flag: 'wx' })
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') {
      sink.add({
        file,
        ruleId: 'output-not-written',
        message: `Fixture "${relative}" could not be written: ${error.code ?? 'unknown error'}.`,
        suggestion: 'Check that --out names a writable directory.',
      })
      return false
    }
    let existing = null
    try {
      existing = await stat(target)
    } catch {
      existing = null
    }
    const collision = existing !== null && inputs.some((input) => input.dev === existing.dev && input.ino === existing.ino)
    sink.add({
      file,
      ruleId: 'output-not-written',
      message: collision
        ? `Fixture "${relative}" would have been written over one of this run's own inputs -- the same device and inode, reached under a second name -- so nothing was written.`
        : `Fixture "${relative}" already exists in the output directory, so nothing was written and nothing was overwritten.`,
      suggestion: 'Empty the output directory, or point --out somewhere new. This tool never overwrites.',
    })
    return false
  }
}

/**
 * Run a fixture suite against a policy.
 *
 * @param {object} options
 * @param {string} options.root Directory holding both inputs.
 * @param {string} [options.policy] Policy file, relative to the root.
 * @param {string} [options.suite] Suite file, relative to the root.
 * @param {string} [options.out] Existing directory to materialise fixtures into.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @returns {Promise<object>} the report.
 */
export async function runFixtureSuite(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  const policyName = validateName(options.policy ?? DEFAULT_POLICY_NAME, '--policy')
  const suiteName = validateName(options.suite ?? DEFAULT_SUITE_NAME, '--suite')

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  // The destination is configuration, not evidence: if it is not an existing
  // directory the run never had a place to put anything, so it stops before
  // reading a single fixture rather than reporting about one.
  let realOut = null
  if (options.out !== undefined && options.out !== null) {
    if (typeof options.out !== 'string' || options.out.length === 0) throw new TypeError('out must be a non-empty string')
    try {
      realOut = await realpath(options.out)
    } catch (error) {
      throw new Error(`--out could not be resolved: ${error.code ?? 'unknown error'}`)
    }
    const outInfo = await stat(realOut)
    if (!outInfo.isDirectory()) throw new Error('--out must be a directory')
  }

  const sink = new FindingSink()
  const state = {
    checked: 0, accepted: 0, rejected: 0, bytesGenerated: 0, written: 0, incomplete: false,
    acceptedUnverifiable: 0, acceptedUnverifiableTypes: new Set(),
  }
  const counts = { declaredCases: 0, compiledTypes: 0, unverifiableTypes: [], suiteName, policyName }

  const documents = {}
  const inputs = []
  for (const [kind, name] of [['policy', policyName], ['suite', suiteName]]) {
    const located = await resolveInput(realRoot, name)
    if (!located.ok) {
      state.incomplete = true
      if (located.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep both inputs inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${located.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
      documents[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located.real, limits)
    if (loaded === null) state.incomplete = true
    else inputs.push({ dev: loaded.dev, ino: loaded.ino })
    documents[kind] = loaded
  }

  let policy = null
  if (documents.policy !== null) {
    policy = compilePolicy(sink, policyName, documents.policy.value)
    if (policy === null) state.incomplete = true
    else {
      counts.compiledTypes = policy.compiledTypes
      counts.unverifiableTypes = policy.unverifiableTypes
      // A policy missing one of its types is not the policy its author wrote.
      if (policy.compiledTypes !== policy.declaredTypes) state.incomplete = true
      if (policy.types.size === 0) {
        sink.add({
          file: policyName,
          ruleId: 'policy-no-types',
          pointer: '/types',
          message: 'The policy declares no usable type, so every candidate is refused for an unknown extension and the suite proves nothing about what may be uploaded.',
          suggestion: 'Declare at least one type. Fail-closed with an empty allow-list is a closed door, not a policy.',
        })
      }
    }
  }

  let suite = null
  if (documents.suite !== null) {
    suite = compileSuite(sink, suiteName, documents.suite.value, limits)
    if (suite === null) state.incomplete = true
    else {
      counts.declaredCases = suite.declared
      if (suite.cases.length !== suite.declared) state.incomplete = true
    }
  }

  if (policy !== null && suite !== null) {
    await evaluate({ sink, state, limits, policy, suite, suiteName, realOut, inputs })
  }

  return buildReport(sink, state, counts, limits)
}

/**
 * Build, decide and compare every case, inside two budgets.
 *
 * Both budgets are re-checked *after* the loop rather than only inside it.
 * A budget that runs out mid-walk and lets the exit fall through to the
 * success branch is how a tool in this catalog came to report a confirmed
 * equivalence it had never established: the cardinal defect is not a missing
 * check, it is a conclusion drawn about the part of the work that never ran.
 */
async function evaluate({ sink, state, limits, policy, suite, suiteName, realOut, inputs }) {
  const built = []
  let capped = false
  let budgetExhausted = false

  for (const testCase of suite.cases) {
    if (built.length >= limits.maxCases) {
      capped = true
      break
    }
    if (state.bytesGenerated + testCase.content.bytes > limits.maxTotalBytes) {
      budgetExhausted = true
      break
    }
    const bytes = buildContent(testCase.content)
    state.bytesGenerated += bytes.length
    built.push({ testCase, bytes })
  }

  // After the loop, not only inside it.
  if (built.length !== suite.cases.length) {
    state.incomplete = true
    if (capped) {
      sink.add({
        file: suiteName,
        ruleId: 'too-many-cases',
        pointer: '/cases',
        message: `The suite declares ${suite.cases.length} usable case(s), above the maxCases limit of ${limits.maxCases}; the walk stopped and ${suite.cases.length - built.length} case(s) were not evaluated.`,
        suggestion: 'Raise --max-cases, or split the suite.',
      })
    }
    if (budgetExhausted) {
      sink.add({
        file: suiteName,
        ruleId: 'total-bytes-exceeded',
        pointer: '/cases',
        message: `Building the suite would have passed the maxTotalBytes limit of ${limits.maxTotalBytes}; the walk stopped after ${state.bytesGenerated} bytes and ${suite.cases.length - built.length} case(s) were not evaluated.`,
        suggestion: 'Raise --max-total-bytes, or make the oversize fixtures smaller than the policy limit they cross.',
      })
    }
  }

  const exercised = new Set()
  let sequence = 0

  for (const { testCase, bytes } of built) {
    const pointer = `/cases/${testCase.id}`
    const outcome = decide(policy, {
      filename: testCase.filename,
      declaredMimeType: testCase.declaredMimeType,
      bytes,
    })
    state.checked += 1
    exercised.add(outcome.reason)
    const shownName = testCase.filename === '' ? '(empty)' : `"${testCase.filename}"`
    const evidence = `${shownName} declared ${testCase.declaredMimeType === '' ? '(no media type)' : testCase.declaredMimeType}, ${bytes.length} byte(s)`

    if (outcome.decision === 'accept') {
      state.accepted += 1
      sequence += 1
      // Accepted on its name, its declared media type and its size, with not
      // one byte of it looked at. Tallied here rather than inferred from the
      // policy later: the policy says which types *could* be unverifiable, and
      // only the decision says which acceptances actually were.
      if (outcome.type.signature === null) {
        state.acceptedUnverifiable += 1
        state.acceptedUnverifiableTypes.add(outcome.type.extension)
      }
    } else {
      state.rejected += 1
    }

    if (outcome.decision !== testCase.expect.decision) {
      sink.add({
        file: suiteName,
        ruleId: outcome.decision === 'accept' ? 'expected-reject-but-accepted' : 'expected-accept-but-rejected',
        pointer,
        message: outcome.decision === 'accept'
          ? `Case "${testCase.id}" expected a rejection for ${testCase.expect.reason} and the policy accepted the candidate.`
          : `Case "${testCase.id}" expected acceptance and the policy refused the candidate: ${outcome.reason} -- ${outcome.detail}.`,
        evidence,
        suggestion: outcome.decision === 'accept'
          ? 'Either the policy is wider than the fixture assumes, or the fixture no longer crosses the rule it was written for.'
          : 'Either the policy is narrower than the fixture assumes, or the fixture needs to satisfy the rule it now trips.',
      })
      continue
    }

    if (outcome.decision === 'reject') {
      if (outcome.reason !== testCase.expect.reason) {
        sink.add({
          file: suiteName,
          ruleId: 'reason-mismatch',
          pointer,
          message: `Case "${testCase.id}" was refused for ${outcome.reason} and expected ${testCase.expect.reason}. Both are rejections, and the fixture is no longer exercising the rule it names.`,
          evidence,
          suggestion: 'Checks run in a fixed order, so a fixture that trips two rules is reported under the first. Narrow the fixture until it trips only the rule it is for.',
        })
      }
      continue
    }

    const stored = storedName(policy, {
      extension: outcome.type.extension,
      bytes,
      sequence,
      filename: testCase.filename,
    })
    if (!stored.safe) {
      sink.add({
        file: suiteName,
        ruleId: 'generated-name-unsafe',
        pointer,
        message: `The stored name for case "${testCase.id}" is unsafe: ${stored.problems.join('; ')}.`,
        evidence: `stored ${stored.name}, derived ${stored.derived}`,
        suggestion: 'A stored name must be derived from the bytes or from a counter, and must end in the policy\'s canonical extension. Set filenamePolicy.preserveOriginalName to false.',
      })
    }
    if (testCase.expect.generatedName !== undefined && testCase.expect.generatedName !== stored.name) {
      sink.add({
        file: suiteName,
        ruleId: 'generated-name-mismatch',
        pointer,
        message: `Case "${testCase.id}" expected the stored name "${excerpt(testCase.expect.generatedName, 120)}" and the policy produced "${stored.name}".`,
        evidence,
        suggestion: 'A digest-style name changes whenever the fixture bytes change. Update the expectation, or switch the policy to sequence style.',
      })
    }
  }

  if (realOut !== null) {
    for (const { testCase, bytes } of built) {
      const relative = `${testCase.id}${FIXTURE_EXTENSION}`
      const written = await materialise(sink, suiteName, join(realOut, relative), bytes, inputs, relative)
      if (written) state.written += 1
      else state.incomplete = true
    }
  }

  /**
   * The vacuous pass, refused explicitly.
   *
   * A suite whose `cases` array is empty compiles, the policy compiles, the
   * walk runs and evaluates nothing, and without this the run would report
   * `pass` with `checked: 0` -- green on no evidence at all. This finding and
   * the flag beside it are the only things standing between that suite and a
   * green build, and `test/incomplete.test.mjs` fails if either half is
   * removed.
   */
  if (state.checked === 0) {
    state.incomplete = true
    sink.add({
      file: suiteName,
      ruleId: 'no-cases-evaluated',
      pointer: '/cases',
      message: `The run evaluated 0 of ${suite.declared} declared case(s), so it has no evidence to be green on.`,
      suggestion: 'Declare at least one case, and fix whatever stopped the cases that are there from being built.',
    })
    return
  }

  /**
   * A suite that never sees a refusal is a suite that has not tested the part
   * of the policy that matters. It is a warning rather than an error because
   * the decisions it *did* obtain are real evidence -- but it is reported,
   * because "every fixture was accepted" and "the validator accepts
   * everything" look identical from the summary line.
   */
  if (state.rejected === 0) {
    sink.add({
      file: suiteName,
      ruleId: 'no-rejection-exercised',
      pointer: '/cases',
      message: `All ${state.checked} evaluated case(s) were accepted, so this run exercised no rejection and says nothing about what the policy refuses.`,
      suggestion: 'Add a fixture for each rejection reason the policy is meant to enforce.',
    })
  }

  /**
   * An acceptance nobody checked a byte of.
   *
   * `"signature": null` is a deliberate statement that a type's bytes cannot be
   * checked -- `text/plain` has no magic number -- so it is not a defect and
   * the run is not incomplete. What it is, is a decision reached without the
   * evidence the tool's name suggests: a run whose every type declared a null
   * signature accepted a fixture whose leading bytes were `MZ` under a `.txt`
   * name, reported status `pass` at exit 0, and said nothing anywhere about a
   * content check that never happened. That is absence being summarised as
   * evidence, and this is the line that stops it.
   *
   * Raised from the acceptances rather than from the policy: the policy says
   * which types *could* go unchecked, and only the decisions say which ones
   * actually did. A policy that lists an unverifiable type no fixture ever
   * reaches made no claim this run relied on, and a finding about it would be
   * noise on every report.
   */
  if (state.acceptedUnverifiable > 0) {
    sink.add({
      file: suiteName,
      ruleId: 'signature-unverifiable',
      pointer: '/cases',
      message: `${state.acceptedUnverifiable} of ${state.accepted} acceptance(s) are for a type declaring no signature, so those fixtures were accepted on their name, declared media type and size with no byte of their content checked.`,
      evidence: `unverifiable type(s): ${[...state.acceptedUnverifiableTypes].sort(byCodeUnit).join(', ')}`,
      suggestion: 'A null signature is a statement that these bytes cannot be checked, not a defect. Read each of these acceptances as a decision about a name, a declared media type and a size.',
    })
  }

  const unexercised = REJECTION_REASONS.filter((reason) => !exercised.has(reason))
  if (unexercised.length > 0) {
    sink.add({
      file: suiteName,
      ruleId: 'reason-unexercised',
      pointer: '/cases',
      message: `${unexercised.length} of ${REJECTION_REASONS.length} rejection reason(s) were never reached by this suite.`,
      evidence: `unexercised: ${unexercised.join(', ')}`,
      suggestion: 'Coverage of the catalog is not required, and an untested reason is a reason nobody has seen fire.',
    })
  }
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 completed and passed, 1 completed and failed, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report, extra = {}) {
  const { summary } = report
  const lines = [
    `policy ${excerpt(extra.policy ?? DEFAULT_POLICY_NAME, 80)}: ${summary.types} type(s) compiled.`,
    `suite ${excerpt(extra.suite ?? DEFAULT_SUITE_NAME, 80)}: ${summary.checked} of ${summary.cases} case(s) evaluated, ${summary.unevaluated} not evaluated, ${summary.bytesGenerated} inert byte(s) built.`,
    `outcomes: ${summary.accepted} accepted, ${summary.rejected} rejected, ${summary.written} fixture(s) written. status ${report.status}.`,
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ` +
      `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { SIGNATURES, SIGNATURE_NAMES, matchSignature, signatureLength, withSignature } from './signatures.mjs'
export {
  FILENAME_POLICY_KEYS, FILENAME_STYLES, MAX_TYPES, POLICY_KEYS,
  POLICY_SCHEMA_VERSION, TYPE_KEYS, compilePolicy,
} from './policy.mjs'
export { CASE_KEYS, CONTENT_KINDS, EXPECT_KEYS, SUITE_KEYS, SUITE_SCHEMA_VERSION, buildContent, compileSuite } from './suite.mjs'
export {
  EXCERPT_LIMIT, MAX_FILENAME_LENGTH, MAX_IDENTIFIER_LENGTH, MAX_MEDIA_TYPE_LENGTH,
  byCodeUnit, decodeUtf8, describeValue, excerpt, hasForbiddenCharacter, isCaseId, isPlainObject,
} from './text.mjs'
export { ACCEPT_REASON, DECISIONS, REJECTION_REASONS, decide, splitFilename, storedName } from './validate.mjs'
