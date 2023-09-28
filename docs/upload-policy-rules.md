# Upload policy rules, fixture shapes and limits

This document is the reference for `secure-file-upload-fixture`: the two input
documents, the order the validator runs its checks in, the closed catalog of
rejection reasons, the rule catalog with the frozen severity of each rule, the
limits, and what the tool deliberately does not do.

The rule table below is asserted against `RULE_SEVERITY` in both directions by
`test/severity-table.test.mjs`. That is a source of truth, not the test: three
declarations that agree with each other survive a coordinated edit of all
three, so `test/severity-exit.test.mjs` drives real inputs through the real
binary and pins the status, the summary counts and the exit code instead.

## The policy document

```json
{
  "schemaVersion": "1",
  "maxBytes": 4096,
  "allowEmpty": false,
  "allowMultipleExtensions": false,
  "onUnknown": "reject",
  "filenamePolicy": {
    "style": "digest",
    "prefix": "upload-",
    "preserveOriginalName": false
  },
  "types": [
    { "extension": "png", "mimeTypes": ["image/png"], "signature": "png", "maxBytes": 2048 },
    { "extension": "txt", "mimeTypes": ["text/csv", "text/plain"], "signature": null }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | `"1"`. Any other value is refused. |
| `maxBytes` | yes | Integer 1 to 1099511627776. The size ceiling for a type that declares none of its own. |
| `allowEmpty` | yes | Stated explicitly. `false` refuses a zero-byte upload. |
| `allowMultipleExtensions` | yes | Stated explicitly. `false` refuses `invoice.pdf.exe`. |
| `onUnknown` | yes | Must be `"reject"`. `"accept"` is recognised so it can be refused by name. |
| `filenamePolicy.style` | yes | `digest` (SHA-256 of the bytes) or `sequence` (a counter). |
| `filenamePolicy.prefix` | yes | 1–16 characters of `[a-z0-9-]`, starting with a letter or digit. |
| `filenamePolicy.preserveOriginalName` | yes | Stated explicitly. `true` appends the sanitised uploaded stem, and every stored name it produces triggers `generated-name-unsafe` without copying the name into the report. |
| `types[].extension` | yes | 1–8 lowercase letters or digits. This is the canonical extension a stored file is named with. |
| `types[].mimeTypes` | yes | 1–20 lowercase `type/subtype` values, without parameters. |
| `types[].signature` | yes | A known signature name, or `null` stated on purpose to record that this type's bytes cannot be checked. A `null` type is counted in `summary.typesWithoutSignature`, and every acceptance made under one raises `signature-unverifiable`. |
| `types[].maxBytes` | no | A per-type ceiling that overrides `maxBytes` in both directions. |

Unknown keys are refused at every level, and the *value* of a refused key is
never read and never reported.

Known signature names: `gif89a`, `jpeg`, `pdf`, `png`, `webp`. A signature is a
byte comparison at fixed offsets, taken from the format's own specification. It
is not a parser.

## The suite document

```json
{
  "schemaVersion": "1",
  "cases": [
    {
      "id": "accept-png-signature",
      "description": "optional, at most 200 characters",
      "filename": "Holiday Photo (final).PNG",
      "declaredMimeType": "image/png",
      "content": { "kind": "signature", "signature": "png", "bytes": 1024 },
      "expect": { "decision": "accept", "generatedName": "upload-c889....png" }
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | 1–64 characters of `[A-Za-z0-9._-]` starting with a letter or digit, no `..`. It names the case in every finding and names the file written under `--out`. |
| `filename` | yes | The declared upload name, up to 1020 characters. It may be empty, over-long or full of control characters: that is what a fixture is for. |
| `declaredMimeType` | yes | The media type the client declared, up to 256 characters. It may be empty. |
| `content` | yes | One of the three inert shapes below. |
| `expect.decision` | yes | `accept` or `reject`. |
| `expect.reason` | for `reject` | One reason from the catalog below. A rejection expectation must name the rule it is testing. |
| `expect.generatedName` | optional, `accept` only | The stored name the policy should produce. |

### The three content shapes, and there is no fourth

| Kind | Bytes produced |
| --- | --- |
| `{"kind": "empty"}` | zero bytes |
| `{"kind": "padding", "byte": 65, "bytes": 64}` | one byte value repeated |
| `{"kind": "signature", "signature": "png", "bytes": 1024}` | the published signature at its declared offsets, then zeros |

There is no way to declare arbitrary bytes — no base64 blob, no inline text, no
path to copy from. A suite file therefore cannot be turned into a carrier for a
payload, an archive, a polyglot or a script. That is a property of the format,
not a promise about how it is used, and `test/inertness.test.mjs` reads the
bytes back from disk to prove it.

## The decision order

The checks run in this order and the **first** one that refuses is the reason
reported. A fixture that trips two rules is reported under the first, so a
fixture asserting an exact reason should trip exactly one.

| # | Reason | Refused when |
| ---: | --- | --- |
| 1 | `filename-empty` | the declared filename is empty |
| 2 | `filename-too-long` | it is longer than 255 characters |
| 3 | `filename-unsafe-characters` | it carries C0, DEL, C1, U+2028/U+2029 or a bidi control |
| 4 | `filename-path-segment` | it contains `/` or `\`, or is `.` or `..` |
| 5 | `filename-reserved` | it has no stem, a leading or trailing dot or space, or a Windows device stem (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) |
| 6 | `extension-missing` | there is no extension to match |
| 7 | `extension-multiple` | there is more than one extension component and the policy allows one |
| 8 | `extension-unknown` | the policy declares no type for the final extension — **the fail-closed default** |
| 9 | `mime-missing` | no media type was declared |
| 10 | `mime-unknown` | the declared media type is not one this policy knows, in any type |
| 11 | `mime-extension-mismatch` | the media type is known but belongs to another extension |
| 12 | `size-empty` | the fixture is zero bytes and the policy refuses empty uploads |
| 13 | `size-over-limit` | the fixture is larger than the per-type or policy ceiling |
| 14 | `content-signature-absent` | the type requires a signature and the fixture is too short to carry it |
| 15 | `content-signature-mismatch` | the leading bytes are not the signature the type requires |

A candidate that reaches the end of the list is accepted. There is no other way
in: no default-accept branch exists, and `test/fail-closed.test.mjs` drives a
corpus of unknown extensions and media types through the real decision path.

A declared media type is trimmed of surrounding whitespace and lowercased
before it is compared, because media types are case-insensitive. Parameters are
not accepted: `image/png; charset=binary` is `mime-unknown`.

## The stored name

For an accepted candidate the tool derives a stored name and compares it with
the name the policy would produce:

- `digest` style: `<prefix><first 32 hex characters of SHA-256(bytes)>.<canonical extension>`
- `sequence` style: `<prefix><counter, six digits>.<canonical extension>`

The counter follows the code-unit order of case ids, so it does not depend on
the order the suite was written in. The extension always comes from the
policy's canonical extension for the accepted type — never from the uploaded
filename.

The two names are computed independently and compared exactly. A substring test
("does the stored name contain the uploaded one?") has a real false-positive
rate against a hex digest, and a check that cries wolf is a check somebody
switches off.

## The rule catalog

`incomplete` marks the rules that make the run unfinished: the tool did not
obtain the evidence it set out to obtain, so the report is never `pass` and the
exit code is 2 whatever the severity says.

| Rule | Severity | Incomplete | Fires when |
| --- | --- | --- | --- |
| `case-content-unsupported` | `error` | yes | a case asks for a signature this build does not know |
| `case-duplicate` | `error` | yes | two cases share an id; the later one is not evaluated |
| `case-invalid` | `error` | yes | a case is malformed, at the pointer named |
| `case-too-large` | `error` | yes | a case declares more bytes than `maxCaseBytes` |
| `expected-accept-but-rejected` | `error` | no | the fixture expected acceptance and was refused |
| `expected-reject-but-accepted` | `error` | no | the fixture expected a refusal and was accepted |
| `generated-name-mismatch` | `error` | no | the stored name is not the one the case declared |
| `generated-name-unsafe` | `error` | no | the stored name keeps text from the upload, or is not a plain single-dot lowercase name ending in the canonical extension |
| `input-not-json` | `error` | yes | an input did not parse; the parser's message is not reproduced |
| `input-not-utf8` | `error` | yes | an input did not decode strictly as UTF-8 |
| `input-too-large` | `error` | yes | an input is larger than `maxFileBytes` |
| `input-unreadable` | `error` | yes | an input is missing, is not a regular file, or could not be read |
| `no-cases-evaluated` | `error` | yes | the walk evaluated nothing, so there is no evidence to be green on |
| `no-rejection-exercised` | `warning` | no | every evaluated case was accepted, so the suite exercised no refusal |
| `output-not-written` | `error` | yes | a fixture destination was refused: it already existed, or it is a symbolic link, a directory, a path resolving outside `--out`, or one of this run's inputs under a second name. Nothing is ever overwritten |
| `path-escapes-root` | `error` | yes | an input resolves outside `--root` |
| `policy-fail-open` | `error` | yes | the policy asks for unknown types to be accepted; the run stops |
| `policy-invalid` | `error` | yes | the policy, or one of its type entries, is malformed |
| `policy-no-types` | `error` | no | the allow-list is empty, so the suite proves nothing about what may be uploaded |
| `reason-mismatch` | `error` | no | the fixture was refused for a different reason than it declared |
| `reason-unexercised` | `info` | no | some rejection reasons were never reached by this suite |
| `signature-unverifiable` | `info` | no | the policy compiles at least one type declaring `"signature": null`, so no fixture of that type had its bytes checked |
| `suite-invalid` | `error` | yes | the suite document is malformed |
| `too-many-cases` | `error` | yes | the walk stopped at `maxCases` |
| `too-many-findings` | `error` | yes | the report was truncated at `maxFindings` |
| `total-bytes-exceeded` | `error` | yes | the walk stopped at `maxTotalBytes` |

## Limits

| Limit | Default | Hard cap | Flag |
| --- | ---: | ---: | --- |
| `maxCaseBytes` | 1048576 | 67108864 | `--max-case-bytes` |
| `maxCases` | 500 | 5000 | `--max-cases` |
| `maxFileBytes` | 5242880 | 67108864 | `--max-file-bytes` |
| `maxFindings` | 1000 | 20000 | `--max-findings` |
| `maxTotalBytes` | 8388608 | 268435456 | `--max-total-bytes` |

A limit may be lowered, never raised past its cap, and an unknown limit name is
a configuration error rather than something ignored. Both budgets that can stop
the walk — `maxCases` and `maxTotalBytes` — are re-checked *after* the loop as
well as inside it, and every conclusion the loop was responsible for is
downgraded when they fire.

`maxFindings` bounds what the run *holds*, not only what it prints. The sink
keeps at most twice the cap and trims back to it by the report's own sort, so
peak memory tracks the cap rather than the number of declared cases; the
truncation notice counts every finding ever produced, and the report is
byte-identical to the one an unbounded sink would have written. `maxCases`
cannot serve as that bound, because the compile walk has to see every declared
case before the cases are ordered by code unit and cut.

## Determinism

- Findings sort by `location.file`, then `location.pointer`, then `ruleId`,
  then the order the finding was emitted in. The last key is an integer, so no
  comparison of untrusted text decides the order of the report.
- All ordering is by UTF-16 code unit. `localeCompare` and `Intl.Collator` are
  absent from the package: both read ICU data that differs between Node builds,
  and both treat punctuation as ignorable, so `a-b` and `a_b` swap places
  depending on where the tool runs.
- Nothing reads the clock, a locale or a random source. The SHA-256 digest used
  for stored names is a content address and depends only on the bytes.
- Running the tool twice over identical inputs produces byte-identical stdout.

## Sanitising

Every untrusted string on its way into output — case ids, filenames, media
types, document keys, pointers, messages, suggestions and evidence — is
stripped of C0 (U+0000–U+001F), DEL (U+007F), C1 (U+0080–U+009F), U+2028,
U+2029 and the bidi controls (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069),
collapsed to one line and bounded.

Two kinds of carrier put a string from a file into the output. Candidate
filenames (including extensions), declared media types, expected stored names
and generated stored names are redacted in findings; the decision and source
pointer are retained.
`test/secrets.test.mjs` plants a canary in every plausible carrier and asserts
the set that comes back, so it fails if the boundary drifts.

| What | Where it appears |
| --- | --- |
| the **id** of a case that was evaluated | every finding about that case, and the `<id>.fixture` file written under `--out` |
| the **name** of a key the tool does not know | `policy-invalid`, `suite-invalid` or `case-invalid`, bounded to 40 characters — at policy, type, `filenamePolicy`, suite, case, `content` and `expect` level |

Each is there because a finding that cannot say which case or which key is a
finding nobody can act on. Everything else is described and never reproduced:
a value the tool *refused* becomes `a string of
40 character(s)` — including the case id in an id refusal, where the pointer
already names the position — an unknown key's **value** is never shown even
where its name is, a description is never shown at all, and the JSON parser's
own message is not passed through because it quotes the text around the error.

Do not put a secret in a case id or key name: these are report identifiers.

## What this tool does not do

- It does not upload anything, open a socket, or talk to a server. There is no
  endpoint option, and there is no code path that could take one.
- It does not produce, contain or execute a payload. Every fixture is zero
  bytes, one repeated byte, or a published header followed by zeros.
- It does not scan for malware, decode an image, parse a container, or inspect
  anything past the leading bytes of a fixture.
- It does not prove a policy is sufficient. A pass means these fixtures reached
  these decisions; the fixtures you did not write are the ones that matter.
- It does not prove a *service* enforces the policy. The policy document here
  is a description; whether the deployed code agrees with it is outside what
  any local fixture run can see.
