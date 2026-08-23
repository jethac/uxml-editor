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
