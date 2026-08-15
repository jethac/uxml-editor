# Task 11 Report: Preview Canvas, Selection, Viewports, And Pseudo States

## Status

Implemented and verified on base `249301234f62068759af9674ce599b889fccbcf1`.

## Implementation

- Added an immutable `ViewportModel` implementing `screen = panel * zoom + pan`, exact inverse mapping, cursor-anchored zoom, centered fit, panning, and `0.25..4` clamping.
- Added `PreviewCanvas`, rendering only through `DocumentSession.adapter` / `UxmlPreviewPort` with injectable browser-safe asset and text services.
- Added generation-guarded preview frame ownership. The current frame is disposed before replacement; stale and unmounted async results are disposed without publishing DOM, diagnostics, or errors.
- Keyed rerenders to authoritative `session.document` identity so session commits replace derived preview state even when the session object is unchanged.
- Combined session parse diagnostics with only the current frame's render diagnostics through idempotent store dispatches.
- Added generated-descendant click mapping by walking renderer ancestors through `frame.nodeForElement`, then storing a session locator selection and dispatching `session/sync`.
- Added an independent pointer-events-none overlay driven by frame boxes for hover, selected, selected-parent, safe-area bounds, and four selection handles.
- Kept fixed renderer width/height separate from the outer pan/zoom transform.
- Added presets, orientation swap, positive finite custom dimensions, fit, actual size, wheel cursor zoom, pan-tool and middle-button panning, safe area, and the seven explicit per-element states.
- Passed states through selector-keyed `PreviewRenderOptions.states`; unique authored names use the narrow `#name` selector and controls remain disabled where no unique safe selector exists.
- Replaced the Workbench placeholder in desktop and compact layouts and added dense neutral canvas styling.

## TDD Evidence

Initial focused RED:

```text
npm test -- src/features/canvas/ViewportModel.test.ts
Test Files  1 failed (1)
Tests       no tests
Error: Failed to resolve import "./ViewportModel"
```

Required canvas RED before production files:

```text
npm test -- src/features/canvas
Test Files  2 failed (2)
Tests       no tests
Error: Failed to resolve import "./PreviewCanvas"
Error: Failed to resolve import "./ViewportModel"
```

Authoritative-document regression RED/GREEN:

```text
RED: expected adapter.renderOptions length 2, received 1
GREEN: Test Files 1 passed (1); Tests 1 passed | 10 skipped (11)
```

Final focused GREEN:

```text
npm test -- src/features/canvas
Test Files  2 passed (2)
Tests       14 passed (14)
Duration    5.56s
```

## Final Verification

```text
npm test
Test Files  26 passed (26)
Tests       398 passed (398)
Duration    21.51s
```

```text
npm run build
tsc --noEmit && vite build
1820 modules transformed
dist/index.html                   0.44 kB | gzip:  0.28 kB
dist/assets/index-DbxX8unv.css   15.97 kB | gzip:  3.61 kB
dist/assets/index-BrOy85y0.js   260.91 kB | gzip: 80.29 kB
built in 354ms
Exit 0
```

```text
npm run test:e2e
Running 5 tests using 1 worker
5 passed (13.6s)
```

`git diff --check` completed with exit `0` before report creation.

## Visual QA

Temporary Playwright geometry/screenshot harness was removed and its Vite server was stopped.

- `1366x768`: desktop; document `1366x768` client/scroll; canvas `(244,40) 838x544`; toolbar `(244,70) 838x62`; field `(244,132) 838x452`; no direct-control overlaps; every control inside toolbar; screenshot 23,143 bytes and visually nonblank.
- `720x768`: compact; document `720x768` client/scroll; canvas `(0,40) 720x548`; toolbar `(0,70) 720x62`; field `(0,132) 720x456`; no direct-control overlaps; every control inside toolbar; screenshot 17,457 bytes and visually nonblank.
- Both viewports had toolbar bottom equal to field top and no page overflow.

## Files

- `src/features/canvas/ViewportModel.ts`
- `src/features/canvas/ViewportModel.test.ts`
- `src/features/canvas/PreviewCanvas.tsx`
- `src/features/canvas/PreviewCanvas.test.tsx`
- `src/features/canvas/CanvasOverlay.tsx`
- `src/styles/canvas.css`
- `src/features/workspace/Workbench.tsx`
- `src/features/workspace/Workbench.test.tsx`
- `.superpowers/sdd/2026-08-15-uxml-editor/task-11-report.md`

## Self-Review And Concerns

- Feature code does not import `uxml-preview`; the existing adapter-boundary test remains green.
- Frame disposal, stale completion, diagnostics replacement, generated descendants, overlay geometry, gestures, controls, all seven states, errors, empty state, and both Workbench layouts have direct tests.
- Selector-keyed adapter state cannot safely target every unnamed or duplicate-named element. Such selections intentionally disable pseudo-state controls instead of applying a broader selector to unrelated nodes.
- Playwright emits the existing `NO_COLOR` / `FORCE_COLOR` warning; all five tests pass.
