/**
 * Decoding, sanitising, ordering and value description.
 *
 * Nothing in this module touches the filesystem, the network, the locale or
 * the clock. Every string it handles arrived in a file this tool did not
 * write -- a policy, a fixture suite, a declared filename -- so every string
 * it returns is treated as data on its way into a report, never as something
 * allowed to shape a line of output.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Locale-aware comparison -- the string method and the collator class alike --
 * reads ICU data that differs between Node builds and between hosts, and both
 * treat punctuation as ignorable, so `case-a` and `caseA` swap places
 * depending on where the tool runs. A report that is deterministic on one
 * machine only is not deterministic. Neither spelling appears anywhere in this
 * package, and the ordering tests pin the order the tool *emits* rather than
 * the spelling of the comparator: a source scan cannot tell one from the
 * other, but an emitted sequence can.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output, in four classes.
 *
 * Built from code points rather than written literally: a literal U+2028 or
 * U+2029 inside a module is a line terminator to the JavaScript parser, and
 * the rest are invisible in an editor.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in
 *   the human summary; ESC opens a terminal escape sequence; NUL truncates a
 *   value in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Two of these need no ESC in front of them:
 *   U+0085 NEL is a line break to a great many consumers and U+009B is the
 *   8-bit CSI, a control introducer in its own right.
 * - **Line and paragraph separators** (U+2028, U+2029).
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE is the one that matters most
 *   to this tool: it is the classic way to display `photo<RLO>gnp.exe` as
 *   `photo` followed by something that reads like `exe.png`. Ordinary
 *   right-to-left text -- Arabic, Hebrew -- needs none of these, so refusing
 *   the overrides refuses nothing legitimate.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped from every untrusted string on its way into output -- case ids,
 * filenames, media types, pointers, messages, suggestions and evidence alike,
 * not only an excerpt field. Tab, newline and carriage return are left out of
 * this class on purpose: `excerpt` collapses all whitespace one step later,
 * which reaches the same result by a shorter route.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * The same four classes plus the three ASCII whitespace controls, used to
 * *detect* rather than to clean. A filename holding one of these is a
 * rejection with a named reason, not a value to tidy up and accept.
 */
const FORBIDDEN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)

/**
 * True when a string carries any character from the four classes. Exported so
 * tests can walk a whole serialised report and assert nothing survived,
 * instead of checking the one field somebody remembered.
 */
export function hasForbiddenCharacter(value) {
  return FORBIDDEN.test(String(value))
}

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 64
export const MAX_FILENAME_LENGTH = 255
export const MAX_MEDIA_TYPE_LENGTH = 127

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every identifier, filename, media type, pointer, message and piece of
 * evidence that reaches a finding goes through here. A sibling tool in this
 * catalog sanitised its evidence field carefully and left its identifiers
 * raw, so a record id holding a newline printed two lines into the human
 * summary and invented a finding that had never been emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * A case id is this tool's vocabulary: it names a fixture, it appears in the
 * JSON Pointer of every finding about that fixture, and -- when `--out` is
 * given -- it names the file written to disk. The alphabet is deliberately
 * narrow, and it is a refusal rather than a cleanup, because a value that is
 * silently rewritten between "what the suite asked for" and "what was written"
 * cannot be audited by the person reading either one.
 */
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isCaseId(value) {
  if (typeof value !== 'string') return false
  if (value.length > MAX_IDENTIFIER_LENGTH) return false
  if (value.includes('..')) return false
  return CASE_ID.test(value)
}

/**
 * Say what a refused value was, without reproducing any of it.
 *
 * A refused field is arbitrary content from a file this tool did not write,
 * and the report goes to stdout -- a stream that is piped, logged and pasted
 * somewhere more public than the suite ever was. Echoing the value back hands
 * that content a wider audience than it had, on exactly the fields whose
 * validation exists to keep a credential or a personal detail out of the
 * report. The pointer on the finding already names the position in the file,
 * and the value is still in the file, where it started.
 *
 * A filename that was *evaluated* is a different matter and is echoed under
 * `evidence`: the decision is a decision about that filename, so a report
 * that withheld it would be unreadable. That boundary is stated in the README.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains
 * a replacement character, and that confusion has already let an unread input
 * report a pass in this catalog. The decoder decides; the decoded text never
 * gets a vote. Every file this tool opens goes through here, the policy
 * included -- the configuration path is exactly where a sibling tool hardened
 * its data path and forgot.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * The keys of `record` that are not in `allowed`, ordered by code unit.
 *
 * An unknown key is refused rather than ignored throughout this package. A
 * one-character typo in a policy -- `maxByte` for `maxBytes` -- would
 * otherwise disable a documented limit silently, which is the difference
 * between a bound and a decoration.
 */
export function unknownKeys(record, allowed) {
  return Object.keys(record).filter((key) => !allowed.includes(key)).sort(byCodeUnit)
}
