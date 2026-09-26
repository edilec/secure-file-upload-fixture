#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_POLICY_NAME,
  DEFAULT_SUITE_NAME,
  excerpt,
  exitCodeFor,
  formatReport,
  runFixtureSuite,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `secure-file-upload-fixture

Run inert local fixtures against an upload size, extension, declared MIME and
generated-filename policy, and assert every acceptance and every rejection.

Nothing is uploaded anywhere. Every fixture is built in memory from one of
three inert shapes -- zero bytes, one repeated byte, or a published magic
signature followed by zero padding -- so a suite file cannot carry a payload,
an archive or a script. A fixture demonstrates a policy decision, not an
attack.

Usage:
  secure-file-upload-fixture --root DIR [--policy FILE] [--suite FILE]
                             [--out DIR] [--json]
                             [--max-cases N] [--max-case-bytes N]
                             [--max-total-bytes N] [--max-file-bytes N]
                             [--max-findings N]

Options:
  --root DIR            Directory holding both inputs (required)
  --policy FILE         Upload policy, relative to --root (default ${DEFAULT_POLICY_NAME})
  --suite FILE          Fixture suite, relative to --root (default ${DEFAULT_SUITE_NAME})
  --out DIR             Existing directory to write each built fixture into,
                        one file per case named <case-id>.fixture. Nothing is
                        ever overwritten and nothing outside this directory is
                        touched.
  --json                Suppress the human summary on stderr
  --max-cases N         Maximum cases evaluated (default 500)
  --max-case-bytes N    Maximum bytes in one fixture (default 1048576)
  --max-total-bytes N   Maximum bytes built in one run (default 8388608)
  --max-file-bytes N    Maximum bytes per input document (default 5242880)
  --max-findings N      Maximum findings in one report (default 1000)
  -h, --help            Show this help
  -v, --version         Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Output:
  stdout  a run puts the JSON report there and nothing else, so it can be
          piped straight into a parser
  stderr  the human summary and diagnostics

  Findings use @policy and @suite as logical source roles and /cases/N as
  original suite positions. Supplied input paths and case ids are not copied
  into report streams; --out still names files <case-id>.fixture.

  --help and --version are not runs: they answer about the tool, print on
  stdout and exit 0 without reading either input, so a script that parses
  stdout should not pass them.

What a pass means:
  Every fixture that was built reached the decision it declared, for the reason
  it declared. It does not mean the policy is sufficient, that the accepted
  files are safe, or that the service which deploys this policy enforces it.
  The signature check is a byte comparison at fixed offsets; it is not a parser
  and not a scanner.

Exit codes (of a run; --help and --version exit 0 with their own text):
  0  every fixture reached the outcome it expected
  1  at least one fixture reached a different outcome
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-case-bytes', 'maxCaseBytes'],
  ['--max-cases', 'maxCases'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-total-bytes', 'maxTotalBytes'],
])

const VALUE_FLAGS = new Map([
  ['--out', 'out'],
  ['--policy', 'policy'],
  ['--root', 'root'],
  ['--suite', 'suite'],
])

const KNOWN_FLAGS = [...VALUE_FLAGS.keys(), '--json', ...LIMIT_FLAGS.keys(), '-h', '--help', '-v', '--version'].join(', ')

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, policy: null, suite: null, out: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--suite a --suite b` runs a suite nobody named and
   * `--max-cases 5 --max-cases 5000` enforces a bound nobody asked for. That is
   * the same defect as an ignored typo, which this tool also refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d{1,12}$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option; known options are ${KNOWN_FLAGS}`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await runFixtureSuite({
      root: options.root,
      limits: options.limits,
      ...(options.policy === null ? {} : { policy: options.policy }),
      ...(options.suite === null ? {} : { suite: options.suite }),
      ...(options.out === null ? {} : { out: options.out }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and a
    // consumer that pipes stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) {
    process.stderr.write(formatReport(report))
  }
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.cases} declared case(s) were evaluated; this run is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
