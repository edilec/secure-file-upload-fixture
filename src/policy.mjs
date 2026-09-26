/**
 * The upload policy: what the validator is allowed to accept.
 *
 * A policy is compiled, not interpreted loosely. Every field is required to be
 * present and well-formed, every unknown key is refused, and a policy that
 * cannot be compiled produces no decisions at all -- because a validator
 * running on a policy nobody could read would be reporting its own defaults as
 * if they were somebody's intent.
 *
 * The one thing a policy may not say is "accept what you do not recognise".
 * `onUnknown` exists precisely so that a fail-open policy can be *named and
 * refused* rather than silently ignored: a key the tool does not read is a key
 * whose value nobody checks.
 */

import { SIGNATURES } from './signatures.mjs'
import { byCodeUnit, describeValue, isPlainObject, unknownKeys } from './text.mjs'

export const POLICY_SCHEMA_VERSION = '1'

export const POLICY_KEYS = Object.freeze([
  'allowEmpty',
  'allowMultipleExtensions',
  'filenamePolicy',
  'maxBytes',
  'onUnknown',
  'schemaVersion',
  'types',
])

export const TYPE_KEYS = Object.freeze(['extension', 'maxBytes', 'mimeTypes', 'signature'])
export const FILENAME_POLICY_KEYS = Object.freeze(['preserveOriginalName', 'prefix', 'style'])
export const FILENAME_STYLES = Object.freeze(['digest', 'sequence'])

/** A policy limit is a byte count, not a universe: a terabyte is already absurd for an upload. */
export const MAX_POLICY_BYTES = 1099511627776
export const MAX_TYPES = 200
export const MAX_MIME_TYPES_PER_TYPE = 20

const EXTENSION = /^[a-z0-9][a-z0-9]{0,7}$/
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/
const PREFIX = /^[a-z0-9][a-z0-9-]{0,15}$/

function invalid(sink, file, pointer, message, suggestion) {
  sink.add({ file, ruleId: 'policy-invalid', pointer, message, suggestion })
}

function integerBetween(value, low, high) {
  return Number.isInteger(value) && value >= low && value <= high
}

/**
 * Compile one declared type.
 *
 * Returns `null` when the entry could not be compiled, which makes the run
 * incomplete: a policy that is missing one of its types is not the policy the
 * author wrote, and deciding uploads against the remainder while reporting a
 * clean pass would be answering a question nobody asked.
 */
function compileType(sink, file, index, entry) {
  const pointer = `/types/${index}`
  if (!isPlainObject(entry)) {
    invalid(sink, file, pointer, `Type entry ${index} must be an object; it is ${describeValue(entry)}.`)
    return null
  }
  const unknown = unknownKeys(entry, TYPE_KEYS)
  if (unknown.length > 0) {
    invalid(
      sink, file, pointer,
      `Type entry ${index} has ${unknown.length} unknown key(s).`,
      `Known keys are ${TYPE_KEYS.join(', ')}. An unknown key is refused rather than ignored.`,
    )
    return null
  }
  if (typeof entry.extension !== 'string' || !EXTENSION.test(entry.extension)) {
    invalid(
      sink, file, `${pointer}/extension`,
      `Type entry ${index} needs a canonical extension of 1-8 lowercase letters or digits; it is ${describeValue(entry.extension)}.`,
      'The canonical extension is what a stored file is named with. It is never taken from the uploaded filename.',
    )
    return null
  }
  if (!Array.isArray(entry.mimeTypes) || entry.mimeTypes.length === 0 || entry.mimeTypes.length > MAX_MIME_TYPES_PER_TYPE) {
    invalid(
      sink, file, `${pointer}/mimeTypes`,
      `Type entry ${index} needs between 1 and ${MAX_MIME_TYPES_PER_TYPE} declared media types; it has ${describeValue(entry.mimeTypes)}.`,
    )
    return null
  }
  const mimeTypes = []
  for (const [position, mimeType] of entry.mimeTypes.entries()) {
    if (typeof mimeType !== 'string' || !MEDIA_TYPE.test(mimeType)) {
      invalid(
        sink, file, `${pointer}/mimeTypes/${position}`,
        `Type entry ${index} declares a media type that is not a lowercase type/subtype pair; it is ${describeValue(mimeType)}.`,
        'Declare media types without parameters, for example image/png rather than image/png; charset=binary.',
      )
      return null
    }
    mimeTypes.push(mimeType)
  }
  if (!(entry.signature === null || (typeof entry.signature === 'string' && Object.hasOwn(SIGNATURES, entry.signature)))) {
    invalid(
      sink, file, `${pointer}/signature`,
      `Type entry ${index} must name a known signature or state null; it is ${describeValue(entry.signature)}.`,
      `Known signatures are ${Object.keys(SIGNATURES).sort(byCodeUnit).join(', ')}. State null to record on purpose that this type's bytes cannot be checked.`,
    )
    return null
  }
  if (entry.maxBytes !== undefined && !integerBetween(entry.maxBytes, 0, MAX_POLICY_BYTES)) {
    invalid(
      sink, file, `${pointer}/maxBytes`,
      `Type entry ${index} has a maxBytes that is not an integer between 0 and ${MAX_POLICY_BYTES}; it is ${describeValue(entry.maxBytes)}.`,
    )
    return null
  }
  return {
    extension: entry.extension,
    mimeTypes: Object.freeze(mimeTypes),
    signature: entry.signature,
    maxBytes: entry.maxBytes,
  }
}

function compileFilenamePolicy(sink, file, value) {
  const pointer = '/filenamePolicy'
  if (!isPlainObject(value)) {
    invalid(sink, file, pointer, `filenamePolicy must be an object; it is ${describeValue(value)}.`)
    return null
  }
  const unknown = unknownKeys(value, FILENAME_POLICY_KEYS)
  if (unknown.length > 0) {
    invalid(
      sink, file, pointer,
      `filenamePolicy has ${unknown.length} unknown key(s).`,
      `Known keys are ${FILENAME_POLICY_KEYS.join(', ')}.`,
    )
    return null
  }
  if (!FILENAME_STYLES.includes(value.style)) {
    invalid(
      sink, file, `${pointer}/style`,
      `filenamePolicy.style must be one of ${FILENAME_STYLES.join(', ')}; it is ${describeValue(value.style)}.`,
    )
    return null
  }
  if (typeof value.prefix !== 'string' || !PREFIX.test(value.prefix)) {
    invalid(
      sink, file, `${pointer}/prefix`,
      `filenamePolicy.prefix must be 1-16 lowercase letters, digits or hyphens; it is ${describeValue(value.prefix)}.`,
    )
    return null
  }
  if (typeof value.preserveOriginalName !== 'boolean') {
    invalid(
      sink, file, `${pointer}/preserveOriginalName`,
      `filenamePolicy.preserveOriginalName must be stated as true or false; it is ${describeValue(value.preserveOriginalName)}.`,
      'State it explicitly. A stored name that keeps user-controlled text is a decision, not a default.',
    )
    return null
  }
  return Object.freeze({ style: value.style, prefix: value.prefix, preserveOriginalName: value.preserveOriginalName })
}

/**
 * Compile the policy document.
 *
 * @returns the compiled policy, or `null` when the document could not be used
 * at all. A `null` return means no upload decision was reached, which the
 * caller turns into an incomplete run -- never into a pass.
 */
export function compilePolicy(sink, file, document) {
  if (!isPlainObject(document)) {
    invalid(sink, file, '', `The policy must be a JSON object; it is ${describeValue(document)}.`)
    return null
  }
  if (document.schemaVersion !== POLICY_SCHEMA_VERSION) {
    invalid(
      sink, file, '/schemaVersion',
      `Unsupported policy schemaVersion; this tool reads "${POLICY_SCHEMA_VERSION}" and the document declares ${describeValue(document.schemaVersion)}.`,
    )
    return null
  }
  const unknown = unknownKeys(document, POLICY_KEYS)
  if (unknown.length > 0) {
    invalid(
      sink, file, '',
      `The policy has ${unknown.length} unknown key(s).`,
      `Known keys are ${POLICY_KEYS.join(', ')}. Unknown key names and values are never reported.`,
    )
    return null
  }

  /**
   * Fail-open, named rather than ignored.
   *
   * `reject` is the only value this tool will run with. `accept` is recognised
   * so that it can be refused under its own rule id instead of arriving as a
   * generic shape error, and the run stops: compiling a policy whose author
   * asked for fail-open, and then quietly enforcing fail-closed anyway, would
   * report a green run about a policy that was never enforced.
   */
  if (document.onUnknown === 'accept') {
    sink.add({
      file,
      ruleId: 'policy-fail-open',
      pointer: '/onUnknown',
      message: 'The policy asks for unknown extensions and media types to be accepted. This tool only runs fail-closed, so no upload decision was made.',
      suggestion: 'Set onUnknown to "reject". An upload validator that accepts what it does not recognise has no allow-list at all.',
    })
    return null
  }
  if (document.onUnknown !== 'reject') {
    invalid(
      sink, file, '/onUnknown',
      `onUnknown must be "reject"; it is ${describeValue(document.onUnknown)}.`,
      'The value is required and explicit so that a fail-open policy is a statement somebody wrote, not a default nobody noticed.',
    )
    return null
  }

  if (!integerBetween(document.maxBytes, 1, MAX_POLICY_BYTES)) {
    invalid(
      sink, file, '/maxBytes',
      `maxBytes must be an integer between 1 and ${MAX_POLICY_BYTES}; it is ${describeValue(document.maxBytes)}.`,
    )
    return null
  }
  for (const key of ['allowEmpty', 'allowMultipleExtensions']) {
    if (typeof document[key] !== 'boolean') {
      invalid(sink, file, `/${key}`, `${key} must be stated as true or false; it is ${describeValue(document[key])}.`)
      return null
    }
  }

  const filenamePolicy = compileFilenamePolicy(sink, file, document.filenamePolicy)
  if (filenamePolicy === null) return null

  if (!Array.isArray(document.types) || document.types.length > MAX_TYPES) {
    invalid(
      sink, file, '/types',
      `types must be an array of at most ${MAX_TYPES} entries; it is ${describeValue(document.types)}.`,
    )
    return null
  }

  const types = new Map()
  const mimeIndex = new Set()
  let compiled = 0
  for (const [index, entry] of document.types.entries()) {
    const type = compileType(sink, file, index, entry)
    if (type === null) continue
    if (types.has(type.extension)) {
      invalid(
        sink, file, `/types/${index}/extension`,
        `Type entry ${index} has an extension declared more than once, so which entry governs it would depend on document order.`,
      )
      continue
    }
    types.set(type.extension, type)
    for (const mimeType of type.mimeTypes) mimeIndex.add(mimeType)
    compiled += 1
  }

  return {
    maxBytes: document.maxBytes,
    allowEmpty: document.allowEmpty,
    allowMultipleExtensions: document.allowMultipleExtensions,
    filenamePolicy,
    types,
    mimeIndex,
    declaredTypes: document.types.length,
    compiledTypes: compiled,
    // Keep exact extensions for internal matching; reports expose only counts
    // and source positions, because even a valid extension may be private.
    unverifiableTypes: [...types.values()]
      .filter((type) => type.signature === null)
      .map((type) => type.extension)
      .sort(byCodeUnit),
  }
}
