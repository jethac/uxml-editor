# Task 12 Report: Direct Manipulation, Snapping, Alignment, And Clipboard

## Status

Implemented and verified on base `2b2260c2fbeb740fa344ea34eec57920bb4eeef8`.

## Implementation

- Added guarded public layout commands for move, resize, keyboard nudge, six alignment operations, horizontal and vertical distribution, and source front/back ordering.
- Required an exact computed `position: absolute` for direct position changes and unambiguous pixel geometry where an operation depends on authored `left` or `top`. Refusals return stable diagnostics instead of throwing from gestures.
- Routed persisted style changes through `styleTargetsFor` and the existing `setDeclaration` / `setInlineStyle` commands. A unique winning authored target is retained; otherwise the element's own safe base-state inline target is used.
- Composed sequential shadow-session edits back into exact localized source patches, preserving untouched source islands while retaining transaction normalization.
- Kept multi-property and multi-element gestures as one normalized `EditorTransaction`; added the required read-only `CommandHistory.undoDepth` getter.
- Reused the lossless `moveElement` command for source ordering.
- Added a `ManipulationController` for pointer move/resize gestures, explicit per-gesture coalescing, keyboard nudge, pure edge/center snapping against parent and sibling `PreviewFrame` boxes, and diagnostic-safe command dispatch.
- Added versioned `application/x-uxml-editor-fragment+json` clipboard data, plain exact UXML fragments, namespace and stylesheet metadata, injected ClipboardItem-like read/write integration, structural parse validation, deterministic authored-name collision renaming, paste, and duplicate. Each paste or duplicate is one undoable transaction.
- Integrated direct dragging, a southeast resize handle, snap guides, Shift multi-selection, keyboard nudge, alignment/distribution/order controls, and copy/paste/duplicate into `PreviewCanvas`. Controls use Lucide icons, accessible labels, and the existing workbench canvas in both desktop and compact layouts.
- Preserved Task 11's passive pointer-inert bounds overlay and added a separate interaction layer. Active gestures are cancelled when the authoritative session changes.
- Added a real browser fixture and Playwright coverage that mounts `App`, `EditorStore`, `DocumentSession`, and `UxmlPreviewAdapter`, then verifies nudge, drag, resize, duplicate, source mutations, history depth, and the passive overlay.

## TDD Evidence

Required tests-only focused RED before production files:

```text
npm test -- src/features/canvas/ManipulationController.test.ts src/core/commands/layoutCommands.test.ts
Test Files  2 failed (2)
Tests       no tests
Error: Failed to resolve import "./ManipulationController"
Error: Failed to resolve import "./layoutCommands"
```

This was expected because the semantic guard and controller tests imported the required modules before either production module existed.

Initial focused GREEN after the minimum implementations:

```text
npm test -- src/features/canvas/ManipulationController.test.ts src/core/commands/layoutCommands.test.ts
Test Files  2 passed (2)
Tests       2 passed (2)
```

Clipboard followed the same RED/GREEN sequence: the first focused run failed to resolve `./ClipboardService`; after implementation its focused suite passed `3` tests, and the final expanded suite passes `4`.

Review-driven behavioral RED evidence:

```text
layout command localization: expected 2 patches, received 1
distribution guard: expected success false, received true for a relative-positioned endpoint
session lifecycle: expected old-session left 0, received 20 after switching sessions during a drag
```

The corresponding focused GREEN runs passed after localized sequential patch composition, whole-selection distribution guards, and gesture cancellation on session replacement were added.

Final required focused GREEN:

```text
npm test -- src/features/canvas src/core/commands/layoutCommands.test.ts src/core/commands/ClipboardService.test.ts
Test Files  5 passed (5)
Tests       35 passed (35)
Duration    7.46s
```

## Final Verification

```text
npm test
Test Files  29 passed (29)
Tests       419 passed (419)
Duration    18.39s
```

```text
npm run build
tsc --noEmit && vite build
1841 modules transformed
dist/index.html                   0.44 kB | gzip:   0.28 kB
dist/assets/index-*.css          17.09 kB | gzip:   3.83 kB
dist/assets/index-*.js          337.60 kB | gzip: 100.22 kB
built in 390ms
```

```text
npm run test:e2e
Running 6 tests using 1 worker
6 passed (11.7s)
```

The focused real-browser manipulation spec also passed independently: `1 passed (7.4s)`. `git diff --check` completed with exit `0`; Git printed only line-ending conversion warnings.

## Visual QA

The temporary Vite server was stopped and no screenshot artifacts were retained.

- `1366x768`: the desktop canvas, two compact command rows, interaction handle, snap layer, and lower workbench tools were visible and correctly framed with no overlap or clipping.
- `720x768`: canvas `(0,40) 720x548`; toolbar `(0,70) 720x61.67`; tools `(0,588) 720x180`; resize handle `(118.17,197.83) 11x11`; page width equaled viewport width with no horizontal overflow.
- Browser warning/error console entries: `0`.

## Files Changed

- `src/core/commands/CommandHistory.ts`
- `src/core/commands/ClipboardService.ts`
- `src/core/commands/ClipboardService.test.ts`
- `src/core/commands/clipboardPayload.ts`
- `src/core/commands/layoutCommands.ts`
- `src/core/commands/layoutCommands.test.ts`
- `src/core/commands/layoutStyleWritePlanner.ts`
- `src/core/commands/sequentialPatchComposer.ts`
- `src/features/canvas/CanvasInteractionLayer.tsx`
- `src/features/canvas/ManipulationController.ts`
- `src/features/canvas/ManipulationController.test.ts`
- `src/features/canvas/PreviewCanvas.tsx`
- `src/features/canvas/PreviewCanvas.test.tsx`
- `src/styles/canvas.css`
- `tests/e2e/canvas.manipulation.spec.ts`
- `tests/e2e/fixtures/manipulation.html`
- `tests/e2e/fixtures/manipulation.tsx`
- `.superpowers/sdd/2026-08-15-uxml-editor/task-12-report.md`

## Self-Review And Concerns

- `layoutCommands.ts` remains public command orchestration and semantic guarding. Style-target/provenance planning is isolated in `layoutStyleWritePlanner.ts`, while exact sequential source patch composition is isolated in `sequentialPatchComposer.ts`.
- `ClipboardService.ts` remains structural copy/paste orchestration. MIME validation, version checks, serialization, and the in-memory ClipboardItem-like implementation are isolated in `clipboardPayload.ts`.
- Core code has no host-specific clipboard import; browser clipboard access is injected by `PreviewCanvas` and failures fall back to the service's structured in-memory item.
- Source changes are adapter/command generated, transaction normalized, and covered by preservation, ambiguity, diagnostics, collision, one-undo, and localized-patch assertions.
- Workbench integration is through its existing `PreviewCanvas`; no duplicate workbench command path was introduced.
- The deferred transformed-canvas border/fit issue was not broadened into this task.
- No blocking concerns. Playwright emits the existing `NO_COLOR` / `FORCE_COLOR` warning; all browser tests pass.

## Fix Round 1

### Findings Addressed

- Made pointer-down the sole owner of pointer selection while retaining synthetic/keyboard click selection. A pointer-generated click is ignored, so Shift selection toggles exactly once and drag start remains immediate.
- Added `useCanvasClipboard`, a focused browser/session interaction hook. It binds each operation to its initiating `DocumentSession`, checks current store identity after every awaited stage and immediately before execution, and never publishes stale diagnostics or session syncs.
- Changed paste to read the current injected/browser clipboard first even after a local Copy. A session-bound in-memory item is used only when no port exists or the current port read rejects; a successful current read, including an invalid/non-UXML result, is never overridden.
- Materialized inherited namespace bindings actually required by pasted QNames onto the fragment root through the structural `setAttribute` command. An incompatible destination binding returns the stable `INVALID_CLIPBOARD_FRAGMENT` diagnostic `Namespace binding conflict for xmlns:<prefix>.` before mutation.
- Added exact style-target/value preflight before shadow-session writes. Different values resolving to one authored declaration return `AMBIGUOUS_LAYOUT_WRITE`; identical repeated writes are deduplicated.
- Added real-browser Shift multi-selection plus alignment, Copy/Paste invocation, and committed compact containment/overflow coverage.

### TDD RED Evidence

Production remained unchanged for the initial behavioral checkpoint:

```text
npm test -- src/features/canvas/PreviewCanvas.test.tsx src/core/commands/ClipboardService.test.ts src/core/commands/layoutCommands.test.ts
Test Files  3 failed (3)
Tests       6 failed | 31 passed (37)
```

Relevant failures were:

```text
missing inherited namespace: expected result.ok true, received false
incompatible namespace: expected stable conflict diagnostic, received ok true
shared USS declaration: expected AMBIGUOUS_LAYOUT_WRITE, received ok true
Shift pointer/click sequence: expected selected IDs ["0", "1"], received ["0"]
current clipboard preference: expected ClipboardPort.read 1 time, received 0
clipboard read-failure fallback: expected ClipboardPort.read 1 time, received 0
```

The deferred clipboard test initially completed before nested item decoding resumed. After correcting only its completion barrier and fixture diagnostics, the isolated behavioral RED was:

```text
npm test -- src/features/canvas/PreviewCanvas.test.tsx -t "discards a deferred paste"
Test Files  1 failed (1)
Tests       1 failed | 23 skipped (24)
expected old source to remain unchanged
received an added <ui:Button name="target-copy" text="Choose" />
```

The original Task 12 missing-module RED remains recorded above exactly as observed with zero executed tests; it was not rewritten.

### TDD GREEN Evidence

```text
npm test -- src/features/canvas/PreviewCanvas.test.tsx src/core/commands/ClipboardService.test.ts src/core/commands/layoutCommands.test.ts
Test Files  3 passed (3)
Tests       37 passed (37)
Duration    8.15s
```

Focused browser GREEN:

```text
npx playwright test tests/e2e/canvas.manipulation.spec.ts
Running 3 tests using 1 worker
3 passed (9.5s)
```

### Final Verification

```text
npm test
Test Files  29 passed (29)
Tests       426 passed (426)
Duration    18.74s
```

```text
npm run build
tsc --noEmit && vite build
1842 modules transformed
dist/index.html                   0.44 kB | gzip:   0.28 kB
dist/assets/index-*.css          17.09 kB | gzip:   3.83 kB
dist/assets/index-*.js          340.81 kB | gzip: 100.92 kB
built in 291ms
```

```text
npm run test:e2e
Running 8 tests using 1 worker
8 passed (13.2s)
```

`git diff --check` completed with exit `0`; Git printed only line-ending conversion warnings.

### Visual QA

- `1366x768`: two elements were selected through real canvas pointer interaction; alignment was enabled; canvas `(244,40) 838x544`; toolbar `(244,70) 838x61.67`; every control remained inside the toolbar; page and viewport were both `1366x768`.
- `720x768`: canvas `(0,40) 720x548`; toolbar `(0,70) 720x61.67`; compact tools `(0,588) 720x180`; toolbar scroll/client width was `720/720`; canvas bottom equaled compact-tools top; page and viewport width were both `720`.
- Desktop and compact screenshots were visually inspected for clipping, overlap, nonblank rendering, and control containment. Browser warning/error console entries were `0`; no screenshot artifacts were retained and the temporary server was stopped.

### Fix Files

- `src/core/commands/ClipboardService.ts`
- `src/core/commands/ClipboardService.test.ts`
- `src/core/commands/layoutStyleWritePlanner.ts`
- `src/core/commands/layoutCommands.test.ts`
- `src/features/canvas/useCanvasClipboard.ts`
- `src/features/canvas/PreviewCanvas.tsx`
- `src/features/canvas/PreviewCanvas.test.tsx`
- `tests/e2e/canvas.manipulation.spec.ts`
- `.superpowers/sdd/2026-08-15-uxml-editor/task-12-report.md`

### Self-Review And Concerns

- `ClipboardService` remains host-independent and owns structural payload/transaction semantics. `useCanvasClipboard` alone owns browser-port selection, local fallback lifetime, async session identity, and UI commit/diagnostic callbacks; unrelated rendering was not refactored.
- Namespace additions are part of the same normalized insertion transaction, preserve unrelated source exactly, remain one undo entry, and are added only for inherited bindings used by element or attribute QNames.
- Shared-target detection uses exact path/property/source spans before any shadow mutation. Conflicting writes refuse without touching UXML, USS, or history.
- The resize handle keyboard-activation minor remains deferred. A coherent keyboard resize model needs explicit direction/step semantics and focus behavior; Task 12 continues to provide keyboard nudge for position.
- No blocking concerns. Playwright emits only the existing `NO_COLOR` / `FORCE_COLOR` warning.
