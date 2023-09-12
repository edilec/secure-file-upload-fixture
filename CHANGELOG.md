# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

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

- All five untrusted strings that reach the output are named — filename,
  declared media type, case id, `expect.generatedName` and an unknown key's
  name — and `test/secrets.test.mjs` measures the list rather than restating
  it. Previously two of the five were documented.
- `--help` and `--version` are stated to sit outside the exit-code table: both
  exit 0 with text that is not the report.

No release has been published.
