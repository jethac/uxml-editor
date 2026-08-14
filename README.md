# UXML Editor

Standalone visual editor for UXML and USS. The editor core is browser-first,
with Tauri 2 providing a thin Windows desktop host for native operations.

Task 1 establishes only the executable application shell. Editing, project
loading, persistence, and native filesystem permissions are intentionally not
implemented yet.

## Requirements

- Node.js 24.15.0 or a newer 24.x release, with npm
- Rust stable with the `x86_64-pc-windows-msvc` target
- Visual Studio C++ build tools and the Windows SDK for desktop builds
- WebView2 runtime for desktop execution

The supported Node range is `>=24.15.0 <25`, the intersection supported by all
pinned packages. Use the current Node 24 LTS release for development and CI.
The initial executable spike was also measured under unsupported Node 25.2.1
with npm 11.6.2; rustc/cargo 1.92.0, Visual Studio 2022/2026 build tools, and
WebView2 151.0.4129.78 supplied the native toolchain.

## Commands

```powershell
npm install
npm run dev
npm test
npm run build
npm run tauri:dev
npm run tauri:build
```

Architecture evidence and the shell decision are recorded in
[`docs/adr/0001-application-shell.md`](docs/adr/0001-application-shell.md).

## License

Original code is licensed under Apache-2.0. See [`LICENSE`](LICENSE).
