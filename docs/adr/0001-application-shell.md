# ADR 0001: Application Shell

## Decision

Use Tauri 2 as a thin desktop host around a browser-first React editor core.

## Evidence

- Browser production build: `npm run build` exited 0 under Node 25.2.1 and
  Vite 8.2.1. It wrote three files to
  `B:\usagi_dev\uxml-editor\.worktrees\uxml-editor\dist` totaling 193,650
  bytes: `index.html` (446), CSS (1,647), and JavaScript (191,557).
- Yoga WASM in browser: a disposable startup probe loaded
  `uxml-preview@0.4.0`, parsed a fixture containing `UXML`, `VisualElement`,
  `Label`, and `Button`, and rendered 4 mapped elements at 320 by 180. Edge
  loaded `npm run dev -- --port 1420 --host 127.0.0.1` with HTTP 200 and
  reported `data-yoga-status="ready"` and `data-yoga-elements="4"`.
- Yoga WASM in Tauri: `cargo run --manifest-path src-tauri/Cargo.toml` launched
  the Tauri debug executable against the same Vite URL. Direct WebView2 DevTools
  inspection reported the same accessible application, Yoga status `ready`,
  and 4 rendered elements. The user agent identified Edge/WebView2 151; the
  installed runtime is 151.0.4129.78. The disposable probe and debugging flag
  were removed after measurement.
- Tauri no-bundle build: `npx tauri build --no-bundle` exited 0 and wrote
  `B:\usagi_dev\uxml-editor\.worktrees\uxml-editor\src-tauri\target\release\uxml-editor.exe`
  at 8,689,152 bytes. The build used rustc/cargo 1.92.0, the stable
  `x86_64-pc-windows-msvc` toolchain, Visual Studio 2022/2026 C++ build tools,
  and the installed WebView2 runtime.
- Native dialog/filesystem feasibility: Tauri's official dialog API can select
  directories and add selected paths to runtime filesystem scopes. The
  filesystem plugin supports explicit capability scopes, runtime
  `allow_directory`, and watch/unwatch APIs. Security-sensitive atomic replace,
  revision checks, recovery paths, and project-root scoping will be dedicated
  Rust commands behind `HostPort`; Task 1 grants no filesystem or dialog
  permission. See the official [dialog API](https://v2.tauri.app/reference/javascript/dialog/),
  [filesystem plugin](https://v2.tauri.app/plugin/file-system/), and
  [capabilities](https://v2.tauri.app/security/capabilities/) documentation.
- Automated testing: Vitest and Playwright exercise the browser core.
  `tauri-driver` supplies the Windows native-shell smoke path documented by
  Tauri's [WebDriver guide](https://v2.tauri.app/develop/tests/webdriver/).
- Pin provenance: npm resolves `uxml-preview@0.4.0` with integrity
  `sha512-CS26v3f85dQ5ZFbTGnoCyTtpyaD1/emDlg6/7+/G3JeGi82oghiGBxxmh5qSdJDQrzs53lKXqPhEvVc4CDQXSg==`.
  Upstream tag `v0.4.0`, published 2026-08-11, resolves to commit
  `f358e98a805d4ae5a52fc04ff6989b3053354539`.

The first generated no-bundle build failed before compilation because Tauri
rejects the default identifier `com.tauri.dev`. Setting the application-owned
identifier `com.jethac.uxml-editor` fixed the root cause. TypeScript 7.0.2,
Vite 8.2.1, and Vitest 4.1.10 all executed successfully under Node 25.2.1.
`jsdom@30.0.1` emits an engine warning because it supports Node 22.22.2,
24.15.0, or 26 and later, but the focused and full tests execute successfully;
the requested exact pin is retained because no runtime blocker was observed.

## Boundaries

Native filesystem, dialog, watch, recovery-directory, and window lifecycle
operations are available only through HostPort. Editor commands never import
Tauri packages.

The React entry point imports no Tauri package, and the current capability
contains only `core:default`. Native plugins and project-path permissions will
be added only with the HostPort implementation and its contract tests.

## Rejected Alternatives

### Browser/PWA As The Release Host

The executable browser path is retained for core development and automated
testing: it built to 193,650 bytes and ran the Yoga fixture successfully without
Unity or native APIs. It is not the default release host because the required
project watching, revision-aware atomic replacement, recovery directory, and
window close lifecycle cannot be expressed as one dependable cross-browser
contract. A PWA would therefore need a separate native companion and duplicate
the host boundary Tauri already supplies.

### Electron

A disposable Electron 43.4.0 process loaded the same Vite shell and found the
accessible `UXML Editor` application. Its downloaded runtime executable alone
was 225,533,440 bytes, compared with the complete 8,689,152-byte Tauri
no-bundle executable. Electron is rejected because bundling a separate Chromium
and Node runtime adds 216,844,288 bytes before application resources, while the
editor neither needs Node in renderer code nor benefits from a second browser
runtime on the Windows-first target.
