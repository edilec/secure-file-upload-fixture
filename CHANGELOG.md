# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Fixed

- Findings now redact accepted and rejected candidate filenames and
  extensions, declared media types, expected stored names, and generated stored
  names. Previously those values could carry private input into JSON or the
  human summary; decision reasons, severity and exit outcomes are unchanged.
- Findings now use source ordinals for case pointers and fixed `@policy` /
  `@suite` logical source roles. Previously a valid private-shaped case id or
  custom input basename could leak into JSON or stderr. Raw ids still control
  evaluation order and `--out` filenames; raw input paths still control reads.
- Unknown policy and suite key names are now counted at the containing source
  pointer rather than copied into a finding. Unknown keys still invalidate the
  same input, with the same incomplete outcome.
- Stored-name expectations that collapse to different display text are now
  refused as incomplete `case-invalid` evidence before comparison. A trailing
  control used to raise `generated-name-mismatch` while printing identical
  expected and produced names. Valid expectations and visible mismatches keep
  their prior behavior.
- `--out` was resolved with `realpath`, so a symbolic link AT `--out` put every
  fixture in whatever tree the link pointed at: measured, nineteen fixtures
  written into a directory outside the tree the caller named, at exit 0 with
  status `pass`, while the README promised that nothing outside that directory
  is touched. `--out` is now refused on sight when it is a link, before it is
  resolved, as a configuration error with an empty stdout.
- A symbolic link at a *fixture* destination was refused, but by accident and
  for the wrong reason: the exclusive-create flag saw it as an existing file
  and the finding said "already exists in the output directory". Nothing was
  destroyed, and nothing said a link was involved. Each destination now goes
  through `assertWritableDestination` before the write, so a link, a directory,
  a path resolving outside `--out` and a hard link to one of this run's inputs
  are each refused deliberately and named accurately. The exclusive-create flag
  stays underneath as the layer that cannot be argued with.

### Added

- `assertWritableDestination` and `DestinationError`, exported for a caller
  writing its own destination logic. `test/destination.test.mjs` pins one case
  per hole and one per allowed shape.

- a versioned upload policy document covering size ceilings, an extension
  allow-list, declared media types per extension, published magic signatures,
  empty and multiple-extension handling, and the stored-name scheme;
- a versioned fixture suite document whose every case is inert by construction
  — zero bytes, one repeated byte, or a published signature followed by zeros —
  with no way to declare arbitrary bytes;
- `runFixtureSuite`, reporting outcome disagreements, rejection-reason drift,
  unsafe and unexpected stored names, malformed inputs, fail-open policies,
  empty allow-lists and unexercised rejection reasons;
- a fail-closed validator with a fixed check order and a closed catalog of
  fifteen rejection reasons, each reachable and each named by the fixture that
  exercises it;
- optional materialisation with `--out`, which writes one inert file per
  evaluated case, never overwrites, and refuses a destination that is one of
  the run's own inputs by device and inode;
- explicit limits on cases, bytes per case, bytes per run, input size and
  findings, each enforced, each reported by name, and both walk budgets
  re-checked after the walk as well as inside it;
- a CLI with `--json`, `--out` and exit codes 0 / 1 / 2;
- runnable clean and broken examples, the clean one exercising every rejection
  reason in the catalog;
- the rule catalog, decision order, fixture shapes and limits in
  `docs/upload-policy-rules.md`.

### Fixed

- `summary.typesWithoutSignature` and the new `signature-unverifiable` rule now
  account for types declaring `"signature": null`. README claimed the report
  counted them and nothing did: a run whose every type was unverifiable accepted
  a fixture with executable leading bytes under a `.txt` name, reported `pass`
  at exit 0, and looked exactly like a run where every type was byte-checked.
- The finding sink is bounded by `maxFindings` rather than by the number of
  declared cases. A 16 MiB suite of malformed cases held 806 MB to produce a
  report of 1000 findings; it now holds 348 MB and writes byte-identical
  output.

### Documented

- `test/secrets.test.mjs` measures report and output-file name carriers
  separately with synthetic canaries.
- `--help` and `--version` are stated to sit outside the exit-code table: both
  exit 0 with text that is not the report.

No release has been published.
