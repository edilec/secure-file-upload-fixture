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

No release has been published.
