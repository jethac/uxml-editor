# Contributing

## Setup

```bash
npm ci
npx playwright install --with-deps chromium
```

The desktop host additionally needs Rust stable. On Linux install
`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`,
`libjavascriptcoregtk-4.1-dev`, and `pkg-config`.

## Before pushing

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run check:licenses
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run test:rust
```

CI runs all of these on Linux and repeats the Rust tests plus
`tauri build --no-bundle` on Windows.

## Rules

- **Write the test first.** Expected values come from Unity documentation,
  Unity dumps, or the reference implementation — never from the output of the
  code being written.
- **Source fidelity is non-negotiable.** Edits are patches against the original
  bytes. Comments, attribute order, and formatting must survive a round trip.
- **Never reimplement layout.** Yoga owns it, because Unity UI Toolkit uses
  Yoga.
- **USS is not CSS.** `flex-direction` defaults to `column`, the box model is
  always border-box, there is no `z-index`, and there are no `@keyframes`.
- **Unsupported input warns, it does not throw.** Unknown controls stay in the
  tree and render as fallback boxes.
- **`uxml-preview` is imported by `src/core/adapter/UxmlPreviewAdapter.ts` and
  nothing else.** An import-boundary test enforces this.
- **The engine is vendored source, not a dependency.** It lives in
  `vendor/uxml-preview/` under Apache-2.0. Edit it there when a fix belongs in
  the engine, keep the upstream suite in `vendor/uxml-preview/tests/` green, and
  record every divergence from the imported tag under "Local changes" in
  `vendor/uxml-preview/PROVENANCE.md` so a re-sync can replay it. Node typings
  for its Node-only files belong to `tsconfig.node.json`; the application
  program must stay free of them.
- **Do not conflate coverage, accuracy, and control range** in any claim about
  Unity fidelity, and mark values that were read from documentation rather than
  measured.

## Platform behavior

Conditional replacement is implemented only on Windows. Tests that prove that
contract are gated with `#[cfg(windows)]`; the non-Windows counterparts assert
that the operation refuses with `unsupported` and leaves the file untouched. A
green Linux run is not evidence for Windows replacement semantics.
