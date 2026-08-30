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
- Diagnostics for property names Unity's USS importer drops, in stylesheets
  (reported at the declaration span) and in inline `style` attributes
  (reported against the element). Custom `--name` properties are exempt.

### Changed

- Vendor chunks are split so no production bundle exceeds the size budget.

### Fixed

- Host tests that prove Windows-only conditional replacement are gated to
  Windows; the non-Windows contract is asserted explicitly instead of failing.
- Save writes every dirty document instead of only the entry document, so USS
  edits are no longer reported as an incomplete save and left on disk unchanged.
- A failed save names the documents that stayed unsaved and the underlying
  host error.
