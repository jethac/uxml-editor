# Task 10 Report: Hierarchy, Palette, And Structural Editing UI

## Status

DONE

Base: `819aa988cb3953235b8a3b1038e8705e4a4d38ad`

## Implementation Summary

- Added an accessible authored-element hierarchy with complete unknown-tag visibility, roving tabindex, expand/collapse, locator-backed single/range/multi-selection, duplicate-name diagnostics, drag/drop insertion states, and keyboard reorder/reparent controls.
- Added remove, duplicate, qualified rename, and contiguous wrap actions. Each mutation delegates to the existing structural UXML commands and executes exactly one transaction through `DocumentSession.history`, then synchronizes `EditorStore`.
- Added a searchable adapter-backed element palette plus generic qualified-name creation. Insertions select the new element and choose a selected container, the position after a selected leaf, or the root fallback.
- Extended `UxmlPreviewPort`/`UxmlPreviewAdapter` with supported control names so feature code does not import `uxml-preview`.
- Integrated palette and hierarchy into the left authoring pane in desktop and compact Workbench layouts, with restrained tool styling and Lucide action icons.
- Fixed roving-tabstop recovery when collapsing the branch that contains the active row.
- Fixed compact palette allocation so all supported controls remain full-height without an internal horizontal scrollbar at 720px.

## TDD Evidence

- Inherited RED evidence from the controller: the replacement agent removed partial production files while retaining the comprehensive tests, re-establishing RED. Before Workbench integration the focused suite had 22 tests with 20 passing and two Workbench integration failures because `Search elements` was absent from the left pane in desktop and compact modes.
- First finisher baseline after inherited Workbench/CSS integration: `npm test -- src/features/hierarchy src/features/palette` passed 2 files and 22/22 tests.
- Self-review found that collapsing `Main` while `Play` owned the roving tab stop hid the only `tabindex="0"` row. The new focused test failed with 16/17 passing and `Main` receiving `tabindex="-1"`; the controller independently reproduced the feature-level RED at 22/23.
- The first green attempt exposed that raw DOM `.focus()` did not flush the React state path. The test was corrected to use the real click-selection interaction and assert the precondition. The toggle now promotes the active row and range anchor to the collapsed parent; the hierarchy file then passed 17/17 and the focused suite passed 23/23.
- Bounded visual RED at 720x768 showed fixed 104px compact palette items forcing a scrollbar into the 27px list and clipping controls. After content-width items, evidence still showed `scrollWidth=379` versus `width=338`. The final compact column allocation produced full 25px controls and `scrollWidth=width=398`.

## Verification

- `npm test -- src/features/hierarchy src/features/palette` -> PASS, 2 files, 23/23 tests.
- `npm test` -> PASS, 24 files, 381/381 tests.
- `npm run build` -> PASS, TypeScript no-emit check and Vite production build; 1,816 modules transformed.
- `git diff --check` -> PASS, exit 0. Git emitted only existing LF-to-CRLF working-copy notices.
- Temporary Vite visual-QA server was stopped and `task10-visual.html` was deleted before final checks.

## Visual Evidence

- 1366x768 desktop: page and body measured exactly 1366x768. The left pane was 240x544; palette 240x157.7; hierarchy 240x356.3; search field 228x27. Manual screenshot inspection showed distinct non-overlapping Workbench regions, all palette controls, toolbar, full authored tree including `custom:Widget`/`custom:Part`, and no page overflow.
- 720x768 compact: page and body measured exactly 720x768. Canvas and tools did not overlap; the selected hierarchy pane was 720x147.3. The final palette list was 398x25 with `scrollWidth=398`, all five controls were full-height, both text fields remained usable, and the hierarchy retained a 720x46.7 scroll viewport for its 186px tree content. Manual screenshot inspection found no overlap or page overflow.

## Files Changed

- `src/features/hierarchy/HierarchyPanel.tsx`
- `src/features/hierarchy/HierarchyRow.tsx`
- `src/features/hierarchy/HierarchyPanel.test.tsx`
- `src/features/palette/PalettePanel.tsx`
- `src/features/palette/controlCatalog.ts`
- `src/features/palette/PalettePanel.test.tsx`
- `src/features/workspace/Workbench.tsx`
- `src/styles/workbench.css`
- `src/core/adapter/UxmlPreviewAdapter.ts`
- `src/core/adapter/types.ts`
- `src/core/commands/CommandHistory.test.ts`
- `src/core/documents/DocumentSession.test.ts`
- `src/core/persistence/persistenceTestSupport.ts`
- `.superpowers/sdd/2026-08-15-uxml-editor/task-10-report.md`

## Self-Review

- Verified complete authored tree rendering, unknown-tag preservation, ARIA tree semantics, one visible roving tab stop, expand/collapse, traversal, range/multi-selection, and session/store selection synchronization.
- Verified one-history-entry drag/drop reparent/reorder with before/inside/after insertion state, keyboard up/down/indent/outdent, contiguous multi-moves, undo selection restoration, and non-mutating invalid multi-node moves.
- Verified adapter-backed case-insensitive search, known and generic creation, namespace validation, selected-container/selected-leaf insertion behavior, and selection of inserted controls.
- Verified add/remove/duplicate/rename/wrap behavior, duplicate-name reporting without automatic source rewriting, selection of the parent after delete, and undo restoration.
- Verified root actions are disabled, the root is not draggable, leaf controls reject inside drops, invalid qualified names/namespaces do not reach history, and existing structural commands own source patch construction.
- `HierarchyPanel.tsx` is large but remains one cohesive interaction state machine with presentation delegated to `HierarchyRow` and pure helpers below the component. A late split would add state-boundary risk without removing duplication, so it was not refactored.

## Concerns

- No blocking concerns. The compact Workbench preserves its existing 180px tools geometry, so the hierarchy uses an internal scroll viewport at 720px; the bounded check confirmed it remains operable and does not overlap the palette or page.

## Fix Round 1

### Change Summary

- Rejected adapter-supported palette controls when the insertion destination has no in-scope prefix or default namespace bound to `UnityEngine.UIElements`.
- Removed the arbitrary fallback from the root element prefix, so an unrelated binding such as `custom="urn:custom"` can no longer produce `custom:Button`.
- Resolved namespace declarations along the insertion parent's ancestor path. Known-control resolution now fails inside the existing guarded add path before command construction or `session.history.execute`, while valid prefixed/default UIElements bindings and generic qualified-name creation remain unchanged.

### Covering Test

- `src/features/palette/PalettePanel.test.tsx`: `rejects a supported control when only an unrelated root namespace is in scope` opens `<custom:UXML xmlns:custom="urn:custom" />`, clicks `Add Button`, and requires byte-identical source, no undo entry, and an accessible UIElements namespace error.

### RED/GREEN Evidence

- RED: `npm test -- src/features/palette/PalettePanel.test.tsx` -> exit 1; 1 file failed, 1 test failed and 6 passed. Expected the original custom-root source, but received `<custom:UXML xmlns:custom="urn:custom" ><custom:Button /></custom:UXML>`.
- GREEN: `npm test -- src/features/palette/PalettePanel.test.tsx` -> exit 0; 1 file passed, 7/7 tests passed.
- Feature GREEN: `npm test -- src/features/hierarchy src/features/palette` -> exit 0; 2 files passed, 24/24 tests passed.

### Full Verification

- `npm test` -> exit 0; 24 files passed, 382/382 tests passed.
- `npm run build` -> exit 0; TypeScript no-emit check and Vite production build passed, with 1,816 modules transformed.
- `git diff --check` before commit -> exit 0; Git emitted only LF-to-CRLF working-copy notices for the two edited palette files.

### Concerns

- No blocking concerns. The two deferred review Minors were intentionally left unchanged because the namespace fix only required moving known-control resolution inside the existing catch boundary.
