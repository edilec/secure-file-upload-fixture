/**
 * The fixture suite: inert candidates and the outcome each one asserts.
 *
 * Every fixture this tool can build is one of three shapes, and there is no
 * fourth:
 *
 *  - `empty`     zero bytes;
 *  - `padding`   one byte value repeated;
 *  - `signature` a published magic signature followed by zero padding.
 *
 * There is deliberately no way to declare arbitrary bytes -- no base64 blob,
 * no inline text, no path to copy from. A suite file therefore cannot be
 * turned into a carrier for a payload, an archive, a polyglot or a script, and
 * that is a property of the format rather than a promise about how it is used.
 * What a fixture demonstrates is a *policy decision*: that a name, a declared
 * type and a size are accepted or refused, and why.
 *
 * The cost of that ceiling is stated in the README: these fixtures exercise
 * name, declared-type, size and leading-byte policy. They cannot exercise a
 * decoder, because they contain nothing for a decoder to read.
 */

import { SIGNATURES, signatureLength, withSignature } from './signatures.mjs'
import {
  MAX_FILENAME_LENGTH,
  byCodeUnit,
  describeValue,
  excerpt,
  isCaseId,
  isPlainObject,
  unknownKeys,
} from './text.mjs'
import { DECISIONS, REJECTION_REASONS } from './validate.mjs'

export const SUITE_SCHEMA_VERSION = '1'
export const SUITE_KEYS = Object.freeze(['cases', 'schemaVersion'])
export const CASE_KEYS = Object.freeze(['content', 'declaredMimeType', 'description', 'expect', 'filename', 'id'])
export const EXPECT_KEYS = Object.freeze(['decision', 'generatedName', 'reason'])
export const CONTENT_KINDS = Object.freeze(['empty', 'padding', 'signature'])

/**
 * A declared filename may be longer than the validator will consider and may
 * carry characters the validator refuses: that is the point of a fixture. The
 * ceiling here is four times the validator's, so `filename-too-long` can be
 * exercised without the suite becoming a place to park a kilobyte of text.
 */
const MAX_DECLARED_FILENAME = MAX_FILENAME_LENGTH * 4
const MAX_DECLARED_MEDIA_TYPE = 256
const MAX_DESCRIPTION = 200
const MAX_GENERATED_NAME = 120

function invalid(sink, file, pointer, message, suggestion) {
  sink.add({ file, ruleId: 'case-invalid', pointer, message, suggestion })
}

function compileContent(sink, file, pointer, value, limits, label) {
  if (!isPlainObject(value)) {
    invalid(sink, file, pointer, `Case ${label} must declare a content object; it declares ${describeValue(value)}.`)
    return null
  }
  if (!CONTENT_KINDS.includes(value.kind)) {
    invalid(
      sink, file, `${pointer}/kind`,
      `Case ${label} declares content kind ${describeValue(value.kind)}.`,
      `Content is inert by construction: kind must be one of ${CONTENT_KINDS.join(', ')}. There is no way to declare arbitrary bytes.`,
    )
    return null
  }
  const allowed = value.kind === 'empty' ? ['kind']
    : value.kind === 'padding' ? ['byte', 'bytes', 'kind']
      : ['bytes', 'kind', 'signature']
  const unknown = unknownKeys(value, allowed)
  if (unknown.length > 0) {
    invalid(
      sink, file, pointer,
      `Case ${label} content has ${unknown.length} unknown key(s) for kind "${value.kind}".`,
      `Known keys for this kind are ${allowed.join(', ')}.`,
    )
    return null
  }
  if (value.kind === 'empty') return { kind: 'empty', bytes: 0 }

  if (!Number.isInteger(value.bytes) || value.bytes < 0) {
    invalid(sink, file, `${pointer}/bytes`, `Case ${label} must declare a non-negative integer byte count; it declares ${describeValue(value.bytes)}.`)
    return null
  }
  if (value.bytes > limits.maxCaseBytes) {
    // Not a shape error: the declaration is well-formed and this build will
    // not allocate it. The run is incomplete rather than failed, because no
    // decision was reached about this fixture at all.
    sink.add({
      file,
      ruleId: 'case-too-large',
      pointer: `${pointer}/bytes`,
      message: `Case ${label} declares ${value.bytes} bytes, above the maxCaseBytes limit of ${limits.maxCaseBytes}; it was not built and not evaluated.`,
      suggestion: 'Raise --max-case-bytes, or lower the policy limit the fixture is testing so a smaller fixture can cross it.',
    })
    return null
  }

  if (value.kind === 'padding') {
    if (!Number.isInteger(value.byte) || value.byte < 0 || value.byte > 255) {
      invalid(sink, file, `${pointer}/byte`, `Case ${label} must declare the padding byte as an integer between 0 and 255; it declares ${describeValue(value.byte)}.`)
      return null
    }
    return { kind: 'padding', byte: value.byte, bytes: value.bytes }
  }

  if (typeof value.signature !== 'string' || !Object.hasOwn(SIGNATURES, value.signature)) {
    sink.add({
      file,
      ruleId: 'case-content-unsupported',
      pointer: `${pointer}/signature`,
      message: `Case ${label} asks for a signature this build does not know: ${describeValue(value.signature)}.`,
      suggestion: `Known signatures are ${Object.keys(SIGNATURES).sort(byCodeUnit).join(', ')}. A signature is never guessed at.`,
    })
    return null
  }
  const needed = signatureLength(value.signature)
  if (value.bytes < needed) {
    invalid(
      sink, file, `${pointer}/bytes`,
      `Case ${label} asks for a ${value.signature} signature in ${value.bytes} bytes, and the signature needs ${needed}.`,
      'To exercise content-signature-absent, declare a padding fixture shorter than the signature instead.',
    )
    return null
  }
  return { kind: 'signature', signature: value.signature, bytes: value.bytes }
}

function compileExpectation(sink, file, pointer, value, label) {
  if (!isPlainObject(value)) {
    invalid(sink, file, pointer, `Case ${label} must declare an expect object; it declares ${describeValue(value)}.`)
    return null
  }
  const unknown = unknownKeys(value, EXPECT_KEYS)
  if (unknown.length > 0) {
    invalid(
      sink, file, pointer,
      `Case ${label} expectation has ${unknown.length} unknown key(s).`,
      `Known keys are ${EXPECT_KEYS.join(', ')}.`,
    )
    return null
  }
  if (!DECISIONS.includes(value.decision)) {
    invalid(sink, file, `${pointer}/decision`, `Case ${label} must expect one of ${DECISIONS.join(', ')}; it expects ${describeValue(value.decision)}.`)
    return null
  }
  if (value.decision === 'reject') {
    // A rejection expectation must name its reason. "It gets rejected
    // somehow" passes while the reason drifts from "the extension is not on
    // the list" to "the file was empty", and the fixture stops testing the
    // rule it was written for.
    if (!REJECTION_REASONS.includes(value.reason)) {
      invalid(
        sink, file, `${pointer}/reason`,
        `Case ${label} expects a rejection but names ${describeValue(value.reason)} as the reason.`,
        `A rejection expectation must name one of: ${REJECTION_REASONS.join(', ')}.`,
      )
      return null
    }
    if (value.generatedName !== undefined) {
      invalid(sink, file, `${pointer}/generatedName`, `Case ${label} expects a rejection and also a stored name; a refused upload is never stored.`)
      return null
    }
    return { decision: 'reject', reason: value.reason }
  }
  if (value.reason !== undefined) {
    invalid(sink, file, `${pointer}/reason`, `Case ${label} expects acceptance, which has no rejection reason.`)
    return null
  }
  if (value.generatedName !== undefined
    && (typeof value.generatedName !== 'string' || value.generatedName.length === 0 || value.generatedName.length > MAX_GENERATED_NAME)) {
    invalid(sink, file, `${pointer}/generatedName`, `Case ${label} declares a stored name that is not a string of 1-${MAX_GENERATED_NAME} characters; it declares ${describeValue(value.generatedName)}.`)
    return null
  }
  if (value.generatedName !== undefined
    && (excerpt(value.generatedName, MAX_GENERATED_NAME) !== value.generatedName
      || /\p{Default_Ignorable_Code_Point}/u.test(value.generatedName))) {
    invalid(sink, file, `${pointer}/generatedName`, `Case ${label} expects a stored name that cannot be compared faithfully.`)
    return null
  }
  return { decision: 'accept', generatedName: value.generatedName }
}

/**
 * Compile the suite document.
 *
 * @returns `{cases, declared}` with cases in code-unit order by id, or `null`
 * when the document could not be used at all.
 */
export function compileSuite(sink, file, document, limits) {
  if (!isPlainObject(document)) {
    sink.add({ file, ruleId: 'suite-invalid', pointer: '', message: `The suite must be a JSON object; it is ${describeValue(document)}.` })
    return null
  }
  if (document.schemaVersion !== SUITE_SCHEMA_VERSION) {
    sink.add({
      file,
      ruleId: 'suite-invalid',
      pointer: '/schemaVersion',
      message: `Unsupported suite schemaVersion; this tool reads "${SUITE_SCHEMA_VERSION}" and the document declares ${describeValue(document.schemaVersion)}.`,
    })
    return null
  }
  const unknown = unknownKeys(document, SUITE_KEYS)
  if (unknown.length > 0) {
    sink.add({
      file,
      ruleId: 'suite-invalid',
      pointer: '',
      message: `The suite has ${unknown.length} unknown key(s).`,
      suggestion: `Known keys are ${SUITE_KEYS.join(', ')}.`,
    })
    return null
  }
  if (!Array.isArray(document.cases)) {
    sink.add({ file, ruleId: 'suite-invalid', pointer: '/cases', message: `The suite must declare a cases array; it declares ${describeValue(document.cases)}.` })
    return null
  }

  const cases = []
  const seen = new Set()
  for (const [index, entry] of document.cases.entries()) {
    const pointer = `/cases/${index}`
    if (!isPlainObject(entry)) {
      invalid(sink, file, pointer, `Case ${index} must be an object; it is ${describeValue(entry)}.`)
      continue
    }
    // The id remains the exact internal sort and output-file key. Findings
    // use this array index as their source position, never the id's text.
    if (!isCaseId(entry.id)) {
      invalid(
        sink, file, `${pointer}/id`,
        `Case ${index} has an id that is not 1-64 characters of letters, digits, dot, hyphen or underscore starting with a letter or digit; it is ${describeValue(entry.id)}.`,
        'The pointer above names the position in the file. The id itself is not reproduced in findings; it still names the file written under --out.',
      )
      continue
    }
    const id = entry.id
    const label = index
    if (seen.has(id)) {
      sink.add({
        file,
        ruleId: 'case-duplicate',
        pointer: `${pointer}/id`,
        message: `Case ${index} has an id already declared by an earlier case; the later declaration was not evaluated.`,
        suggestion: 'Give every case a unique id. Which duplicate won would otherwise depend on document order.',
      })
      continue
    }
    seen.add(id)

    const unknownCaseKeys = unknownKeys(entry, CASE_KEYS)
    if (unknownCaseKeys.length > 0) {
      invalid(
        sink, file, pointer,
        `Case ${label} has ${unknownCaseKeys.length} unknown key(s).`,
        `Known keys are ${CASE_KEYS.join(', ')}. Unknown key names and values are never reported.`,
      )
      continue
    }
    if (typeof entry.filename !== 'string' || entry.filename.length > MAX_DECLARED_FILENAME) {
      invalid(
        sink, file, `${pointer}/filename`,
        `Case ${label} must declare a filename string of at most ${MAX_DECLARED_FILENAME} characters; it declares ${describeValue(entry.filename)}.`,
        'An empty string is allowed, and exercises filename-empty.',
      )
      continue
    }
    if (typeof entry.declaredMimeType !== 'string' || entry.declaredMimeType.length > MAX_DECLARED_MEDIA_TYPE) {
      invalid(
        sink, file, `${pointer}/declaredMimeType`,
        `Case ${label} must declare a media type string of at most ${MAX_DECLARED_MEDIA_TYPE} characters; it declares ${describeValue(entry.declaredMimeType)}.`,
        'An empty string is allowed, and exercises mime-missing.',
      )
      continue
    }
    if (entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > MAX_DESCRIPTION)) {
      invalid(sink, file, `${pointer}/description`, `Case ${label} has a description that is not a string of at most ${MAX_DESCRIPTION} characters; it is ${describeValue(entry.description)}.`)
      continue
    }
    const content = compileContent(sink, file, `${pointer}/content`, entry.content, limits, label)
    if (content === null) continue
    const expect = compileExpectation(sink, file, `${pointer}/expect`, entry.expect, label)
    if (expect === null) continue

    cases.push({ id, index, filename: entry.filename, declaredMimeType: entry.declaredMimeType, content, expect })
  }

  cases.sort((left, right) => byCodeUnit(left.id, right.id))
  return { cases, declared: document.cases.length }
}

/**
 * Build the bytes for a compiled content declaration.
 *
 * Three shapes, no fourth, and every one of them allocated here rather than
 * read from anywhere: this function touches no filesystem and copies nothing.
 */
export function buildContent(content) {
  if (content.kind === 'empty') return new Uint8Array(0)
  if (content.kind === 'padding') {
    const bytes = new Uint8Array(content.bytes)
    bytes.fill(content.byte)
    return bytes
  }
  return withSignature(content.signature, content.bytes)
}
