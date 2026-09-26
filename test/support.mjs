/**
 * Fixtures and runners shared by the test suite.
 *
 * Two entry points are exercised throughout: `apiReport` calls the exported
 * function, and `cliRun` spawns the real binary and reads the real exit code.
 * Several guarantees in this package can only be pinned by the second -- a
 * table can be edited to agree with a test, and an exit code cannot.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { compilePolicy, runFixtureSuite, withSignature } from '../src/index.mjs'

const execFileAsync = promisify(execFile)

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/secure-file-upload-fixture.mjs')

export const pngType = (overrides = {}) => ({ extension: 'png', mimeTypes: ['image/png'], signature: 'png', ...overrides })
export const txtType = (overrides = {}) => ({ extension: 'txt', mimeTypes: ['text/plain'], signature: null, ...overrides })

/** A complete, valid policy. Pass `{ types: [...] }` to change the allow-list. */
export function policy(overrides = {}) {
  const { filenamePolicy, ...rest } = overrides
  return {
    schemaVersion: '1',
    maxBytes: 4096,
    allowEmpty: false,
    allowMultipleExtensions: false,
    onUnknown: 'reject',
    filenamePolicy: { style: 'digest', prefix: 'upload-', preserveOriginalName: false, ...(filenamePolicy ?? {}) },
    types: [pngType(), txtType()],
    ...rest,
  }
}

/** A complete, valid case: a PNG header in 64 bytes, expected to be accepted. */
export function fixtureCase(overrides = {}) {
  return {
    id: 'accept-png',
    filename: 'photo.png',
    declaredMimeType: 'image/png',
    content: { kind: 'signature', signature: 'png', bytes: 64 },
    expect: { decision: 'accept' },
    ...overrides,
  }
}

/** A case that is refused, for the reason a working allow-list gives. */
export function rejectCase(overrides = {}) {
  return fixtureCase({
    id: 'reject-exe',
    filename: 'setup.exe',
    declaredMimeType: 'image/png',
    content: { kind: 'padding', byte: 0, bytes: 16 },
    expect: { decision: 'reject', reason: 'extension-unknown' },
    ...overrides,
  })
}

export const suiteOf = (cases) => ({ schemaVersion: '1', cases })

/** A sink that only collects, for tests that drive a compiler directly. */
export const collectingSink = () => ({ rows: [], add(row) { this.rows.push(row) } })

/**
 * Compile a policy document, and fail loudly if it did not compile.
 *
 * Tests of the validator need a compiled policy and nothing else; a test that
 * silently received `null` here would assert about a validator that never ran.
 */
export function compiled(document) {
  const sink = collectingSink()
  const result = compilePolicy(sink, 'policy.json', document)
  if (result === null) {
    throw new Error(`the policy did not compile: ${sink.rows.map((row) => row.message).join(' | ')}`)
  }
  return result
}

/** The default pair of inputs, as objects. */
export const fixture = (policyDocument, cases) => ({
  'policy.json': policyDocument,
  'suite.json': suiteOf(cases),
})

/** The inert bytes a signature fixture of this size carries. */
export const withSignatureBytes = (name, length) => withSignature(name, length)

/** The stored name a digest-style policy produces for these bytes. */
export function digestName(bytes, extension, prefix = 'upload-') {
  return `${prefix}${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${extension}`
}

/**
 * Create a temporary root, write the named files into it, run `body(root)` and
 * remove the tree afterwards whatever happened.
 *
 * A string is written verbatim and a `Uint8Array` byte for byte, so a test can
 * plant text that is not JSON, or bytes that are not UTF-8 at all.
 */
export async function withRoot(files, body) {
  const root = await mkdtemp(join(tmpdir(), 'secure-file-upload-fixture-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Run the exported API over a temporary root. */
export async function apiReport(files, options = {}) {
  return withRoot(files, (root) => runFixtureSuite({ root, ...options }))
}

/** Spawn the real binary. Returns the exit code and both streams; never throws on a non-zero exit. */
export async function cliRun(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (typeof error.code !== 'number') {
      throw new Error(`the command did not run: ${error.code ?? error.signal ?? error.message}`)
    }
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Spawn the real binary over a temporary root, and parse whatever stdout carried. */
export async function cliReport(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--json', ...extraArgs])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

/** Every rule id a report raised, deduplicated and in code-unit order. */
export const raisedRules = (report) =>
  [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

/** The findings for one rule id, in emitted order. */
export const findingsFor = (report, ruleId) => report.findings.filter((finding) => finding.ruleId === ruleId)

/**
 * One character from each class the report contract names, built from code
 * points so every test file that uses them stays plain ASCII and readable.
 */
export const FORBIDDEN = Object.freeze({
  'C0 NUL': String.fromCharCode(0x00),
  'C0 LF': String.fromCharCode(0x0a),
  'C0 ESC': String.fromCharCode(0x1b),
  DEL: String.fromCharCode(0x7f),
  'C1 NEL': String.fromCharCode(0x85),
  'C1 CSI': String.fromCharCode(0x9b),
  'line separator': String.fromCharCode(0x2028),
  'paragraph separator': String.fromCharCode(0x2029),
  'bidi LRM': String.fromCharCode(0x200e),
  'bidi RLO': String.fromCharCode(0x202e),
  'bidi isolate': String.fromCharCode(0x2066),
})
