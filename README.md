# UXML Editor

Standalone visual editor for Unity UI Toolkit UXML and USS. The editor core is
browser-first; Tauri 2 provides a thin Windows desktop host for native
filesystem operations.

Editing is source-backed: every hierarchy, canvas, and inspector action is a
patch against the original UXML/USS bytes, so comments, attribute order, and
user formatting survive a round trip.

## What works

- **Projects** — open a directory through the File System Access API in the
  browser or the native picker on desktop; enumerate, read, and save `.uxml`
  and `.uss` files with revision checks, external-change watching, and crash
  recovery.
- **Canvas** — Yoga-backed preview with selection, drag/resize manipulation,
  and static pseudo-state toggles.
- **Hierarchy** — reparent, reorder, insert, and delete elements from a
  palette of `uxml-preview`'s renderers.
- **Inspector** — provenance-aware attribute and style authoring that shows
  which rule a computed value came from and writes to the matching source.
- **Source** — CodeMirror editing of the same documents, kept in sync with the
  visual views through one transaction/undo history.
- **Diagnostics** — parser and renderer warnings surfaced per document.

## Not implemented

- Animation of any kind. USS transitions are parsed and preserved but never
  played; pseudo-state toggles are static.
- Unity 6.3 features. Rendering comes from the vendored `uxml-preview` 0.5.0
  engine in [`vendor/uxml-preview`](vendor/uxml-preview), which is measured
  against Unity 6000.0.40f1 and has no `filter`, `aspect-ratio`, SVG, 9-slice,
  or text-outline support.
- Controls beyond `VisualElement`, `Label`, `Button`, `Image`, and
  `ScrollView`. Unknown controls stay in the tree, render as fallback boxes,
  and raise a warning.
- Atomic conditional replacement off Windows. The native
  `replaceTextAtomically` returns `unsupported` on other platforms; the browser
  host uses its own revision-checked write path.

## Requirements

- Node.js `>=24.15.0 <25`, with npm
- Rust stable (desktop host)
- Windows: Visual Studio C++ build tools, the Windows SDK, and the WebView2
  runtime
- Linux (host development only): `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
  `libsoup-3.0-dev`, `librsvg2-dev`, `libjavascriptcoregtk-4.1-dev`,
  `pkg-config`

## Commands

```bash
npm ci
npm run dev              # Vite dev server on :1420
npm run typecheck        # tsc --noEmit
npm test                 # Vitest unit and integration suites
npm run test:e2e         # Playwright, against the dev server
npm run test:rust        # cargo test for the desktop host
npm run check:licenses   # dependency license allowlist
npm run build            # typecheck + browser production build
npm run tauri:dev
npm run tauri:build      # Windows installer and portable artifacts
```

CI runs the same commands on Linux and repeats the host tests plus a
`tauri build --no-bundle` on Windows, which is the only platform that exercises
the conditional-replacement implementation.

## Architecture

`src/core` holds the host-agnostic editor: the source patch engine, document
sessions, transactions, stable locators, UXML/USS commands, and the
persistence/recovery layer. `src/features` holds the panels. `src/app` wires a
host implementation (`BrowserHost`, `MemoryHost`, or the Tauri host in
`src-tauri`) into the shell.

The preview engine is vendored source, not an npm dependency:
[`vendor/uxml-preview`](vendor/uxml-preview) holds `uxml-preview` 0.5.0 under
Apache-2.0, with its upstream test suite, its license, and the import recorded
in [`vendor/uxml-preview/PROVENANCE.md`](vendor/uxml-preview/PROVENANCE.md). It
is vendored because Unity 6.3 parity, controls beyond the five renderers, and
transition playback all need engine changes upstream has scoped out. `npm test`
runs the upstream suite, so engine edits still have to satisfy the measurements
they came from.

It is reachable from exactly one file,
`src/core/adapter/UxmlPreviewAdapter.ts`; an import-boundary test enforces that,
that the package is absent from `dependencies`, and that the app's TypeScript
program stays free of Node typings.

Decisions are recorded in [`docs/adr`](docs/adr).

## License

Original code is licensed under Apache-2.0. See [`LICENSE`](LICENSE) and
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
