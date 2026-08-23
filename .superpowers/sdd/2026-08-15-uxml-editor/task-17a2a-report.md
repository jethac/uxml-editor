# Task 17A2a Report: Production-App Harness And File Lifecycle E2E

## Status

PASS

- Base: `e33cb5e462f55d7ec1157a1946506b449a5aa70b`
- Initial implementation: `5c95e1153a47a8d2f4e40aa49b511c242b766137` (`test: add production App file lifecycle E2E`)
- Fix round 1: `6af53e9617f3ba24df1950d61f743f4f543031b8` (`fix: preserve source bytes and await editor teardown`)
- Runtime: Node `v24.15.0`, npm `11.12.1`
- Current scope: source mapping and scheduler-injection production seams, unit/E2E tests, the production-App fixture, and this report. No CSS, layout geometry, screenshot, visual baseline, dependency, license, or notice changes.

## Harness

- Imports the checked-in Task 17A fixture corpus with Vite `?raw` and `?url` imports.
- Constructs a fresh selectable deterministic `MemoryHost`, wraps that exact fallback in a real `BrowserHost` through `createRuntimeEditorStore`, and renders production `App` without injecting a command registry.
- Uses an explicit browser scope without `showDirectoryPicker`. The harness constructs the real `FileWorkflow` from the runtime store's real `BrowserHost`, passes it through `task16FileLifecycle` for explicit disposal ownership, and leaves `App` to construct the production `CommandRegistry`.
- Resets by unmounting, explicitly awaiting real workflow disposal and host/two-paint quiescence, then constructing fresh host/store/workflow/App state. Same-host restart preserves the recovery journal while replacing runtime objects.
- Injects only a deterministic source scheduler through `App`/`Workbench` into the real `SourceEditCoordinator`; default production use retains the timeout scheduler. Scheduler drain and counts prove callback cancellation without elapsed sleeps.
- Limits `window.__task17a2a` to fixture reset/restart/selection, confirmation/failure queues, external host writes/deletes, host time, scheduler drain, settled polling, and immutable host/scheduler observations. It cannot mutate store, session, commands, or component state.

## Initial Red/Green (Historical)

Accepted focused RED before harness implementation:

```text
npx playwright test tests/e2e/editor.spec.ts --grep "opens, closes"
Running 1 test using 1 worker
1 failed
TypeError: Cannot read properties of undefined (reading 'settled')
```

The failure was the missing `window.__task17a2a` harness contract. A prior preflight run exposed and corrected a Playwright test-helper serialization error before accepting this RED.

Focused GREEN after harness implementation:

```text
npx playwright test tests/e2e/editor.spec.ts
7 passed (36.1s)
```

The seven tests cover open/close/reopen, clean Save and Save All, new-project Save and capability transitions, cancelled and confirmed colliding Save As, matching and mismatched Open Recent, clean external watch plus deterministic reload no-op, and changed Save replacement failure plus recovery.

## Initial Final Verification (Historical)

```text
npm test
Test Files  45 passed (45)
Tests       696 passed (696)

npm run test:e2e
23 passed (57.8s)

npm run build
tsc --noEmit: passed
vite build: passed, 1917 modules transformed

git diff --check
passed

git diff --cached --check
passed before implementation commit
```

## Measured Limitations

- CodeMirror presents line separators as LF. The current source mapper converts editor offsets in both directions and maps inserted LF to a deterministic local exact-source separator, so authoritative CRLF/mixed bytes remain exact without whole-document normalization.
- Binary fixture paths use deterministic placeholder host payloads because `ProjectIndex` does not read them. Their real Vite-served URLs are preserved separately in `EDITOR_ASSET_URLS`; visible asset rendering is not claimed.
- Host `settled()` observes host-operation and two-paint quiescence only. Source debounce work is controlled by the fixture scheduler and explicitly drained; no fixed debounce delay remains.
- The production build retains the existing warning that the main minified chunk exceeds 500 kB; this task does not change production bundling.

## Fix Round 1

Fix base: `6d446da731c93d24c6af8c0fb4aae9e1670db973`

### Root Cause And Design

1. `SourcePanel` sent `update.state.doc.toString()` to `SourceEditCoordinator`, so CodeMirror's LF-normalized full document replaced the exact draft. The fix maps each CodeMirror change boundary back into the current exact source, applies changes from the end, and synchronously advances an exact-drafts ref so rapid transactions use the prior transaction's result. Untouched CRLF and mixed separators remain byte-exact; no line-separator facet is set.
2. The harness let `App` own `FileWorkflow`, so unmount started an inaccessible asynchronous disposal and `settled()` compensated with a fixed 260 ms delay. The harness now constructs the real `FileWorkflow` from the runtime store's real `BrowserHost`, injects it through the supported `task16FileLifecycle` port, unmounts, explicitly awaits `workflow.dispose()`, then awaits host/two-paint quiescence. Retired hosts count any later operation.
3. The harness could only reset to a fresh host, so recovery was never decoded by a fresh workflow against the same persisted journal. `restart()` now explicitly tears down the current real workflow and remounts a fresh `BrowserHost`/store/workflow/`App` while preserving the exact `MemoryHost`.

### Tests Added And Tightened

- Added visible `SourcePanel` regressions for localized edits against all-CRLF source, mixed separators, and rapid length-changing transactions.
- At the round-1 commit, the two-reset lifecycle E2E left source debounce callbacks pending, required both workflow teardowns before replacement runtime use, waited beyond the old debounce, and asserted zero retired-host operations. Round 2 supersedes that historical elapsed-time check with deterministic scheduler cancellation/drain evidence.
- Changed the failed-save edit to use visible accessible CodeMirror Find/Replace All controls, producing one localized change instead of replacing the full document.
- Extended failed Save through same-host restart, production Open Project recovery replay, visible recovered source, exact CRLF persistence, revision transition, and recovery clearance.
- Removed the LF-normalizing E2E expectation and added a byte-level assertion rejecting lone LF and lone CR.

### Exact RED Evidence

```text
npx vitest run src/features/source/SourcePanel.test.tsx
Test Files  1 failed (1)
Tests       2 failed | 3 passed (5)
Failures: CRLF and mixed-separator drafts were received with normalized LF.

npx playwright test tests/e2e/editor.spec.ts --grep "second reset"
Running 1 test using 1 worker
1 failed
TypeError: window.__task17a2a.runtimeState is not a function

npx playwright test tests/e2e/editor.spec.ts --grep "replacement failure"
Running 1 test using 1 worker
1 failed
TypeError: window.__task17a2a.restart is not a function

npx vitest run src/features/source/SourcePanel.test.tsx --testNamePattern "rapid localized"
Test Files  1 failed (1)
Tests       1 failed | 5 skipped (6)
Failure: the second transaction mapped against the stale pre-edit CRLF draft.
```

### Exact GREEN And Final Verification

Runtime: Node `v24.15.0`.

```text
npx vitest run src/features/source/SourcePanel.test.tsx
Test Files  1 passed (1)
Tests       6 passed (6)

npx playwright test tests/e2e/editor.spec.ts
8 passed (27.7s)

npm test
Test Files  45 passed (45)
Tests       699 passed (699)

npm run test:e2e
24 passed (52.8s)

npm run build
tsc --noEmit: passed
vite build: passed, 1917 modules transformed

git diff --check
passed
```

The build retains the pre-existing warning for a main minified chunk above 500 kB.

### Self-Review And Scoped Diff Audit

- Changed production behavior only in `SourcePanel` source-text mapping; no canvas, toolbar, workbench geometry, CSS, screenshot, visual baseline, dependency, license, or notice file changed.
- The fixture still uses `createRuntimeEditorStore`, its real `BrowserHost`, production `FileWorkflow`, production command registry, and production `App`/UI. No fake workflow or registry is supplied.
- The bridge remains fixture/host-only: reset/restart, known selections, host failures/confirmations/external changes/time, immutable host snapshots, and teardown observations. It exposes no `DocumentSession`, store dispatch, product command execution, or component-state mutation.
- Exact fixture CRLF bytes survive the localized visible edit, failed replacement, recovery replay, and successful Save; every persisted newline is asserted as CRLF.

## Fix Round 2

Fix base: `6af53e9617f3ba24df1950d61f743f4f543031b8`

### Root Cause And Design

1. CodeMirror normalized inserted line breaks to LF even though round 1 mapped change offsets into the exact source. `SourcePanel` now selects the nearest preceding exact separator at the mapped insertion point, falls forward when no preceding separator exists, defaults to LF for a single-line source, and rewrites only inserted LF. Untouched source is never normalized.
2. Diagnostic spans remained exact-source offsets but were passed directly to CodeMirror. A reverse mapper now converts exact source boundaries to normalized editor offsets. A boundary inside a CRLF pair is unrepresentable and is rejected rather than clamped or shifted; the authoritative diagnostic span remains unchanged.
3. The second-reset E2E inferred callback retirement from a 300 ms sleep. `App` and `Workbench` now accept an optional `SourceEditScheduler` that reaches the real `SourceEditCoordinator`; the fixture supplies a runtime-scoped deterministic scheduler. Production defaults still use the existing timeout scheduler. The bridge can only drain/report fixture scheduler state.
4. Recovery proof checked one substring. The E2E now parses the exact stored journal transaction and after snapshot, compares every visible CodeMirror line with the normalized full expected CRLF source, then saves and verifies exact UXML bytes, unchanged USS, deterministic revision `memory:v1:26`, and journal clearance.

### Tests Added And Tightened

- Added `SourcePanel.test.tsx` regressions for CRLF newline insertion, CRLF multiline paste, deterministic mixed-separator local insertion, diagnostic selection after multiple CRLF separators, and conservative split-CRLF diagnostic handling.
- Replaced `page.waitForTimeout(300)` with scheduler cancellation/drain assertions for both retired runtimes: every queued callback is cancelled, none executes, none remains pending, and retired-host operations remain zero.
- Added exact recovery journal project/path/whole-source assertions and a complete visible CodeMirror document assertion before Save.

### Exact RED Evidence

```text
npx vitest run src/features/source/SourcePanel.test.tsx
Test Files  1 failed (1)
Tests       5 failed | 6 passed (11)
Failures: inserted newline, multiline paste, and mixed-local insertion persisted LF;
          CRLF diagnostic selected `iginal" `; split CRLF selected offset 44.

npx playwright test tests/e2e/editor.spec.ts --grep "a second reset"
Running 1 test using 1 worker
1 failed
TypeError: window.__task17a2a.drainSourceCallbacks is not a function

npx playwright test tests/e2e/editor.spec.ts --grep "replacement failure"
Running 1 test using 1 worker
1 failed
Failure: raw CodeMirror textContent concatenated all visible lines without separators.

npx playwright test tests/e2e/editor.spec.ts --grep "replacement failure"
Running 1 test using 1 worker
1 failed
Failure: per-file `original revision + 2` was 3, but MemoryHost's host-global exact revision was 26.
```

The two recovery REDs tightened test extraction/expectation rather than changing product behavior: visible `.cm-line` content must be joined with LF, and the deterministic host-global revision is `memory:v1:26` after the consumed failed replacement revision.

### Exact GREEN And Final Node 24.15 Matrix

```text
node --version
v24.15.0

npx vitest run src/features/source/SourcePanel.test.tsx
Test Files  1 passed (1)
Tests       11 passed (11)

npx playwright test tests/e2e/editor.spec.ts --grep "a second reset|replacement failure"
2 passed (17.2s)

npx playwright test tests/e2e/editor.spec.ts
8 passed (36.8s)

npm test
Test Files  45 passed (45)
Tests       704 passed (704)

npm run test:e2e
24 passed (1.0m)

npm run build
tsc --noEmit: passed
vite build: passed, 1917 modules transformed

git diff --check
passed
```

### Changed Files

```text
.superpowers/sdd/2026-08-15-uxml-editor/task-17a2a-report.md
src/app/App.tsx
src/features/source/SourcePanel.test.tsx
src/features/source/SourcePanel.tsx
src/features/workspace/Workbench.tsx
tests/e2e/editor.spec.ts
tests/e2e/fixtures/editor.tsx
```

### Self-Review And Scoped Diff Audit

- Source mapping changes are local to `SourcePanel`; CRLF, LF, bare-CR, and mixed untouched text retain exact bytes. Inserted line breaks follow deterministic local source policy, and rapid edits still map against the latest exact draft.
- Scheduler injection is optional and does not alter default production timing. The E2E still runs the production `App`, runtime store/`BrowserHost`, real `FileWorkflow`, real `SourceEditCoordinator`, and visible product commands/edits.
- The fixture bridge exposes scheduler/host controls and immutable observations only. No store dispatch, session replacement, workflow command, or direct editor-state mutation is available.
- No canvas, toolbar, workbench geometry, CSS, screenshot, visual baseline, fixture corpus, dependency, license, or notice file changed. `rg -n "waitForTimeout" tests/e2e src` returns no matches.
