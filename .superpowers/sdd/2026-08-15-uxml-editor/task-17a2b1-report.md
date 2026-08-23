# Task 17A2b1 Report: Structural Authoring And History E2E

## Status

IN PROGRESS

- Base: `12c49ad5b985becbfba2a2b7e66c095b5c56d53a`
- Runtime target: Node `v24.15.0`

## Scope And Architecture

- Added production-App Playwright coverage through the real `App`, runtime
  `BrowserHost`, `FileWorkflow`, command registry, source coordinator, renderer,
  and accessible palette/hierarchy/canvas/source controls.
- The fixture bridge remains host/scheduler observation and fixture selection
  only. It does not expose or mutate `EditorStore`, `DocumentSession`, command
  execution, history, selection, or component state.
- The only production correction is in `ClipboardService`: a successful paste
  transaction now selects deterministic locators for its generated fragment
  roots. Undo restores the prior selection and redo restores the pasted roots.
- Deterministic replay is covered by a focused production integration test over
  the same typed insert, source-attribute, and clipboard transactions. No replay
  UI was added.

## RED Evidence

Production behavior added: pasted-node selection metadata.

```text
npx playwright test tests/e2e/editor.spec.ts --grep "copies and pastes a selected subtree"
1 failed
Expected generated `play-button-copy` aria-selected="true"; received "false".

npx vitest run src/core/commands/ClipboardService.test.ts --testNamePattern "selects the generated pasted root"
Test Files  1 failed (1)
Tests       1 failed | 6 skipped (7)
Expected selection ["item-copy"]; received ["parent"].
```

The first post-change unit run found a local duplicate identifier in the new
metadata extraction; it was corrected before the GREEN rerun. It was a compile
error in the newly written implementation, not a second behavior change.

## GREEN And Final Verification

Runtime: Node `v24.15.0`, npm `11.12.1`.

```text
npx vitest run src/core/commands/ClipboardService.test.ts --testNamePattern "selects the generated pasted root"
Test Files  1 passed (1)
Tests       1 passed | 6 skipped (7)

npx playwright test tests/e2e/editor.spec.ts --grep "copies and pastes a selected subtree"
1 passed (16.9s)

npx playwright test tests/e2e/editor.spec.ts --grep "authors structure through palette"
1 passed (17.9s)

npx vitest run src/core/commands/ClipboardService.test.ts src/core/commands/StructuralHistory.integration.test.ts
Test Files  2 passed (2)
Tests       8 passed (8)

npx playwright test tests/e2e/editor.spec.ts --reporter=dot
11 passed (persistent local Vite server; Playwright last-run status passed)

npm test
Test Files  46 passed (46)
Tests       706 passed (706)
Duration     57.79s

npm run test:e2e
27 passed (53.7s)

npm run build
tsc --noEmit: passed
vite build: passed, 1917 modules transformed
```

## Exact Byte Evidence

- The clipboard workflow asserts the complete hard-coded CRLF `Menu.uxml`
  result after Save, including the original XML declaration, single quotes,
  entities, comment bytes, attribute order, and the inserted
  `play-button-copy`; it also asserts the host revision changes and that
  Close/Reopen retains the exact host snapshot.
- The structural workflow captures visible authoritative source before an
  illegal pointer drop into a `Button` and asserts byte equality afterward.
  After the source edit and visual structure changes, it saves, compares all
  visible source text to the host text, asserts every host newline is CRLF, and
  closes/reopens before comparing source again.
- The unavailable clipboard path leaves both visible source and the immutable
  host project snapshot unchanged.

## Measured Limitations

- In this execution environment Playwright's managed Vite server exited after
  the first test during a multi-test run, producing `ERR_CONNECTION_REFUSED`.
  Focused tests passed, and the complete 27-test suite passed with an explicitly
  started Vite server on the same configured `127.0.0.1:4173` endpoint. This is
  an execution-harness limitation; no application behavior was changed for it.
- CodeMirror displays normalized LF text. The existing exact-source mapping is
  exercised through source editing and the persisted host assertion verifies the
  saved authoritative UXML remains CRLF.
- The pre-existing production build warning for a minified JavaScript chunk
  above 500 kB remains; this task does not alter bundling.

## Changed Files

```text
.superpowers/sdd/2026-08-15-uxml-editor/task-17a2b1-report.md
src/core/commands/ClipboardService.ts
src/core/commands/ClipboardService.test.ts
src/core/commands/StructuralHistory.integration.test.ts
tests/e2e/editor.spec.ts
```

## Self-Review

- Bridge-boundary audit: no bridge API changed. The E2E observes fixture host
  bytes/revisions and deterministic scheduler state only; all editing occurs by
  visible production controls.
- No-layout audit: no canvas, toolbar, workbench geometry, CSS, screenshots,
  visual baselines, fixture corpus, dependencies, licenses, packaging, or
  release files changed. The current three-band layout was not altered or
  endorsed.
- No arbitrary waits were added. Browser state is synchronized through visible
  accessibility state, fixture host settling, and deterministic source scheduler
  drain.
