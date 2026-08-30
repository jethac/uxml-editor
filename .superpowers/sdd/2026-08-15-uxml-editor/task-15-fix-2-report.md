# Task 15 Fix Round 2 Report

## Status

All 2 Critical and 5 numbered Important findings accepted from `task-15-fix-1-review.md` are addressed on `agent/uxml-editor` from clean head `1537863`. Exact ID/DTO validation, one production `TauriHost`, browser fallback, narrow capabilities, and pinned dependencies remain intact. No Task 16 FileWorkflow or CommandRegistry was added, and nothing was pushed.

The accepted review artifact is included unchanged. Its SHA-256 before and after this round is `149098D60B8CBA93453A89760EFD71202845265665B358666530F24AFF2B4277`.

## Finding Resolution

### Critical 1: capability-first selected-root acquisition

`ScopedProjects::prepare_selected` now opens `cap_std::fs::Dir` before canonical display/project-ID work. Directory type is read from `Dir::dir_metadata`. The later ambient canonical result is accepted only when it identifies the opened object: Unix compares device/inode; Windows compares the canonical path to `GetFinalPathNameByHandleW` for the acquired directory handle. Ambient work can reject a changed selection, but cannot redirect the stored authority.

The deterministic selection-time swap fixture runs after capability acquisition. Windows prevents the rename while the directory handle is held; on platforms that admit the swap, identity mismatch fails selection. A grant can never read the replacement directory. This is distinct from the retained post-open child-component swap coverage.

### Critical 2: final-interval external writer preservation

Replacement remains entirely capability-relative and now uses this safe-write protocol:

1. Create, write, and synchronize a unique sibling `.tmp`.
2. Open/hash the target and re-open/revalidate the expected exact revision. Windows checked handles deny write sharing while permitting rename observation.
3. Move the checked path entry into a unique same-directory `.bak` quarantine.
4. Run final-interval validation against the quarantined object.
5. Install the editor temporary with capability-relative `hard_link` no-replace semantics; a competing path entry is never overwritten.
6. Confirm exact resulting bytes/revision, remove ordinary temp/quarantine artifacts explicitly, and synchronize directory metadata where supported.
7. On conflict, restore quarantined bytes without replacing any competing entry. If both path entries contain competing bytes and automatic restoration cannot be exclusive, retain the `.bak` conflict artifact and identify its relative name in the typed stale-revision error. Native watch filtering already excludes `.uxml-editor-*.bak` and `.tmp` artifacts.

The deterministic hook is in the actual quarantined-target-to-no-replace-commit interval. Final path replacement preserves the external target and returns conflict. An existing writer is either excluded before mutation (Windows) or its bytes are revalidated/restored (supported non-Windows fixture). Ordinary stale/fault/success paths leave no editor artifacts.

`TauriHost.capabilities.atomicReplace` is now `best-effort-safe-write`. The implementation does not claim portable linearizable hash-CAS: a hostile non-Windows writer holding the quarantined inode can still target the final instruction interval after the last content revalidation. No destination is truncated in place and the tested final path race cannot erase the competing entry.

### Important 1: document-state generation lease

`Task16FileLifecyclePort` now exposes the concrete Task 16 lifecycle boundary:

- `acquireCloseState(nativeLease) -> { generation, dirtyState }`
- `finalValidateCloseState(documentLease) -> boolean`
- `releaseCloseState(documentLease)`
- `saveBeforeClose(documentLease)`

`DesktopLifecycleController` holds that document lease through clean, Discard, and Save decisions, final-validates immediately before native close, awaits native close/cancel resolution, and releases in `finally`. Acquire, confirmation, save, validation, resolution, release, cancellation, and error paths fail closed. Regressions inject edits after clean, Discard, and post-save decisions; all resolve native close as cancel. The unbound App adapter tracks exact session identity/generation and still reports an open session as `unknown`.

### Important 2: close delivery readiness and emit failure

Rust `CloseGate` starts not ready. A close before readiness is prevented without minting a pending lease. `desktop_set_lifecycle_ready({ ready })` is an exact, narrow state command; setting false clears any pending lease.

`DesktopLifecycleController.start()` registers `uxml://close-requested` first and only then awaits native readiness. App starts lifecycle before command/menu setup. Window delivery uses `CloseGate::request_for_delivery`; a failed `window.emit` cancels only the exact lease created for that delivery. Listener registration failure rolls back synchronously, and lifecycle disposal withdraws readiness with observable completion.

### Important 3: watch startup generation and self-deadlock

`TauriHost.watch` inserts its retirement record before awaiting native listener/startup operations. Successful project replacement retires pending and established watches, clears queued old-grant payloads, and causes a superseded startup to reject `root-not-granted` after its response arrives. No old event is delivered after the new frontend grant is published.

The listener origin is captured synchronously when a listener invokes `chooseProject()`. Retirement skips only that originating delivery promise, preventing self-deadlock; unrelated replacement still drains established listener work before grant publication. Existing failed-selection coverage continues to preserve the prior grant/watch.

### Important 4: transactional menu bridge

App startup order is now lifecycle readiness, menu-command listener readiness, then native file-workflow enablement. Any startup failure disposes partial listeners, restores Save/Save All/Close Project to disabled, and reports the failure. Disposal synchronously retires listeners and restores disabled state asynchronously with failures reported.

`DesktopCommandBridge` catches rejected command promises and routes them to `desktop.errors.report`; native event callbacks resolve even when Task 16 save/close commands fail. File commands remain disabled when Task 16 is absent.

### Important 5: watch/error accountability

`TauriHost` accepts the production `reportError` sink. Rejected native watch listeners and scheduled callbacks are contained, reported, and represented by failed `Disposable.completion` outcomes. `ExternalChangeCoordinator` preserves native completion through `SaveCoordinator.watch`, catches event setup/debounce/read/rescan/consumer-listener failures, and resolves its own typed failed completion. Native stop failure remains observable through that wrapper. No returned timer/listener promise is left unobserved in the production Tauri adapters.

## Schemas and Guarantees

Filesystem, watch, recovery, recent, dialog, menu, exact project/grant/revision/watch IDs, and one-host schemas from fix round 1 are unchanged.

New native command:

| Command | Request | Result |
| --- | --- | --- |
| `desktop_set_lifecycle_ready` | `{ ready: boolean }` | void |

Close event and resolution remain `{ lease: "close:v1:<16 lowercase hex>" }` and `{ lease, action: "close" | "cancel" }`. The document-state lease is an in-process Task 16 interface, not IPC and not filesystem authority.

## TDD RED/GREEN Evidence

Commands exited 1 at behavioral RED and 0 at GREEN unless stated otherwise.

| Slice | RED | GREEN |
| --- | --- | --- |
| Selection-time root swap, focused cargo test | 0/1; grant read `"outside"` after swap | 1/0; swap prevented or selection rejected by opened-object identity |
| Final path replacement, focused cargo test | 0/1; editor committed over external target | 1/0; external target preserved and replacement failed |
| Tauri capability downgrade, focused Vitest | 0/1; received `guaranteed` | 1/0; `best-effort-safe-write` |
| Clean/Discard/post-save edit races, focused lifecycle Vitest | 0/3; each received `close` instead of `cancel` | full lifecycle 16/16 |
| Native startup close, focused cargo test | 0/1; gate emitted a lease while not ready | desktop module GREEN |
| Native emit failure, focused cargo test | 0/1; next request remained `Prevent` | 1/0; exact failed-delivery lease canceled |
| Runtime readiness serialization, focused Vitest | 0/1; `setLifecycleReady` missing | 1/0 |
| Lifecycle readiness/disposal, focused Vitest | 0/1; no readiness transition | full lifecycle 16/16 |
| App startup/menu transaction, App desktop Vitest | 0/3; close listener absent, startup/disposal left menu enabled | 5/5 |
| Rejected desktop command, bridge Vitest | 0/1; `save failed` escaped callback | bridge 4/4 |
| In-flight watch + listener replacement, TauriHost Vitest | 0/2; stale startup resolved and listener replacement deadlocked | 3/3 including established drain |
| Watch listener accountability, TauriHost Vitest | 0/1; completion was `disposed` | GREEN failed completion + error sink |
| Timer accountability, corrected focused TauriHost Vitest | 0/1; `debounce failed` rejected timer | GREEN failed completion + error sink |
| SaveCoordinator completion/read/rescan/listener, focused Vitest | 0/3; completion absent and timer rejected | 3/3 |

An initial timer test invocation used the wrong fake method name and failed with `advanceTime is not a function`; it was corrected to `advance` before recording behavioral RED. An intermediate emit-failure compile run lacked the test import for `HostError`; the corrected run then produced the behavioral pending-lease RED above. Neither import/setup failure is counted as behavioral evidence.

Additional GREEN coverage: 8 atomic replacement tests, including existing-writer and Windows existing-destination behavior; focused Task 15 TypeScript set 6 files / 114 tests; all focused Rust cases passed.

## Final Verification

| Command/check | Exit / result |
| --- | --- |
| `npm test` | 0; 40 files / 585 tests |
| `npm run build` | 0; TypeScript and Vite passed, 1,889 modules transformed |
| `npm run test:e2e` | 0; 13 Playwright tests |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 0 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 0 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 0; 52 tests, doc tests passed |
| `npx tauri build --no-bundle` | 0; release executable rebuilt in 1m24s |
| release executable smoke | 0; live after 5s, title `UXML Editor`, controlled termination |
| `npm audit --omit=dev` | 0; 0 vulnerabilities |
| exact capability audit | 0; `main`, exactly 2 event permissions, no `app.capabilities` |
| forbidden-surface scan | 0 matches |
| dependency/license metadata audit | 0 |
| review artifact SHA-256 | unchanged |
| `git diff --check` | 0; only Windows line-ending notices |

An intermediate clippy run exited 1 for a test-only `is_none` plus `unwrap` pattern. It was rewritten with `if let`; the required final clippy run is clean. An intermediate TypeScript build exited 1 for two implicit parameter types in the unbound lifecycle adapter; both were annotated and final build/release build passed.

## Dependencies and Capabilities

No dependency or lockfile changed in fix round 2. Exact direct versions/licenses remain:

- `cap-std` 4.0.2: `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`.
- `@tauri-apps/api` 2.11.1 and CLI 2.11.4: `Apache-2.0 OR MIT`.
- `tauri` 2.11.5, `tauri-build` 2.6.3, `tauri-plugin-dialog` 2.7.1: `Apache-2.0 OR MIT`.
- `notify` 6.1.1: `CC0-1.0`.
- `serde` 1.0.229, `serde_json` 1.0.151, `sha2` 0.10.9, `windows-sys` 0.61.2: `MIT OR Apache-2.0`.

`src-tauri/capabilities/main.json` still grants exactly `core:event:allow-listen` and `core:event:allow-unlisten` to window `main`. There is no shell/fs plugin capability, broad glob, command execution, arbitrary path IPC, frontend window-close permission, telemetry, or explicit `app.capabilities` field. CSP is unchanged.

## Changed Files

Rust: `src-tauri/src/scoped_fs.rs`, `atomic_save.rs`, `desktop.rs`, `lib.rs`.

TypeScript: `src/core/host/TauriHost.ts`, `TauriHost.contract.test.ts`, `src/core/desktop/DesktopLifecycleController.ts`, its test, `DesktopCommandBridge.ts`, its test, `src/core/persistence/ExternalChangeCoordinator.ts`, `SaveCoordinator.test.ts`, `src/app/App.tsx`, `App.desktop.test.tsx`, `TauriRuntime.ts`, and `TauriRuntime.test.ts`.

Reports/review: `task-15-report.md`, `task-15-fix-2-report.md`, and the unchanged `task-15-fix-1-review.md`.

No plan, ledger, `UXML_GOAL.md`, dependency manifest/lock, CSP, downstream consumer, or unrelated file changed.

## Task 16 Boundary

Task 16 must implement the actual lifecycle lease owner and file commands through `Task16FileLifecyclePort`. It can bind document/session generation, block or queue edits while its lease is held, validate immediately before native resolution, release after resolution, and observe `SaveCoordinator.watch().completion`. Native Save/Save All/Close Project stay disabled until this owner is fully bound. No FileWorkflow or CommandRegistry was preempted here.

## Self-Review and Concerns

- Rechecked all accepted review findings, original Task 15 constraints, resolved exact-schema/single-host items, browser fallback, capability scope, and report claims.
- Windows replacement uses checked handles plus capability-relative quarantine/no-replace path installation; deterministic rename/path replacement and existing-writer tests pass.
- Non-Windows replacement is accurately exposed as best-effort safe write, not linearizable hash-CAS against an adversarial writer mutating an already-open quarantined inode after final revalidation.
- Native picker/menu/dialog workflows were not interactively automated. Injected boundary tests, 13 browser E2E tests, release build, and rebuilt executable smoke passed.
- The pre-existing Vite large-chunk advisory remains; build succeeds.
