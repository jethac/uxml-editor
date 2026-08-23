# Task 17A2b2 Report: Canvas And Inspector Authoring E2E

## Status

PASS

- Base: `af67eb6f7d63a9a42ea72d71a0639f6ebebcccc3`
- Runtime: Node `v24.15.0` through `C:\nvm4w\nodejs\node.exe`
- Package manager: npm `11.12.1`

## Implementation

- Added production-App Playwright coverage to `tests/e2e/editor.spec.ts` for:
  - refusing pointer resize on a non-absolute selection without changing bytes;
  - a snapped pointer move and pointer resize, each with one visible Undo/Redo boundary, followed by Save/Close/Reopen exact-byte checks;
  - normal and Shift-accelerated keyboard nudge plus a three-element distribution with selection and history assertions;
  - pan, zoom, fit, actual size, device preset, orientation, custom dimensions, safe area, and pseudo state without authoring mutations;
  - computed winning origin, existing USS, inline, and new-rule inspector destinations, including numeric-unit validation, color, box-model, and alignment edits;
  - asset picker plus invalid asset input, text, checkbox, enum, unknown attribute, class add/rename/reorder/remove, mixed multi-selection, Save/Close/Reopen, and persisted visible values;
  - visible source declaration add/remove/reorder while retaining the nested stylesheet import and untouched component stylesheet.
- Added focused unit coverage first for the resize eligibility rule.
- Production change: `ManipulationController.startResize` now uses the same absolute-layout guard as move gestures. It refuses a non-absolute selection before opening a resize gesture or creating a transaction.

## RED Evidence

Playwright was written first and exposed the missing production resize guard:

```text
& 'C:\nvm4w\nodejs\node.exe' .\node_modules\@playwright\test\cli.js test tests/e2e/editor.spec.ts --grep "refuses a canvas resize"

Running 1 test using 1 worker
1 failed
Expected .canvas-interaction-status to contain:
"Free movement requires computed position to be exactly absolute."
Received: element(s) not found.
```

The focused unit regression was then added before the implementation change:

```text
& 'C:\nvm4w\nodejs\node.exe' .\node_modules\vitest\vitest.mjs run src/features/canvas/ManipulationController.test.ts --testNamePattern "refuses a resize"

Test Files  1 failed (1)
Tests       1 failed | 2 skipped (3)
Expected { ok: false, diagnostic: ... }
Received { ok: true }
```

Static E2E oracle calibration also exposed renderer-constrained values before the literals were finalized: a 2px drag snaps to `left: 45px`, resize starts from the rendered `180px` minimum width and writes `192px`, and distribution writes `left: 138.5px`. These were independent expected literals derived from the fixture plus the observed production geometry; no product behavior changed for those calibrations.

## GREEN Evidence

```text
& 'C:\nvm4w\nodejs\node.exe' .\node_modules\vitest\vitest.mjs run src/features/canvas/ManipulationController.test.ts --testNamePattern "refuses a resize"
Test Files  1 passed (1)
Tests       1 passed | 2 skipped (3)

& 'C:\nvm4w\nodejs\node.exe' .\node_modules\@playwright\test\cli.js test tests/e2e/editor.spec.ts --grep "refuses a canvas resize|authors one snapped|nudges with normal|changes canvas viewport|authors inspector values|authors typed inspector|adds, removes"
7 passed (38.0s)

& 'C:\nvm4w\nodejs\node.exe' .\node_modules\@playwright\test\cli.js test tests/e2e/editor.spec.ts --reporter=dot
19 passed (1.1m)

& 'C:\nvm4w\nodejs\node.exe' 'C:\nvm4w\nodejs\node_modules\npm\bin\npm-cli.js' test
Test Files  46 passed (46)
Tests       710 passed (710)
Duration     53.72s

& 'C:\nvm4w\nodejs\node.exe' .\node_modules\@playwright\test\cli.js test
35 passed (1.5m)

& 'C:\nvm4w\nodejs\node.exe' 'C:\nvm4w\nodejs\node_modules\npm\bin\npm-cli.js' run build
tsc --noEmit: passed
vite build: passed, 1917 modules transformed
```

The build retains the pre-existing warning for a minified JavaScript chunk larger than 500 kB.

## Exact-Byte Coverage

- Every browser expected source is a static literal or a deterministic transformation of a static fixture literal. No expected text is copied from the host snapshot or CodeMirror output.
- The pointer, nudge, distribution, inspector destination, attributes/classes, and source-declaration workflows compare complete localized UXML or USS text after every meaningful operation and at Undo/Redo boundaries.
- Save/Close/Reopen compares the complete persisted host snapshot after both representative canvas and inspector workflows. Menu sources retain CRLF; asset and nested-style fixture sources retain LF.
- The inspector destination workflow preserves the complete comment-bearing Menu stylesheet. The nested declaration workflow preserves its import and untouched imported stylesheet exactly.

## Files Changed

```text
.superpowers/sdd/2026-08-15-uxml-editor/task-17a2b2-report.md
src/features/canvas/ManipulationController.test.ts
src/features/canvas/ManipulationController.ts
tests/e2e/editor.spec.ts
```

## Limitations And Concerns

- The Inspector has no discrete production controls for per-declaration remove/reorder. Those operations are exercised through the visible production Source editor, which is the implemented authoring surface.
- The pre-existing production build chunk-size warning remains.
- No other concerns found.

## Self-Review

- Scope: only the resize eligibility guard, its unit test, production-App E2E coverage, and this report changed.
- Bridge boundary: unchanged. Tests use it only for fixture selection, deterministic settling, and host byte/revision observation; no bridge command dispatch or editor-state mutation was added.
- Exact-oracle independence: expected UXML/USS text is static and does not derive from browser or host output.
- Transaction/history: pointer move, pointer resize, nudge, distribution, compatible multi-edit, and inspector edits are each exercised through visible production controls with undo/redo source assertions.
- Layout boundary: no CSS, workbench/canvas geometry, toolbar composition, title bands, screenshots, or visual baselines changed or were approved.
- Policy audit: no dependency, packaging, license, fixture-corpus, network, telemetry, upload, or arbitrary-wait change. No test backdoor was introduced.

## Post-Commit Integrity Checks

The following commands were run after the final commit, with the literal empty output shown:

```text
git diff --check af67eb6f7d63a9a42ea72d71a0639f6ebebcccc3..HEAD
(no output)

git status --short
(no output)

Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match [regex]::Escape('B:\usagi_dev\uxml-editor\.worktrees\uxml-editor') -and $_.CommandLine -match 'playwright|vite|vitest' } | Select-Object ProcessId,Name,CommandLine | Format-List
(no output)
```
