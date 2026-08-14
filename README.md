# UXML Editor

Standalone visual editor for UXML and USS. The editor core is browser-first,
with Tauri 2 providing a thin Windows desktop host for native operations.

Task 1 establishes only the executable application shell. Editing, project
loading, persistence, and native filesystem permissions are intentionally not
implemented yet.

## Requirements

- Node.js and npm
- Rust stable with the `x86_64-pc-windows-msvc` target
- Visual Studio C++ build tools and the Windows SDK for desktop builds
- WebView2 runtime for desktop execution

The initial executable spike was verified with Node 25.2.1, npm 11.6.2,
rustc/cargo 1.92.0, Visual Studio 2022/2026 build tools, and WebView2
151.0.4129.78.

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
