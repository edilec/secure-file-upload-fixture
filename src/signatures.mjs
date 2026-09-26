/**
 * The published magic-number signatures this tool knows.
 *
 * Every entry is the documented leading bytes of a format, taken from the
 * format's own specification. A signature is used for exactly two things:
 *
 *  1. building an inert fixture whose first bytes are a real header, and
 *  2. checking that a fixture's bytes agree with the media type it declares.
 *
 * Nothing here is a parser. This tool never decodes an image, never walks a
 * container, and never executes anything: a signature check is a byte
 * comparison at fixed offsets and nothing more. That is a deliberate ceiling
 * on the claim the tool makes -- matching a signature says the first bytes
 * are consistent with the declared type, and says nothing whatever about the
 * rest of the file. The README says so in those words.
 *
 * A type whose signature is unknown is not guessed at. The policy must say
 * `"signature": null` on purpose, and that is recorded in the report, because
 * "we could not check the bytes" must never be indistinguishable from "the
 * bytes checked out".
 */

import { byCodeUnit } from './text.mjs'

/** @param {string} hex an even-length lowercase hex string */
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * Each signature is a list of segments, because not every format puts its
 * whole marker at offset zero: a RIFF container carries `RIFF` at 0 and the
 * form type at 8, with a four-byte length in between that no fixture can
 * usefully fix.
 */
function segments(...pairs) {
  return Object.freeze(pairs.map(([offset, hex]) => Object.freeze({ offset, bytes: fromHex(hex) })))
}

export const SIGNATURES = Object.freeze({
  // PNG specification, section 5.2: the eight-byte signature.
  png: segments([0, '89504e470d0a1a0a']),
  // JFIF/JPEG: SOI followed by the first marker byte.
  jpeg: segments([0, 'ffd8ff']),
  // GIF89a header block.
  gif89a: segments([0, '474946383961']),
  // PDF 1.x header: "%PDF-".
  pdf: segments([0, '255044462d']),
  // RIFF container with the WEBP form type at offset 8.
  webp: segments([0, '52494646'], [8, '57454250']),
})

export const SIGNATURE_NAMES = Object.freeze(Object.keys(SIGNATURES).sort(byCodeUnit))

/** The number of bytes a fixture needs before a signature can be written or checked. */
export function signatureLength(name) {
  const spec = SIGNATURES[name]
  if (spec === undefined) return null
  let end = 0
  for (const segment of spec) end = Math.max(end, segment.offset + segment.bytes.length)
  return end
}

/**
 * Compare bytes against a signature at its declared offsets.
 *
 * Returns `absent` when the buffer is shorter than the signature needs: a
 * truncated file has not matched, and it has not mismatched either, and the
 * two are reported under different rejection reasons so that a reader can tell
 * "the wrong type" from "nothing to look at".
 */
export function matchSignature(name, bytes) {
  const spec = SIGNATURES[name]
  if (spec === undefined) return 'unknown'
  const needed = signatureLength(name)
  if (bytes.length < needed) return 'absent'
  for (const segment of spec) {
    for (let index = 0; index < segment.bytes.length; index += 1) {
      if (bytes[segment.offset + index] !== segment.bytes[index]) return 'mismatch'
    }
  }
  return 'match'
}

/** Write a signature into a zero-filled buffer of `length` bytes. */
export function withSignature(name, length) {
  const spec = SIGNATURES[name]
  if (spec === undefined) return null
  const needed = signatureLength(name)
  if (length < needed) return null
  const bytes = new Uint8Array(length)
  for (const segment of spec) bytes.set(segment.bytes, segment.offset)
  return bytes
}
