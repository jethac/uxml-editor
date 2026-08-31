# ADR 0002: Vendored Preview Engine

## Decision

Redistribute the `uxml-preview` engine as source under `vendor/uxml-preview/`
instead of consuming it from npm, keep `src/core/adapter/UxmlPreviewAdapter.ts`
as its only import site, and run the upstream test suite as part of `npm test`.

`uxml-preview` 0.5.0 (tag `v0.5.0`, commit
`8cbd5cb72d7b5fb0e9ea0e7b32dfdc9e10879e4a`) is the imported revision. The
package name still appears in adapter imports; `vendor/uxml-preview/alias.ts`
maps it to the vendored source for Vite, Vitest and `tsc`, so the boundary is
unchanged by the move.

## Evidence

- The published package is measured against Unity 6000.0.40f1, not 6.3, and
  ships dedicated renderers for five controls (`VisualElement`, `Label`,
  `Button`, `Image`, `ScrollView`). Transitions are parsed and preserved but
  never played, and there is no `@keyframes`, 9-slice, text-outline, SVG, or
  `filter` implementation. Unity 6.3 parity, ARMS-class control coverage, and
  transition playback are therefore engine changes, not adapter changes.
- Upstream is scope-locked against those additions, and `dist` exports no
  per-frame paint or layout entry point a transition engine could drive, so the
  work cannot be done from outside the package.
- The engine is Apache-2.0, which permits redistribution and modification with
  attribution; the upstream `LICENSE`, `THIRD-PARTY-NOTICES.md` and `CHANGELOG.md`
  are vendored alongside the source and the import is recorded in
  `vendor/uxml-preview/PROVENANCE.md`.
- Vendoring 0.5.0 also adopts the template expansion work added since 0.4.0,
  which widened `WarningKind` from 8 to 17 kinds. The adapter now maps every
  kind through an exhaustive `WarningKindMap`, so a kind added by an engine
  change fails the typecheck instead of reaching the UI as an unclassified
  label.
- Verification after the import, on Linux and Node 24.20.0: `npm run typecheck`,
  `npm test` (69 files, 1190 tests — 732 editor, 458 upstream), `npm run
  test:e2e` (35 Playwright tests), `npm run build`, and `npm run
  check:licenses` all pass. The production build still splits the engine into
  its own chunk (173.73 kB, 68.09 kB gzipped).

## Boundaries

The adapter remains the only file allowed to import the engine, and its
import-boundary test additionally asserts that `uxml-preview` is absent from
`dependencies` and the lockfile, that the vendored commit is named in both
`PROVENANCE.md` and `THIRD-PARTY-NOTICES.md`, and that the application's
TypeScript program stays free of Node typings.

Node typings are needed by the vendored engine's Node-only files and its test
suite, so a second project (`tsconfig.node.json`) owns them; the application
program keeps `types` free of `node`, which is what stops browser code relying
on Node globals.

Every file under `vendor/uxml-preview/src` and `tests` is byte-identical to the
imported tag except for the divergences listed in `PROVENANCE.md`, which exist
so the vendored tests resolve their own fixtures rather than the editor's
working directory.

## Rejected Alternatives

### Stay on the published package and work around it

Rejected: the missing capabilities are internal to the engine. Reimplementing
layout or paint outside it would mean a second, divergent renderer — the failure
mode the adapter boundary exists to prevent.

### Git submodule or subtree

Rejected: both keep the engine at a foreign revision boundary, which is the
wrong shape for work that will diverge immediately and continuously from
upstream. A submodule additionally breaks `npm ci` clones that forget
`--recurse-submodules`, and neither makes engine edits reviewable in the pull
request that needs them. `PROVENANCE.md` documents a patch-based re-sync, which
is the only upstream interaction still expected.

### npm workspace package inside the repository

Rejected for now: a workspace adds a build step and a second `package.json`
without changing what the editor consumes, since the adapter imports source
through an alias either way. If the engine is ever published from this
repository, that is the point to reconsider.
