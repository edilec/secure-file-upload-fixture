/**
 * The upload validator: one decision per candidate, with a named reason.
 *
 * This module is the whole subject of the tool. It takes a compiled policy and
 * a candidate -- a declared filename, a declared media type and the fixture's
 * bytes -- and returns `accept` or `reject` with exactly one reason from a
 * closed catalog.
 *
 * Two properties are load-bearing and are pinned by tests that fail when
 * either is removed:
 *
 *  - **Fail closed.** There is no default-accept path. A candidate is accepted
 *    only by reaching the end of every check with a type the policy declared,
 *    a media type that type declared, a size within the limit, and -- where a
 *    signature is known -- bytes that match it. An extension the policy does
 *    not list, a media type it does not list, or a media type that belongs to
 *    a different extension is a rejection, in that order.
 *  - **The stored name is derived, never inherited.** The extension of a
 *    stored file comes from the policy's canonical extension for the accepted
 *    type; the stem comes from a digest of the bytes or from a sequence
 *    number. Nothing the uploader wrote reaches the stored name unless the
 *    policy explicitly asks for it, and when it does, that is reported.
 *
 * What this module does *not* do is stated plainly in the README: a signature
 * check is a byte comparison at fixed offsets. It says the first bytes are
 * consistent with a declared type. It is not a parser, it is not a scanner,
 * and it cannot tell you a file is safe.
 */

import { createHash } from 'node:crypto'

import { matchSignature } from './signatures.mjs'
import { MAX_FILENAME_LENGTH, MAX_MEDIA_TYPE_LENGTH, hasForbiddenCharacter } from './text.mjs'

/**
 * Every reason a candidate can be refused, in the order the checks run.
 *
 * The order is part of the contract: a candidate that trips two checks is
 * reported under the first, so a fixture can assert one exact reason instead
 * of "one of these". `docs/upload-policy-rules.md` carries the same list.
 */
export const REJECTION_REASONS = Object.freeze([
  'filename-empty',
  'filename-too-long',
  'filename-unsafe-characters',
  'filename-path-segment',
  'filename-reserved',
  'extension-missing',
  'extension-multiple',
  'extension-unknown',
  'mime-missing',
  'mime-unknown',
  'mime-extension-mismatch',
  'size-empty',
  'size-over-limit',
  'content-signature-absent',
  'content-signature-mismatch',
])

export const ACCEPT_REASON = 'accepted'
export const DECISIONS = Object.freeze(['accept', 'reject'])

/**
 * Names that are not files on one of the two operating systems a stored upload
 * is likely to land on. `CON` and friends are devices on Windows whatever
 * extension follows them; a trailing dot or space is silently trimmed by the
 * Win32 API, so `report.png.` and `report.png` are the same file there and
 * different files in the manifest that recorded them; a leading dot hides the
 * file on Unix and leaves it with no stem at all.
 */
const RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/
const SAFE_STORED_NAME = /^[a-z0-9][a-z0-9._-]{0,95}$/

const reject = (reason, detail) => ({ decision: 'reject', reason, detail })

/**
 * Split a filename into its stem and its extension components.
 *
 * `archive.tar.gz` has two components and `invoice.pdf.exe` has two as well:
 * this function does not judge, it only reports what is there, and the policy
 * decides whether more than one is allowed.
 */
export function splitFilename(filename) {
  const parts = filename.split('.')
  return { stem: parts[0], extensions: parts.slice(1) }
}

/**
 * Decide one candidate.
 *
 * @param {object} policy a compiled policy
 * @param {{filename: string, declaredMimeType: string, bytes: Uint8Array}} candidate
 * @returns {{decision: string, reason: string, detail?: string, type?: object, limit?: number}}
 */
export function decide(policy, candidate) {
  const { filename, declaredMimeType, bytes } = candidate

  if (typeof filename !== 'string' || filename.length === 0) {
    return reject('filename-empty', 'the candidate declared no filename')
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    return reject('filename-too-long', `the filename is ${filename.length} characters, above the ${MAX_FILENAME_LENGTH} this validator will consider`)
  }
  if (hasForbiddenCharacter(filename)) {
    return reject(
      'filename-unsafe-characters',
      'the filename carries a control, separator or bidi character; a right-to-left override alone can make an executable extension read as an image one',
    )
  }
  if (filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    return reject('filename-path-segment', 'the filename carries a path segment, so it names a location rather than a file')
  }
  const { stem, extensions } = splitFilename(filename)
  if (stem.length === 0 || filename.endsWith('.') || filename.endsWith(' ') || filename.startsWith(' ')) {
    return reject('filename-reserved', 'the filename has no stem, or a leading or trailing dot or space that the filesystem would trim')
  }
  if (RESERVED_STEM.test(stem)) {
    return reject('filename-reserved', `"${stem}" is a reserved device name on Windows whatever extension follows it`)
  }
  if (extensions.length === 0) {
    return reject('extension-missing', 'the filename has no extension, so there is nothing to match against the allow-list')
  }
  if (extensions.length > 1 && !policy.allowMultipleExtensions) {
    return reject(
      'extension-multiple',
      `the filename carries ${extensions.length} extension components, and this policy accepts one`,
    )
  }

  const extension = extensions[extensions.length - 1].toLowerCase()
  const type = policy.types.get(extension)
  if (type === undefined) {
    // The fail-closed default. Every unrecognised extension lands here; there
    // is no branch below that can be reached without a declared type.
    return reject('extension-unknown', `the policy declares no type for the extension "${extension}"`)
  }

  if (typeof declaredMimeType !== 'string' || declaredMimeType.trim().length === 0) {
    return reject('mime-missing', 'the candidate declared no media type')
  }
  const mimeType = declaredMimeType.trim().toLowerCase()
  if (mimeType.length > MAX_MEDIA_TYPE_LENGTH || !MEDIA_TYPE.test(mimeType) || !policy.mimeIndex.has(mimeType)) {
    return reject('mime-unknown', 'the declared media type is not one this policy knows, in any type')
  }
  if (!type.mimeTypes.includes(mimeType)) {
    return reject(
      'mime-extension-mismatch',
      `the declared media type belongs to another type; "${extension}" accepts ${type.mimeTypes.join(', ')}`,
    )
  }

  const limit = type.maxBytes ?? policy.maxBytes
  if (bytes.length === 0 && !policy.allowEmpty) {
    return reject('size-empty', 'the candidate is zero bytes and this policy does not accept empty uploads')
  }
  if (bytes.length > limit) {
    return { ...reject('size-over-limit', `${bytes.length} bytes, above the ${limit} this policy allows for "${extension}"`), limit }
  }

  if (type.signature !== null) {
    const outcome = matchSignature(type.signature, bytes)
    if (outcome === 'absent') {
      return reject(
        'content-signature-absent',
        `the candidate is too short to carry the ${type.signature} signature, so its bytes could not corroborate the declared type`,
      )
    }
    if (outcome !== 'match') {
      // `unknown` cannot arrive here -- a policy naming an unknown signature
      // does not compile -- but if it ever did, "we could not look" must not
      // become "we looked and it was fine".
      return reject(
        'content-signature-mismatch',
        `the leading bytes do not match the ${type.signature} signature the policy requires for "${extension}"`,
      )
    }
  }

  return { decision: 'accept', reason: ACCEPT_REASON, type, limit }
}

/** Lowercase, hyphenated, bounded: what is left of an uploaded stem if a policy insists on keeping it. */
function sanitiseStem(stem) {
  const cleaned = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return cleaned.length === 0 ? 'file' : cleaned
}

/**
 * The stored name for an accepted candidate, plus the name the safe derivation
 * would have produced.
 *
 * The two are computed independently and compared by the caller. That is
 * deliberate: a substring test ("does the stored name contain the uploaded
 * one?") has a real false-positive rate against a hex digest, and a check that
 * cries wolf is a check somebody switches off. Comparing against the derived
 * name is exact -- any character the policy added from the uploaded filename
 * makes the two differ.
 *
 * The digest is SHA-256 from `node:crypto`. It is used as a content address,
 * not as a secret: no primitive is invented here and nothing is compared for
 * equality against an attacker-supplied digest.
 */
export function storedName(policy, { extension, bytes, sequence, filename }) {
  const { prefix, style, preserveOriginalName } = policy.filenamePolicy
  const core = style === 'digest'
    ? createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    : String(sequence).padStart(6, '0')
  const derived = `${prefix}${core}.${extension}`
  const { stem } = splitFilename(filename)
  const name = preserveOriginalName ? `${prefix}${core}-${sanitiseStem(stem)}.${extension}` : derived

  const problems = []
  if (name !== derived) problems.push('it carries text from the uploaded filename')
  if (!SAFE_STORED_NAME.test(name)) problems.push('it is not a plain lowercase name with a single dot')
  if (name.split('.').length !== 2) problems.push('it has more than one extension component')
  if (!name.endsWith(`.${extension}`)) problems.push('its extension is not the canonical extension for the accepted type')

  return { name, derived, safe: problems.length === 0, problems }
}
