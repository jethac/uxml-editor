# Progress

## Current Status

Task 1 is complete: the repository has an executable browser-first React shell,
a thin Tauri 2 host, focused shell coverage, and measured architecture evidence.
No editor behavior, project I/O, or native permissions have been added.

## Verified Evidence

- Focused TDD cycle: `npm test -- src/app/App.test.tsx` first failed because no
  accessible application named `UXML Editor` existed, then passed after the
  minimal command bar and hierarchy/canvas/inspector/diagnostics regions were
  implemented.
- Browser build: `npm run build` exited 0; `dist/` contains 193,650 bytes across
  three files.
- Browser Yoga probe: Edge returned HTTP 200 and rendered 4 mapped elements.
- Tauri Yoga probe: the launched debug executable used WebView2 151 and rendered
  the same 4 mapped elements.
- Desktop build: `npx tauri build --no-bundle` exited 0; the release executable
  is 8,689,152 bytes.
- Alternative spike: Electron 43.4.0 loaded the shell; its runtime executable
  alone is 225,533,440 bytes.
- `uxml-preview` is pinned exactly to 0.4.0. npm integrity is
  `sha512-CS26v3f85dQ5ZFbTGnoCyTtpyaD1/emDlg6/7+/G3JeGi82oghiGBxxmh5qSdJDQrzs53lKXqPhEvVc4CDQXSg==`;
  upstream tag `v0.4.0` resolves to
  `f358e98a805d4ae5a52fc04ff6989b3053354539` (published 2026-08-11).

## Toolchain Note

Node 25.2.1 is outside the declared engine range of `jsdom@30.0.1`, so npm emits
`EBADENGINE`. Vitest and the application build execute successfully, and the
exact requested pin remains in place. Use a supported Node 24 release in CI to
avoid relying on behavior outside jsdom's declared range.

## Task 1 Review Fix Round

- Red: `npm test -- src/config/foundation.test.ts` exited 1 while the focused
  engine assertion expected `>=24.15.0 <25` and the manifest temporarily
  contained `^24.15.0`; the assertion reported the exact mismatch. The
  assertion also retains checks for Vite port 1420 with `strictPort`, explicit
  production and development CSPs, and the non-toolbar static header.
- Green: after restoring the selected `>=24.15.0 <25` Node 24 LTS range in the
  manifest and lockfile, `npm test -- src/config/foundation.test.ts
  src/app/App.test.tsx` exited 0 with 2 test files and 5 tests passing.
- The production CSP allows only self-hosted content and Tauri IPC, Yoga's
  `'wasm-unsafe-eval'`, and preview inline styles. `devCsp` adds only
  `ws://localhost:1420` for Vite HMR; no remote source is permitted.

## Task 2 Adapter Characterization

- Red: `npm test -- src/core/adapter/UxmlPreviewAdapter.test.ts` exited 1
  before implementation because `./UxmlPreviewAdapter` did not exist. The
  Vitest import-analysis error identified the missing module at the test import.
- Green: the same focused command exited 0 with 1 test file and 7 tests after
  the editor-owned adapter was added. The suite uses a fixed 640 by 480 panel
  and a fixed 8-pixels-per-character, 16-pixel-high text measurement for
  repeatable Yoga rendering.
- The adapter owns the opaque parsed model in module-private `WeakMap`s. Its
  public contract exposes only editor node IDs, source spans, diagnostics,
  render frames, and style explanation candidates/origins.
- `parseProject` resolves exact input stylesheet buffers before consulting the
  host resolver. It records the returned canonical paths in parsed-sheet order;
  imported stylesheet buffers remain authoritative during no-op serialization
  because upstream `serialize` returns only one USS source.
- A shared promise loads Yoga once. A later render through the same adapter
  disposes the previous upstream result, and editor frame disposal is
  idempotent.
- The dependency characterization asserts `uxml-preview@0.4.0`, lock integrity
  `sha512-CS26v3f85dQ5ZFbTGnoCyTtpyaD1/emDlg6/7+/G3JeGi82oghiGBxxmh5qSdJDQrzs53lKXqPhEvVc4CDQXSg==`,
  and upstream tag commit `f358e98a805d4ae5a52fc04ff6989b3053354539`.
  `THIRD-PARTY-NOTICES.md` also carries Apache-2.0 attribution for
  `uxml-preview` and the MIT Meta notice for bundled `yoga-layout@3.2.1`
  (integrity
  `sha512-0LPOt3AxKqMdFBZA3HBAt/t/8vIKq7VaQYbuA8WxCgung+p9TVyKRYdpvCb80HcdTN2NkbIKbhNwKUfm3tQywQ==`).
- The adapter test uses Node filesystem APIs to scan the TypeScript import
  boundary. `@types/node@24.13.3` is therefore a pinned development-only
  declaration dependency and `tsconfig.json` includes the `node` type library;
  the browser runtime dependency graph is unchanged.
- Final verification: `npm test` exited 0 with 3 test files and 12 tests
  passing. `npm run build` exited 0 after `tsc --noEmit`; Vite emitted the
  browser bundle. The final import scan found no `uxml-preview` reference
  outside `src/core/adapter`.

## Next Action

Task 3 can add source patches and reparse the authoritative buffers after each
transaction. `DocumentSession` remains the sole source of truth for later
editor state; rendered and component state must stay derived and replaceable.

## Task 2 Fix Round 1

- Red: `npm test -- src/core/adapter/UxmlPreviewAdapter.test.ts` first exited 1
  because the prior expectation treated a nested relative import as a direct
  input-map lookup. A second focused red run caught the import-boundary scan's
  overly broad multiline regex; it did not recognize the adapter's multiline
  static import after self-scan false positives were removed.
- Green: the focused command exited 0 with 1 test file and 11 tests. Nested
  relative imports now always use their parent resolver context; direct and
  root-fixed input-map sources retain exact canonical buffers for fresh
  serialization maps. Tests cover two same-named nested imports resolving to
  separate paths, root-fixed/duplicate resolution, unresolved provenance,
  render supersession, computed style explanations, and unconditional reverse
  lookup assertions.
- Browser-only test inputs use Vite `?raw` fixture imports and
  `import.meta.glob` raw module sources. The statement-bounded scan covers
  side-effect, static `from`, dynamic, and re-export imports; `@types/node` is
  absent from both manifest dependency sections and the lockfile, and
  `tsconfig.json` no longer enables Node globals.
- Final verification: `npm test` exited 0 with 3 test files and 16 tests;
  `npm run build` exited 0 after `tsc --noEmit` and Vite bundling. The final
  production source scan found `uxml-preview` only in
  `src/core/adapter/UxmlPreviewAdapter.ts`.

## Task 2 Fix Round 2

- Red: the isolated supersession command exited 1 because its gated
  `loadLayoutEngine` mock resolved without invoking the real Yoga loader, so
  the latest render rejected. The import-boundary red run also exited 1 because
  the regex did not recognize a semicolon-free multiline static import.
- Green: the supersession mock now waits for its gate and calls the real loader;
  the first request rejects with `RenderSupersededError`, the latest frame is
  live, and its disposal remains idempotent. The source guard uses
  `@babel/parser@8.0.4` as an exact MIT development-only dependency and Vite
  raw-globs every requested TS/JS extension. Its structured AST detects static,
  re-export, literal dynamic, import-attribute, and TypeScript external-module
  imports while ignoring comments, strings, and templates.
- Conversion of diagnostics plus inline/rule style origins now omits `source`
  when no editor span can be mapped. Focused assertions verify the field is
  absent rather than present with `undefined`.
