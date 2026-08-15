# Task 15 Fix Round 1 Report

## Status

All 2 Critical, 5 Important, and 1 Minor accepted findings from `task-15-review.md` are fixed on `agent/uxml-editor`. Work started from clean head `c1d68cc`. No Task 16 FileWorkflow or CommandRegistry was added, and nothing was pushed.

## Finding Resolution

### Critical 1: ambient path authorization race

`ScopedProjects` stores a `cap_std::fs::Dir` opened only after the directory picker selection is canonicalized and validated. Enumeration walks capability-relative entry handles. Read, replacement, and watch revision reads open relative components through that authority. Ordinary commands never reconstruct an ambient project path from frontend input.

The deterministic intermediate-directory swap regression attempts to rename `Assets` and substitute an outside symlink/reparse point after authorization. Windows prevents the swap while the parent handle is open; supported non-Windows targets either reject the escape or continue against the original capability. The outside bytes are never returned.

### Critical 2: expected-revision check/commit race

Atomic replacement now:

1. Receives a capability-relative parent handle and one validated file name.
2. Creates a unique sibling temporary with `create_new` through that handle.
3. Writes exact bytes and flushes the temporary.
4. Opens and hashes the target through the capability.
5. On Windows, holds the target with `FILE_SHARE_READ | FILE_SHARE_DELETE`, denying newly opened writers but permitting rename.
6. Reopens and revalidates the exact content revision immediately before commit.
7. Uses capability-relative same-directory rename, flushes directory metadata where supported, rereads the result, and confirms its exact revision.
8. Removes temporary artifacts through an RAII capability guard on every failure.

Windows deterministic check-to-commit coverage proves an external writer is prevented and the editor replacement is exact. On non-Windows, a writer admitted in the test is detected by the second hash and its bytes are preserved. No portable linearizable hash-CAS is claimed: on non-Windows a hostile writer can still race after final revalidation and before rename. The target is never truncated in place.

### Important 1: close authorization race

The separable authorize/revoke commands and frontend window-close permission were removed. A native request creates one exact `close:v1:<16 lowercase hex>` lease and emits it to the lifecycle controller. That lease is passed through dirty state, confirmation, save, and post-save dirty recheck. The controller always resolves `close` or `cancel`; malformed/unknown state fails closed.

`desktop_resolve_close({ lease, action })` validates and consumes the current lease atomically. Approved closes call backend `WebviewWindow::destroy()`, which does not emit another close event, so no permit remains stale. Duplicate native requests are coalesced by Rust and the frontend controller; listeners dispose idempotently. `Task16FileLifecyclePort.getDirtyState(lease)` and `saveBeforeClose(lease)` are the explicit generation hooks Task 16 will hold.

### Important 2: grant replacement and queued watches

Selection is split into prepare and install. Rust validates and opens the candidate capability first, drains all old watch callback gates, then publishes the new grant. Failed selection preserves the previous grant and watches.

The stable project ID is accompanied by `grant:v1:<16 lowercase hex>` on all filesystem/watch requests and events. TypeScript stores the generation as a non-enumerable HostPort root/path brand. Old frontend roots are rejected even when the same stable project is selected again. `TauriHost.chooseProject()` deactivates listeners, drops queued payloads, awaits in-flight delivery, then publishes the new root. Malformed successful IPC fails closed by retiring watches and clearing cached authority.

### Important 3: unsupported menus and startup errors

Native `file.save`, `file.save-all`, and `file.close-project` items are disabled by default. `desktop_set_file_workflow_enabled({ enabled })` updates exactly those three menu items. App enables them only when `Task16FileLifecyclePort` is bound; Open Project/Edit/View remain available under their existing semantics.

App now reports menu/listener startup failures through `AppDesktopPorts.errors.report` and disposes any partially started bridge. It no longer swallows startup failure.

### Important 4: watch errors and stop accountability

`notify::Error` produces a typed rescan event instead of being discarded:

`{ watchId, projectId, grant, kind: "rescan-required" }`

`ExternalChangeCoordinator` handles it by debouncing a scan of every saved open path. Changed/deleted events remain normalized, revision-aware, deduplicated, artifact-filtered, grant-scoped, and disposal-gated.

Tauri watch disposal synchronously deactivates listener delivery and exposes `Disposable.completion`. Native stop success yields `{ status: "disposed" }`; native stop failure yields `{ status: "failed", error: HostError }` without an unhandled rejection.

### Important 5: exact schemas

Rust custom serde validators and TypeScript IPC validators enforce:

- project: `project:v1:<64 lowercase hex>`
- grant: `grant:v1:<16 lowercase hex>`
- revision: `sha256:v1:<64 lowercase hex>`
- watch: `watch:v1:<16 lowercase hex>`
- close lease: `close:v1:<16 lowercase hex>`

Filesystem DTOs use `deny_unknown_fields`. TauriHost validates exact response/event key sets before branding or freezing values. Rust and TypeScript fixtures cover malformed length, uppercase hex, missing grant, unsafe revisions, wrong watch/project/grant, and extra fields.

### Minor: duplicate runtime host

`createTauriRuntimeBindings` creates one `TauriHost`. Production `main.tsx` passes that exact instance to `createRuntimeEditorStore`; the old `hostPorts` reconstruction path is not used by runtime bootstrap. Browser detection still creates the existing `BrowserHost`, and injected-port tests remain supported.

## Command and Event Schemas

| Boundary | Exact payload/result |
| --- | --- |
| `host_choose_project` | result `null` or `{ projectId, displayName, grant }` |
| `host_enumerate_files` | request `{ projectId, grant }`; result `{ relativePaths }` |
| `host_read_text` | request `{ projectId, grant, relativePath }`; result `{ text, revision }` |
| `host_replace_text` | request `{ projectId, grant, relativePath, expectedRevision, text }`; result `{ revision }` |
| `host_start_watch` | request `{ projectId, grant }`; result `{ watchId }` |
| `host_stop_watch` | request `{ projectId, grant, watchId }`; void |
| recovery commands | stable `{ projectId }` or `{ projectId, journal }`; app-data only |
| recent commands | stable project metadata only; never grants authority |
| `desktop_resolve_close` | `{ lease, action: "close" | "cancel" }`; void |
| `desktop_set_file_workflow_enabled` | `{ enabled: boolean }`; void |
| changed watch event | `{ watchId, projectId, grant, kind: "changed", relativePath, revision }` |
| deleted watch event | `{ watchId, projectId, grant, kind: "deleted", relativePath }` |
| rescan watch event | `{ watchId, projectId, grant, kind: "rescan-required" }` |
| close event | `{ lease }` |

All Tauri request arguments remain wrapped as `{ request: ... }` by the TypeScript bridge.

## Changed Files

Rust authority and desktop boundary:

- `src-tauri/src/identifiers.rs`
- `src-tauri/src/scoped_fs.rs`
- `src-tauri/src/atomic_save.rs`
- `src-tauri/src/watch.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/desktop.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/capabilities/main.json`
- `THIRD-PARTY-NOTICES.md`

TypeScript host, persistence, lifecycle, runtime, and tests:

- `src/core/host/HostPort.ts`
- `src/core/host/MemoryHost.ts`
- `src/core/host/TauriHost.ts`
- `src/core/host/TauriHost.contract.test.ts`
- `src/core/persistence/ExternalChangeCoordinator.ts`
- `src/core/persistence/SaveCoordinator.test.ts`
- `src/core/desktop/DesktopLifecycleController.ts`
- `src/core/desktop/DesktopLifecycleController.test.ts`
- `src/app/TauriRuntime.ts`
- `src/app/TauriRuntime.test.ts`
- `src/app/createProductionTauriRuntime.ts`
- `src/app/createRuntimeEditorStore.ts`
- `src/app/createRuntimeEditorStore.test.ts`
- `src/app/App.tsx`
- `src/app/App.desktop.test.tsx`
- `src/main.tsx`

Reports:

- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-report.md`
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-fix-1-report.md`

No plan, ledger, `UXML_GOAL.md`, downstream consumer, or unrelated file was changed.

## TDD RED/GREEN Evidence

Every production behavior began with a focused regression. Commands below exited 1 at RED and 0 at GREEN unless stated otherwise.

| Slice | RED evidence | GREEN evidence |
| --- | --- | --- |
| Capability traversal | `cargo test ... scoped_fs::tests::authorized_multi_component_read_never_follows_a_concurrent_directory_swap -- --exact --nocapture`: 0 passed / 1 failed; outside bytes were returned | same command: 1 passed / 0 failed |
| External writer interval | `cargo test ... atomic_save::tests::external_writer_in_the_check_to_commit_interval_is_prevented_or_preserved -- --exact --nocapture`: 0/1; replacement returned success and lost external bytes | same command: 1/0 |
| Rust request grammar | focused `filesystem_request_schemas_require_exact_project_grant_revision_and_watch_ids`: 0/1, valid granted request rejected | 1/0 |
| Rust grant result | focused `project_selection_serializes_a_distinct_exact_grant_token`: 0/1, grant missing | 1/0 |
| Native watcher failure | focused `native_backend_errors_emit_a_typed_rescan_required_event`: 0/1, emitted count 0 instead of 1 | 1/0; full watch module 8/8 |
| TS exact grant IPC | focused TauriHost schema test: 0/1, grant-bearing chooser result rejected | 1/0 |
| TS stop accountability/rescan | focused TauriHost stop test: 0/1, chooser/watch schema rejected | 1/0 |
| Frontend grant drain | focused `drains old grant delivery...`: 0/1, replacement could not establish grant-bearing state | 1/0 |
| Coordinator rescan | focused SaveCoordinator rescan test: 0/1, `event.path` TypeError | 1/0; full SaveCoordinator 45/45 |
| Native menu defaults | focused Rust menu test: 0/1, `file.save` started enabled | 1/0 |
| Close lease bridge | focused TauriRuntime test: 0/1, `resolveClose` absent | 1/0 |
| Close lease controller | focused lifecycle run: 0/2, lease missing and cancel unresolved | 2/0; full lifecycle 12/12 |
| App menu/error startup | focused App desktop test: 0/1, no disabled state and no error report | 1/0 |
| Single runtime host | focused runtime-store test: 0/1, missing ports caused a second-host bootstrap failure | 1/0 |
| Same-project grant replacement | focused TauriHost test: 0/1, old root resolved successfully | 1/0 |
| Stale native close permit | focused Rust close test: 0/1, next request consumed residual `Allow` state | 1/0 after backend `destroy()` and permit removal |
| Rust callback drain fixture | first focused run: 0/1, injected noncanonical Windows test path timed out before the assertion | corrected canonical fixture: 1/0; production logic unchanged |

Additional focused GREEN runs: TauriHost contract 29/29, Rust commands 10/10 before final additions, scoped filesystem 7/7 before final additions, watch 8/8, and lifecycle/runtime/App/store 28 combined tests.

## Final Verification

| Command | Exit / result |
| --- | --- |
| `npm test` | 0; 40 files, 571 tests passed |
| `npm run build` | 0; TypeScript and Vite production build passed, 1,889 modules transformed |
| `npm run test:e2e` | 0; 13 Playwright tests passed |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml` | 0 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 0 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 0; 47 tests passed |
| `npx tauri build --no-bundle` | 0; `src-tauri/target/release/uxml-editor.exe` rebuilt |
| rebuilt executable smoke | 0; process live after 4 seconds, title `UXML Editor`, clean harness termination |
| `npm audit --omit=dev` | 0; 0 vulnerabilities |
| exact capability audit | 0; window `main`, 2 event permissions, no direct fs/shell plugin, no `app.capabilities` |
| forbidden surface scan | 0; no legacy close permit, window-close permission, shell plugin, broad fs permission, or `hostPorts` runtime symbol |
| dependency/license metadata audit | 0 |
| `git diff --check` | 0; only Windows LF-to-CRLF notices |

An intermediate clippy run exited 1 for a constant target assertion in the external-writer test. The assertion was rewritten as a target-gated check; the required final clippy run is clean.

## Dependencies and Licenses

New direct dependency:

- `cap-std` exactly 4.0.2: `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`.

Its locked support stack observed by `cargo metadata`:

- `cap-primitives` 4.0.2, `ambient-authority` 0.0.2, `fs-set-times` 0.20.3, `io-extras` 0.19.0, and `io-lifetimes` 2.0.4/3.0.1: `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`.
- `ipnet` 2.12.1 and `maybe-owned` 0.3.4: `MIT OR Apache-2.0`.
- `winx` 0.36.4: `Apache-2.0 WITH LLVM-exception`.

Existing exact desktop versions remain:

- `@tauri-apps/api` 2.11.1 and CLI 2.11.4: `Apache-2.0 OR MIT`.
- `tauri` 2.11.5, `tauri-build` 2.6.3, and `tauri-plugin-dialog` 2.7.1: `Apache-2.0 OR MIT`.
- `notify` 6.1.1: `CC0-1.0`.
- `serde` 1.0.229, `serde_json` 1.0.151, `sha2` 0.10.9, and `windows-sys` 0.61.2: `MIT OR Apache-2.0`.

`tauri-plugin-fs` 2.5.1 remains a transitive dialog-plugin type dependency; it is not initialized or capability-granted. No shell dependency was added. `Cargo.lock` and `THIRD-PARTY-NOTICES.md` are updated.

## Capability Audit

`src-tauri/capabilities/main.json` is scoped to `main` and contains exactly:

1. `core:event:allow-listen`
2. `core:event:allow-unlisten`

No shell permission/plugin, broad filesystem permission/glob, frontend dialog permission, arbitrary code execution, arbitrary path IPC, telemetry, or `core:window:allow-close` remains. Native dialogs use the existing custom Rust commands. The CSP is unchanged. `tauri.conf.json` intentionally has no explicit `app.capabilities`, preserving compatibility with `tauri-build` 2.6.3.

## Browser and Desktop Checks

Browser tests remained green through `BrowserHost`; full npm and Playwright suites passed. The final release build used the pinned Tauri stack, and the rebuilt executable opened a live window titled `UXML Editor`.

The real picker/menu/dialog workflow was not interactively driven because reliable native UI automation was not available. Directory selection, scoped read/watch/replace, exact bytes, menu state/IDs, and Save/Discard/Cancel lifecycle decisions are covered through real Rust filesystem fixtures plus injected TypeScript/native ports.

## Task 16 Boundary

Task 16 will provide the actual FileWorkflow and unified CommandRegistry. This fix round adds only consumable infrastructure:

- `Task16FileCommandPort` remains the narrow save/save-all/close command hook.
- `Task16FileLifecyclePort.getDirtyState(lease)` and `saveBeforeClose(lease)` explicitly hold the native close generation through Task 16 work.
- `desktop_set_file_workflow_enabled` enables Save/Save All/Close Project only after that owner is bound.
- `DesktopCommandBridge` still delegates current commands instead of duplicating command logic.
- An open session without Task 16 ownership remains `unknown`, resolves native close as cancel, and leaves file menu actions disabled.

## Self-Review

- Rechecked every accepted finding and Task 15 global constraint against source and tests.
- Confirmed capability-relative project traversal, opaque stable IDs, distinct current-session grants, same-project invalidation, failed-selection preservation, and callback drain ordering.
- Confirmed exact CRLF/Unicode revisions, deterministic enumeration, stale/concurrent replacement behavior, failure cleanup, Windows writer exclusion, and accurate non-Windows residual claims.
- Confirmed typed backend rescan, event isolation/deduplication, synchronous listener stop, observable native stop failure, and immutable snapshots.
- Confirmed one backend close operation with no stale permit, lease propagation to Task 16, disabled unsupported menus, surfaced startup errors, and one production TauriHost.
- Confirmed no broad fs/shell capability, no arbitrary path command, unchanged CSP, no Task 16 workflow/registry, no plan/ledger/goal changes, and no push.

## Concerns

- Non-Windows replacement is failure-safe and revalidated immediately before rename, but it is not a linearizable content-hash CAS against a hostile writer in the final instruction interval.
- Native picker/menu/dialog interactions were not UI-automated; release window smoke and boundary fixtures passed.
- Vite continues to report the existing large-chunk advisory; the production build succeeds.
