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

## Next Action

Task 2 will introduce the pinned `uxml-preview` adapter and characterization
tests. `DocumentSession` remains the sole source of truth for later editor
state; rendered and component state must stay derived and replaceable.
