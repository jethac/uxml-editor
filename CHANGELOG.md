# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Source-backed editing core: patch engine, document sessions, transactions and
  undo history, stable locators, UXML structural commands, and USS commands
  with provenance.
- Canvas, hierarchy, palette, inspector, diagnostics, and source panels behind
  one transaction history.
- Browser host (File System Access API, IndexedDB project identity, memory
  fallback) and Tauri desktop host (scoped filesystem, atomic save, watcher,
  recovery).
- GitHub Actions CI covering typecheck, unit tests, Playwright, browser build,
  license allowlist, and Linux/Windows host tests.
- `scripts/check-licenses.mjs` dependency license gate.
- `Toggle`, `TextField`, `IntegerField`, `FloatField`, `DropdownField`,
  `Slider`, `SliderInt`, and `Foldout` are drawn with the child elements and USS
  classes Unity documents for them, so their `label`, `text` and `value`
  captions appear and `.unity-base-field__label`-style selectors
  reach the generated elements. Their structure is documented, not measured
  against a running Unity, and each says so once through a `version-dependent`
  diagnostic; declarations they contribute carry `evidence: 'documented'` in
  style provenance so the inspector can tell them from measured theme values.
- Diagnostics for property names Unity's USS importer drops, in stylesheets
  (reported at the declaration span) and in inline `style` attributes
  (reported against the element). Custom `--name` properties are exempt.

### Changed

- Vendor chunks are split so no production bundle exceeds the size budget.
- The preview engine is vendored source under `vendor/uxml-preview/` at
  `uxml-preview` 0.5.0 (Apache-2.0) instead of an npm dependency, so Unity 6.3
  parity, further controls, and transition playback can be implemented in it.
  Its upstream test suite runs as part of `npm test`, and the adapter is still
  the engine's only import site. See
  [ADR 0002](docs/adr/0002-vendored-preview-engine.md).
- Engine warnings are mapped through an exhaustive table, so the nine warning
  kinds 0.5.0 added — template resolution, override, duplicate-name, and
  package-path warnings — are classified instead of cast, and a new kind fails
  the typecheck.

### Fixed

- Host tests that prove Windows-only conditional replacement are gated to
  Windows; the non-Windows contract is asserted explicitly instead of failing.
- Save writes every dirty document instead of only the entry document, so USS
  edits are no longer reported as an incomplete save and left on disk unchanged.
- A failed save names the documents that stayed unsaved and the underlying
  host error.
- While a draft keeps the preview stale, diagnostics for that file come from
  the draft, so newly typed problems appear and locations match what is on
  screen instead of the last good parse.
