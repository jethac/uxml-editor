# Task 17A2a Report: Production-App Harness And File Lifecycle E2E

## Status

PASS

- Base: `e33cb5e462f55d7ec1157a1946506b449a5aa70b`
- Implementation: `5c95e1153a47a8d2f4e40aa49b511c242b766137` (`test: add production App file lifecycle E2E`)
- Runtime: Node `v24.15.0`, npm `11.12.1`
- Scope: four test-only files; no production, CSS, layout, visual baseline, dependency, license, or notice changes.

## Harness

- Imports the checked-in Task 17A fixture corpus with Vite `?raw` and `?url` imports.
- Constructs a fresh selectable deterministic `MemoryHost`, wraps that exact fallback in a real `BrowserHost` through `createRuntimeEditorStore`, and renders production `App` with only `store` supplied.
- Uses an explicit browser scope without `showDirectoryPicker`; production `FileWorkflow` and `CommandRegistry` are owned by `App`.
- Resets by unmounting, awaiting host quiescence/disposal work, constructing fresh host/store/App state, and suppressing animation only in the fixture page.
- Limits `window.__task17a2a` to fixture reset/selection, confirmation/failure queues, external host writes/deletes, host time, settled polling, and immutable host observations/snapshots.

## Red/Green

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

## Final Verification

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

- CodeMirror/contenteditable normalizes CRLF to LF when a user performs a visible source edit. Clean Save/Save All and external host reload preserve the authoritative fixture CRLF bytes exactly; the changed-save test asserts the exact LF bytes produced by the visible editor and exact revision transitions.
- Binary fixture paths use deterministic placeholder host payloads because `ProjectIndex` does not read them. Their real Vite-served URLs are preserved separately in `EDITOR_ASSET_URLS`; visible asset rendering is not claimed.
- The settled contract includes the production source editor's measured 250 ms debounce plus host-operation and two-paint quiescence.
- The production build retains the existing warning that the main minified chunk exceeds 500 kB; this task does not change production bundling.

## Fix Round 1

Fix base: `6d446da731c93d24c6af8c0fb4aae9e1670db973`

### Root Cause And Design

1. `SourcePanel` sent `update.state.doc.toString()` to `SourceEditCoordinator`, so CodeMirror's LF-normalized full document replaced the exact draft. The fix maps each CodeMirror change boundary back into the current exact source, applies changes from the end, and synchronously advances an exact-drafts ref so rapid transactions use the prior transaction's result. Untouched CRLF and mixed separators remain byte-exact; no line-separator facet is set.
2. The harness let `App` own `FileWorkflow`, so unmount started an inaccessible asynchronous disposal and `settled()` compensated with a fixed 260 ms delay. The harness now constructs the real `FileWorkflow` from the runtime store's real `BrowserHost`, injects it through the supported `task16FileLifecycle` port, unmounts, explicitly awaits `workflow.dispose()`, then awaits host/two-paint quiescence. Retired hosts count any later operation.
3. The harness could only reset to a fresh host, so recovery was never decoded by a fresh workflow against the same persisted journal. `restart()` now explicitly tears down the current real workflow and remounts a fresh `BrowserHost`/store/workflow/`App` while preserving the exact `MemoryHost`.

### Tests Added And Tightened

- Added visible `SourcePanel` regressions for localized edits against all-CRLF source, mixed separators, and rapid length-changing transactions.
- Added a two-reset lifecycle E2E that leaves source debounce callbacks pending, requires both workflow teardowns to complete before replacement runtimes are used, waits beyond the old debounce, and asserts zero retired-host operations.
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
