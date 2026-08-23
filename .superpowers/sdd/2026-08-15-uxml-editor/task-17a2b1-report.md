# Task 17A2b1 Report: Structural Authoring And History E2E

## Status

PASS (fix round 2/5)

- Original task base: `12c49ad5b985becbfba2a2b7e66c095b5c56d53a`
- Fix-round base: `221758d5f71c60a8e6d29e0eb95070f6c4378ea2`
- Fix-round 2 base: `a714a06291b3bb99b96490b5e11c1edf3e1de8bc`
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

## Fix Round 1 Evidence

### Scope And Architecture

- `ClipboardService.paste` now canonicalizes the resolved parent through
  `session.locatorFor(parent.id)` before planning the insertion and generated
  root selection. A stale locator can therefore resolve a named parent without
  leaking its obsolete child path or ancestor tags into apply, undo, redo, or
  replay.
- The existing visible project-status control now exposes the already-produced
  `FileWorkflowSnapshot.dirtyState` as an `aria-description`; this adds no
  layout, command, bridge, or state mutation path.
- The structural browser workflow has static complete-source oracles for each
  known insert, generic insert, rename, reorder, keyboard reparent, pointer
  reparent, rejected drop, wrap, duplicate, delete, structural undo/redo, and
  source undo/redo boundary. It also asserts visible tree selection, inspector
  context, canvas selected bounds, accessible dirty state, exact save bytes,
  USS preservation, and close/reopen.
- A separate bounded unsupported-fixture workflow creates `acme:Widget` via
  the visible generic palette under `acme:UnknownPanel`, preserving the authored
  namespace and LF fixture bytes through save/reopen.

### Exact RED Evidence

Production behavior: canonical pasted-root selection.

```text
npx vitest run src/core/commands/ClipboardService.test.ts
Test Files  1 failed (1)
Tests       1 failed | 7 passed (8)
Expected resolveElementLocator(selection[0]) to be pasted node id "2".
Received null.
```

Production accessibility state: visible project dirty description.

```text
npx vitest run src/features/workspace/Accessibility.test.tsx --testNamePattern "describes dirty"
Test Files  1 failed (1)
Tests       1 failed | 10 skipped (11)
Expected aria-description="Project has unsaved changes.".
Received null.
```

Browser byte-oracle calibration, using only an independently authored fixture
literal (not CodeMirror or host output):

```text
npx playwright test tests/e2e/editor.spec.ts --grep "preserves an authored"
1 failed
Expected CRLF Unsupported.uxml/USS literals; received the checked-in LF bytes.
```

The final oracle intentionally preserves LF for `Unsupported.uxml` and
`Unsupported.uss`; the menu literals intentionally preserve CRLF.

### GREEN And Final Verification

Runtime: Node `v24.15.0`, npm `11.12.1`.

```text
npx vitest run src/core/commands/ClipboardService.test.ts
Test Files  1 passed (1)
Tests       9 passed (9)

npx vitest run src/features/workspace/Accessibility.test.tsx --testNamePattern "describes dirty"
Test Files  1 passed (1)
Tests       1 passed | 10 skipped (11)

npx vitest run src/core/commands/ClipboardService.test.ts src/features/workspace/Accessibility.test.tsx
Test Files  2 passed (2)
Tests       20 passed (20)

npx playwright test tests/e2e/editor.spec.ts --grep "authors structure|preserves an authored"
2 passed (20.1s)

npx playwright test tests/e2e/editor.spec.ts
12 passed (36.5s)

npm test
Test Files  46 passed (46)
Tests       709 passed (709)
Duration     44.18s

npm run test:e2e
28 passed (57.5s)

npm run build
tsc --noEmit: passed
vite build: passed, 1917 modules transformed
```

### Byte, Boundary, And Layout Audit

- Browser expected sources are static TypeScript literals constructed from the
  checked-in fixture bytes and operation-specific literal changes. The browser
  reads CodeMirror only as the system under test; no expected source is copied
  from CodeMirror or a host snapshot.
- Host observations assert exact saved UXML bytes and revisions. Menu UXML and
  USS retain CRLF; unsupported UXML and USS retain their checked-in LF. The
  unchanged USS host record is compared after each relevant save.
- The fixture bridge remains unchanged and host/scheduler-only. It neither
  exposes nor mutates editor sessions, stores, commands, history, selection,
  or component state.
- No canvas, toolbar, or workbench geometry; CSS; screenshots; visual baselines;
  fixture corpus; dependencies; packaging; licenses; or release files changed.
  The identified three-band layout was neither modified nor endorsed.

### Measured Limitation And Changed Files

- The pre-existing production build warning for a JavaScript chunk above 500 kB
  remains. This task does not alter bundling.
- Managed Playwright runs completed without a persistent-server workaround;
  the managed Vite process exited with its test command.
- Final cleanup audit: `Get-CimInstance Win32_Process` found no remaining
  Playwright, Vite, or Vitest process for this worktree after verification.
- This fix-round commit changes:

```text
.superpowers/sdd/2026-08-15-uxml-editor/task-17a2b1-report.md
src/core/commands/ClipboardService.ts
src/core/commands/ClipboardService.test.ts
src/features/workspace/CommandBar.tsx
src/features/workspace/Accessibility.test.tsx
tests/e2e/editor.spec.ts
```

## Fix Round 2 Evidence

### Scope And Test-First Outcome

- Extended the stale-parent unnamed-root clipboard case through replay into a
  fresh session and verified the replayed unnamed selection locator resolves to
  the pasted node.
- Strengthened the namespace-transform rejection path with an exact immutable
  live-session assertion: snapshot, source, selection, resolved node ids,
  diagnostics, undo depth, undo/redo availability, and replay log remain
  unchanged after the rejection.
- Kept the same CodeMirror instance mounted after source editing and source
  Undo/Redo, then added a visible palette insertion. Its complete CRLF oracle,
  structural Undo/Redo source, hierarchy, selection, inspector, canvas overlay,
  and dirty-state assertions all pass without reopening Source or switching
  files.
- Added those semantic state assertions to the existing structural delete and
  source Undo/Redo boundaries, and dirty-before-save/clean-after-save coverage
  to the authored `acme:Widget` creation workflow.
- No production code changed: the focused ClipboardService tests were green on
  first execution, so no new product defect was proven.

### Exact Focused RED And GREEN Evidence

The new ClipboardService contract extensions were green immediately:

```text
npx vitest run src/core/commands/ClipboardService.test.ts
Test Files  1 passed (1)
Tests       9 passed (9)
```

The first static browser oracle correctly identified preserved whitespace in
the existing visual insertion result:

```text
npx playwright test tests/e2e/editor.spec.ts --grep "authors structure|preserves an authored"
1 failed, 1 passed (22.7s)
Expected post-source source without whitespace-only lines before the appended
Button; received three preserved CRLF whitespace-only lines.
```

The oracle was corrected to those independent literal bytes; no production
behavior changed.

```text
npx playwright test tests/e2e/editor.spec.ts --grep "authors structure|preserves an authored"
2 passed (23.9s)

npx playwright test tests/e2e/editor.spec.ts
12 passed (40.9s)

npm test
Test Files  46 passed (46)
Tests       709 passed (709)
Duration     46.72s

npm run test:e2e
28 passed (1.0m)

npm run build
tsc --noEmit: passed
vite build: passed, 1917 modules transformed
```

### Round 2 Files And Audit

```text
.superpowers/sdd/2026-08-15-uxml-editor/task-17a2b1-report.md
src/core/commands/ClipboardService.test.ts
tests/e2e/editor.spec.ts
```

- The bridge remains unchanged and host/scheduler-only. No component, store,
  session, command, history, or selection capability was exposed through it.
- No layout, CSS, canvas, toolbar, workbench, screenshot, visual baseline,
  fixture, dependency, packaging, license, or release change was made.
- No arbitrary sleeps were added. The remaining measured limitation is the
  pre-existing build chunk-size warning.

### Post-Commit Integrity Commands

Executed after the round-2 commit; each command exited `0` with the literal
empty output shown.

```text
git diff --check 221758d5f71c60a8e6d29e0eb95070f6c4378ea2..HEAD
(no output)

git status --short
(no output)

Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match [regex]::Escape('B:\usagi_dev\uxml-editor\.worktrees\uxml-editor') -and $_.CommandLine -match 'playwright|vite|vitest' } | Select-Object ProcessId, Name, CommandLine | Format-List
(no output)
```

This confirms the requested range is whitespace-clean, the worktree is empty,
and zero matching Playwright, Vite, or Vitest processes remain for this
worktree.
