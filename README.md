# secure-file-upload-fixture

Run inert local fixtures against an upload **size, extension, declared MIME and
generated-filename policy**, and assert every acceptance and every rejection.

Nothing is uploaded anywhere. The tool reads two JSON documents — a policy
saying what may be accepted, and a suite of fixture cases each declaring the
outcome it expects — builds every fixture in memory from one of three inert
shapes, runs the validator over it, and reports where the outcome and the
expectation disagree.

Every fixture is **zero bytes, one byte value repeated, or a published magic
signature followed by zero padding**. There is no way to declare arbitrary
bytes, so a suite file cannot carry a payload, an archive, a polyglot or a
script. A fixture here demonstrates a *policy decision*; it is never an attack.

- **Repository:** [edilec/secure-file-upload-fixture](https://github.com/edilec/secure-file-upload-fixture)
- **License:** MIT
- **Runtime:** Node 22 or later, no dependencies

## Install

```sh
npm install secure-file-upload-fixture
```

Or run it from a checkout with no install step at all — the package has no
runtime and no development dependencies.

## Use

```sh
secure-file-upload-fixture --root examples/clean
secure-file-upload-fixture --root examples/broken --json | jq '.findings[].ruleId'
```

A **run** puts the JSON report on stdout and nothing else, so stdout pipes
straight into a parser. The human summary and every diagnostic go to stderr;
`--json` suppresses the summary. `--help` and `-h`, `--version` and `-v` are
not runs: they answer about the tool rather than about a policy, print their
answer on stdout and exit 0 without reading either input. A script that parses
stdout should not pass them.

```
policy @policy: 4 type(s) compiled.
suite @suite: 19 of 19 case(s) evaluated, 0 not evaluated, 6676 inert byte(s) built.
outcomes: 4 accepted, 15 rejected, 0 fixture(s) written. status pass.
```

To write the fixtures out — so an external validator, a form or a staging
service can be fed the same bytes by hand — pass a directory:

```sh
secure-file-upload-fixture --root examples/clean --out ./built
```

One file per evaluated case, named `<case-id>.fixture`. Nothing is ever
overwritten: an existing destination is refused with a finding, and a
destination that turns out to be one of this run's own inputs — reached under a
second name, so no path comparison could see it — is refused by device and
inode.

As a library:

```js
import { exitCodeFor, formatReport, runFixtureSuite } from 'secure-file-upload-fixture'

const report = await runFixtureSuite({ root: 'examples/broken' })
process.stderr.write(formatReport(report))
process.exitCode = exitCodeFor(report)
```

### Exit codes

`--help` and `--version` are outside this table: they exit 0 with their own
text on stdout, having read nothing.

| Exit | Meaning | stdout |
| ---: | --- | --- |
| `0` | every fixture reached the outcome it declared | the report |
| `1` | at least one fixture reached a different outcome | the report |
| `2` | invalid configuration or bad usage | **empty** |
| `2` | evidence that could not be obtained; status `incomplete` | the report |

A consumer that pipes stdout must handle an empty stdout on exit 2. A
configuration error means the run never had a subject, so there is nothing to
report about; unreadable or unbuildable evidence means the run had a subject
and failed to learn something about it, and the report says which case or input
that was. `incomplete` is never `pass`.

## The two inputs

A **policy** says what may be accepted:

```json
{
  "schemaVersion": "1",
  "maxBytes": 4096,
  "allowEmpty": false,
  "allowMultipleExtensions": false,
  "onUnknown": "reject",
  "filenamePolicy": { "style": "digest", "prefix": "upload-", "preserveOriginalName": false },
  "types": [
    { "extension": "png", "mimeTypes": ["image/png"], "signature": "png", "maxBytes": 2048 },
    { "extension": "txt", "mimeTypes": ["text/csv", "text/plain"], "signature": null }
  ]
}
```

A **suite** declares fixtures and the outcome each one asserts:

```json
{
  "schemaVersion": "1",
  "cases": [
    {
      "id": "accept-png-signature",
      "filename": "Holiday Photo (final).PNG",
      "declaredMimeType": "image/png",
      "content": { "kind": "signature", "signature": "png", "bytes": 1024 },
      "expect": { "decision": "accept", "generatedName": "upload-c889ec5faf131e7a2a89786eceb56027.png" }
    },
    {
      "id": "reject-oversize-png",
      "filename": "poster.png",
      "declaredMimeType": "image/png",
      "content": { "kind": "signature", "signature": "png", "bytes": 4096 },
      "expect": { "decision": "reject", "reason": "size-over-limit" }
    }
  ]
}
```

A rejection expectation must name its reason. "It gets rejected somehow" keeps
passing while the reason drifts from *the extension is not on the list* to *the
file was empty*, and the fixture stops testing the rule it was written for.

Every field, every content shape and every rejection reason is in
[`docs/upload-policy-rules.md`](./docs/upload-policy-rules.md).

## Fail closed

There is no default-accept path. A candidate is accepted only by passing every
check in order — a filename that is a filename, one extension, an extension the
policy declares, a media type that type declares, a size inside the limit, and,
where a signature is known, leading bytes that match it. An unknown extension,
an unknown media type, or a media type belonging to a different extension is a
**rejection**, and `onUnknown` may only be `"reject"`: a policy that asks for
the opposite is named under `policy-fail-open` and the run stops without
reaching a single decision.

`test/fail-closed.test.mjs` drives a corpus of unknown extensions and media
types through the real decision path and asserts that not one of them is
accepted, so weakening the allow-list check fails a test rather than a
deployment.

## Stored names

An accepted file is stored under a name derived from the bytes
(`upload-<32 hex>.png`) or from a counter (`upload-000007.png`). The extension
always comes from the policy's canonical extension for the accepted type, never
from the upload. Nothing the uploader wrote reaches the stored name — unless
the policy sets `preserveOriginalName`, in which case every stored name it
produces triggers `generated-name-unsafe`. The report does not copy that name.

The check is exact rather than heuristic: the tool computes the safe derivation
independently and compares. A substring test — *does the stored name contain
the uploaded one?* — fires at random against a hex digest, and a check that
cries wolf is a check somebody switches off.

An `expect.generatedName` must be a 1–120-character string that can be compared
faithfully. Controls, default-ignorable code points, and
whitespace that would be collapsed or trimmed are refused at compilation as
`case-invalid`; that case is unevaluated and the run is `incomplete`. A mismatch
is reported without printing either name.

## Limits

`maxCases` (500), `maxCaseBytes` (1 MiB), `maxTotalBytes` (8 MiB),
`maxFileBytes` (5 MiB) and `maxFindings` (1000), each with a hard cap, each
settable on the command line, each reported by name when it fires. Exceeding
one is an `incomplete` run with a finding naming the limit — never a silent
truncation, and never a pass. Both budgets that can stop the walk are
re-checked after the loop as well as inside it.

## Limits and non-goals

What a pass means: every fixture that was built reached the decision it
declared, for the reason it declared. Specifically, this tool **cannot**
conclude any of the following.

- **That the policy is sufficient.** It tests the fixtures you wrote. The
  fixtures you did not write are the ones that matter, and `reason-unexercised`
  names the rejection reasons your suite never reached.
- **That a service enforces the policy.** The policy document is a description.
  Whether the deployed upload path agrees with it is outside anything a local
  fixture run can see. There is no endpoint option and no code path that could
  take one.
- **That an accepted file is safe.** A signature check is a byte comparison at
  fixed offsets. It is not a parser, not a decoder and not a scanner: it says
  the first bytes are consistent with a declared type, and says nothing about
  the rest of the file.
- **That a type without a signature is what it claims.** `"signature": null` is
  an explicit statement that these bytes cannot be checked. `summary.types`
  counts every compiled type and `summary.typesWithoutSignature` counts the
  ones whose bytes cannot be, and every acceptance made under one of them is
  reported as `signature-unverifiable` — an `info` finding naming how many of
  the run's acceptances were reached on a name, a declared media type and a
  size alone. A type nothing reached is counted and not reported, because a
  finding about a claim the run never made is noise. None of this fails the
  run: a null signature is a statement, not a defect.
- **Anything about a decoder, a parser or a resizer.** The fixtures contain
  nothing for one to read. Malformed-image handling, zip-bomb behaviour, EXIF
  and SVG script content are all out of scope by construction — there is no
  content kind that could express them.
- **Anything about storage, permissions or serving.** Where an accepted file
  ends up, who can read it, and what content type it is served with are not
  visible here.

What the tool deliberately does not do: it does not upload, fetch, scan,
fuzz, or produce an exploit of any kind; it does not compile a regular
expression from either input document, because a pattern from a file cannot be
bounded from inside JavaScript; and it never overwrites a file.

It also never writes anywhere but the directory you named. `--out` is refused
outright if it is a symbolic link — `realpath` would hand back whatever tree the
link points at, and every fixture would land there instead — and each fixture
destination inside it is refused if it is a symbolic link, if it resolves
outside `--out`, if it is not a regular file, or if it is one of this run's own
inputs under a second name (compared by device and inode, because a hard link
has no target to resolve and shares no path with the file it is a name for).
The exclusive-create flag stays underneath all of that as the layer that cannot
be argued with: an existing file is never opened for writing. A refused fixture
is an `output-not-written` finding and an `incomplete` run, so the report says
which one was not written and the exit code is never 0.

The report does not copy a case's filename, declared media type, expected
stored name, generated stored name, or accepted filename extension. It reports
the decision, reason, byte count and case pointer; the exact values remain in
the input suite. This also holds when a policy preserves a sanitised uploaded
stem in the generated name. Case ids are likewise kept out of findings:
`/cases/0` points to the first case in the suite as written, even though cases
are evaluated in id order. The raw id still names `<id>.fixture` under `--out`.

`location.file` uses the fixed logical source roles `@policy` and `@suite`,
not the literal `--policy` or `--suite` path. The CLI and API still read the
exact path supplied. Use the role and pointer with the original input files to
find an observation. Unknown document keys are refused at their container
pointer and counted, without copying their names or values.
`test/secrets.test.mjs` measures the report boundary with synthetic canaries.

Every value the tool *refuses* is described (`a string of 40 character(s)`) and
never reproduced, the JSON parser's own message included, since it quotes the
text around the error. If you use `--out`, keep secrets out of case ids because
they become output filenames, even though they are absent from report streams.

## Determinism

Findings sort by `location.file`, `location.pointer`, `ruleId` and then
emission order. Every string comparison is by UTF-16 code unit;
`localeCompare` and `Intl.Collator` appear nowhere in the package. Nothing
reads the clock, the locale or a random source. Two runs over identical inputs
produce byte-identical stdout.

## Development

```sh
npm run check    # lint, test, run the example, and dry-run the package
npm test
npm run test:coverage
```

## License

MIT. See [LICENSE](./LICENSE).
