# Task 15 Fix Round 4 Report

## Status

Implemented all accepted Critical, Important, and Minor findings from `task-15-fix-3-review.md` on `agent/uxml-editor`, starting at clean commit `515f25e`. The review artifact is included unchanged with SHA-256 `105F694D92A19CD3E6BD87150B0FFCED1DA14B5E14F3DA4A2D823F3A4B44434F`.

This round replaces the remaining Windows pathname transitions with live-handle operations, makes recovery ownership conservative and repeatable, makes close delivery and readiness withdrawal retryable, preserves watch completion through in-flight callbacks, and gates overlapping desktop command listeners by workflow generation. Task 16's actual file workflow and `CommandRegistry` remain out of scope.

## Finding-by-Finding Resolution

### 1. Windows replacement is handle-bound

The supported Windows protocol is:

1. Open the target through the granted `cap_std::fs::Dir` with `FILE_GENERIC_READ | DELETE` and `FILE_SHARE_READ`. The checked handle remains live for every target operation.
2. Create the unique sibling temporary through the same directory capability with `FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE`, `CREATE_NEW`, and `FILE_SHARE_READ`. Write exact UTF-8 bytes and call `sync_all` on this handle.
3. Hash the target through its checked handle before and after temporary synchronization.
4. Rename that checked target handle no-replace to a unique sibling backup name, relative to the granted directory handle.
5. Hash the same target/backup handle after rename. The deterministic final race hook runs after this hash and before installation.
6. Rename the synchronized temporary handle no-replace to the target name, relative to the same directory handle. A destination competitor causes conflict and remains untouched.
7. Hash and verify the result through the same installed temporary handle. Its sharing mode still denies write/delete/rename access. The post-result hook proves the destination cannot be displaced between this hash and return.
8. Complete the last fallible metadata step, then mark the backup deleted using `SetFileInformationByHandle(FileDispositionInfo)` on its owning `DELETE`-capable handle. No fallible or destructive operation follows successful disposition.

Renames use `NtSetInformationFile(FileRenameInformation)` with `FILE_RENAME_INFORMATION.RootDirectory` set to the live grant directory handle and `ReplaceIfExists = false`. The implementation first used the documented [`SetFileInformationByHandle` `FileRenameInfo` contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle) and [`FILE_RENAME_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info), including `DELETE` access and non-null `RootDirectory`; the supported Windows target reproducibly returned `ERROR_INVALID_PARAMETER (87)`. The equivalent native information-class operation was therefore used and tested. Authority remains capability-relative: no absolute project path enters the protocol.

Exact Windows tests cover:

- checked writable-handle exclusion before any hook runs;
- competitor rename/replacement attempts after target-to-backup transition;
- a competitor after final result hash;
- no-replace destination and backup-name conflicts;
- the committed result remaining at the destination through return;
- exact CRLF/Unicode content and revision confirmation;
- stale revisions and every injected post-quarantine fault phase;
- rollback or surfaced retained recovery bytes after failure.

Windows sharing semantics are reported narrowly: a checked handle requesting only `FILE_SHARE_READ` cannot be acquired while an existing writable handle requires incompatible sharing, and a writable/delete/rename handle cannot open while the checked handle remains live. No claim is made that an admitted writable handle coexists with the checked editor handle.

Non-Windows returns typed `unsupported` before creating a temporary or quarantining the target. Runtime capability negotiation remains `best-effort-safe-write` on Windows and `unsupported` elsewhere. This is not advertised as a cross-platform linearizable content-hash CAS.

### 2. Recovery ownership and idempotence

- A `.tmp` entry is never removed because its name matches the editor pattern. Without a durable ownership record, it is retained and surfaced as an unauthenticated artifact.
- A target-absent `.bak` is opened through the granted directory and restored with a handle-bound, parent-relative, no-replace rename.
- When both target and backup exist, Windows opens both objects and compares volume serial and file index. Only same-identity legacy artifacts are deleted, through the backup handle. Different identities remain untouched and are surfaced.
- Repeated recovery after an interrupted restore is idempotent: the restored target is retained, and a same-identity legacy second name can be cleaned without a pathname race.
- Backup cleanup, restoration, and conflict errors name the relative artifact. Project roots and absolute paths are not exposed.
- Backup guard Drop is intentionally non-destructive. A failure can retain an artifact, but cannot delete the sole original bytes.

### 3. Close retry and reconciliation

- `CloseGate::request` now emits the exact current pending `{ lease, lifecycleGeneration }` again on a later native close attempt instead of returning an unobservable prevent decision.
- `DesktopLifecycleController` clears its per-delivery processing flag after every resolution path. If `resolveClose` and `abandonClose` both fail, both failures reach `desktop.errors.report`; a later native redelivery retries the exact lease and can complete.
- Lifecycle startup/disposal exposes `LifecycleDisposable.retry()` and typed completion. The close listener is removed only after `setLifecycleReady(generation, false)` succeeds for that exact generation.
- Failed readiness withdrawal leaves the listener functional. Its reported typed error carries retry and completion. Immediate retry is serialized after the failed attempt, rather than reusing the failed promise.
- A failed old-generation withdrawal does not withdraw or resolve a newer generation. Tests retain both listeners during overlap and prove only the current generation handles the close event.
- The Task 16 owner-supplied exclusive document-state callback remains unchanged: final validation and native resolution execute inside its edit-blocking scope, and all completion/error paths release that scope.

### 4. Watch completion follows in-flight delivery

Grant replacement synchronously marks the watch inactive, clears queued payloads, and unlistens before publishing the new grant. It does not await an already-running listener and therefore cannot deadlock a callback that awaits `chooseProject()`.

The public `Disposable.completion` now separately captures the delivery promise at retirement. It remains pending until that in-flight callback settles, then returns `failed` with the listener error or `disposed` on success. Native retirement and grant publication still skip the active callback wait; only the public completion observes it. Queued old-generation callbacks never start.

### 5. Menu listeners use a shared current-generation gate

- Each App effect allocates a typed workflow generation and registers it in a `WeakMap` gate keyed by the shared desktop runtime ports.
- `DesktopCommandBridge` checks that gate before validating/executing every native command delivery.
- If old-generation disable fails and no successor exists, its listener remains current and functional, matching the native enabled state.
- When a newer generation finishes listener startup and registers, the old retained listener becomes inert immediately. Save and representative Edit/View commands execute exactly once on the new owner even if the old native disable response was lost.
- Disposal still disables native file-workflow items before retiring/removing listeners. A failed disable reports a retryable typed error and leaves the functional current listener attached; successful retry disables first and then removes it.
- Existing Rust menu transitions remain all-or-rollback across Save, Save All, and Close Project and retain exact workflow-generation validation.

## TDD Evidence

Focused behavioral regressions were added before production changes. Missing imports were not used as behavioral RED.

| Slice | RED evidence | GREEN evidence |
| --- | --- | --- |
| Windows final intervals and artifact naming | `cargo test --manifest-path src-tauri/Cargo.toml atomic_save::tests -- --nocapture`, exit 101: 10 passed / 3 failed. Failures showed a competitor destination was deleted/overwritten and final cleanup omitted its artifact. | Same suite, exit 0: 14 passed. |
| Recovery ownership/idempotence | `cargo test --manifest-path src-tauri/Cargo.toml scoped_fs::tests -- --nocapture`, exit 101: 11 passed / 2 failed. Matching temp was deleted and same-identity interrupted recovery surfaced as a conflict. | Same suite, exit 0: 14 passed. |
| Root-relative handle rename integration | First handle implementation ran the atomic suite with 4 passed / 9 failed, all real rename paths returning Windows `ERROR_INVALID_PARAMETER (87)` through the Win32 wrapper. The exact replace test remained 0/1. | Switching only the root-relative rename primitive to `NtSetInformationFile` made the exact test and complete 14-test suite pass. |
| Native close redelivery | `cargo test --manifest-path src-tauri/Cargo.toml desktop::tests::pending_close_lease_is_redelivered_exactly_on_a_later_native_attempt -- --exact --nocapture`, exit 101: 0/1, pending lease was not redelivered. | Rust desktop suite, exit 0: 17 passed. |
| Lifecycle withdrawal/retry | `npm test -- --run src/core/desktop/DesktopLifecycleController.test.ts`, exit 1: 21 passed / 1 failed; listener count was 0 after failed withdrawal. Startup double-failure exact test also exited 1 because retry was absent. | Final lifecycle suite, exit 0: 25 passed. |
| Immediate withdrawal retry | Focused lifecycle test exited 1 because immediate retry reused the failed `{ status: "failed" }` attempt. | Exact test and complete lifecycle suite passed after retry serialization. |
| Watch retirement completion | Focused `TauriHost.contract.test.ts` run for `replacement retirement completion|keeps completion pending`, exit 1: 2 failed / 35 skipped; both completions settled before their listeners. | Same focus, exit 0: 2 passed / 35 skipped; final host suite passed. |
| Menu listener generation | `npm test -- --run src/app/App.desktop.test.tsx -t "executes file edit and view commands"`, exit 1: old Save executed once when zero was expected. | Full App desktop suite, exit 0: 8 passed. |

Final focused totals:

- TypeScript host/lifecycle/command/App/runtime/save suite: exit 0, 6 files / 131 tests.
- Rust atomic replacement: exit 0, 14 tests.
- Rust scoped filesystem/recovery: exit 0, 14 tests.
- Rust desktop/menu/close: exit 0, 17 tests.

## Full Verification

| Command/check | Result |
| --- | --- |
| `npm test` | exit 0, 40 files / 602 tests passed |
| `npm run build` | exit 0, TypeScript and Vite production build passed; 1,889 modules transformed; existing chunk-size advisory only |
| `npm run test:e2e` | exit 0, 13 Playwright tests passed; existing color-variable advisory only |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | exit 0 |
| `cargo check --manifest-path src-tauri/Cargo.toml --all-targets` | exit 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | exit 0; an intermediate `too_many_arguments` diagnostic was removed by the `ReplacementHooks` value object |
| `cargo test --manifest-path src-tauri/Cargo.toml` | exit 0, 69 tests passed; 0 doc tests failed |
| `npx tauri build --no-bundle` | exit 0; release executable rebuilt at `src-tauri/target/release/uxml-editor.exe` |
| Release executable smoke | exit 0; hidden process remained alive for five seconds, size 10,074,112 bytes, then only the harness-owned PID was terminated |
| `npm audit --omit=dev` | exit 0, 0 vulnerabilities |
| Capability audit | exit 0; sole `main` capability has exactly `core:event:allow-listen` and `core:event:allow-unlisten`; no `app.capabilities` key |
| Forbidden-surface audit | exit 0; no shell/fs permission, window close permission, arbitrary command execution, or broad path capability in source/config/manifests |
| Dependency/license audit | exit 0; every exact manifest/lock version and license matched |
| Notice audit | exit 0; 7 exact dependency/version entries found after Markdown normalization |
| Accepted-review hash | exit 0; SHA-256 unchanged at `105F694D92A19CD3E6BD87150B0FFCED1DA14B5E14F3DA4A2D823F3A4B44434F` |
| `git diff --check` | exit 0; Git emitted only Windows LF-to-CRLF notices |

## Dependencies, Capabilities, and Schemas

No package version or lockfile changed in round 4. `windows-sys` remains exactly 0.61.2, MIT OR Apache-2.0; only its exact feature list added `Wdk_Storage_FileSystem` and `Win32_System_IO` for `NtSetInformationFile` and `IO_STATUS_BLOCK`. Existing exact dependencies and notices remain:

- `cap-std` 4.0.2, Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT.
- `@tauri-apps/api` 2.11.1, Apache-2.0 OR MIT.
- `@tauri-apps/cli` 2.11.4, Apache-2.0 OR MIT.
- `tauri` 2.11.5 and `tauri-build` 2.6.3, Apache-2.0 OR MIT.
- `tauri-plugin-dialog` 2.7.1, Apache-2.0 OR MIT.
- `notify` 6.1.1, CC0-1.0.
- `serde` 1.0.229, `serde_json` 1.0.151, and `sha2` 0.10.9, MIT OR Apache-2.0.

Capabilities remain narrow and unchanged: no shell plugin/capability, no filesystem plugin/glob, no command execution, no window-close permission, and no incompatible `app.capabilities` field. Project/grant/revision/watch/close/lifecycle/workflow schemas and strict lowercase ID validation are unchanged. One Tauri runtime owns one `TauriHost`; browser startup still selects `BrowserHost`.

## Changed Files

- `src-tauri/Cargo.toml`: enabled the two exact Windows API feature modules; version unchanged.
- `src-tauri/src/atomic_save.rs`: handle-bound Windows replace/delete/recovery protocol and regressions.
- `src-tauri/src/scoped_fs.rs`: recovery ownership/idempotence regressions.
- `src-tauri/src/desktop.rs`: pending close redelivery and Rust regression.
- `src/core/desktop/DesktopLifecycleController.ts`: retryable exact-generation readiness withdrawal.
- `src/core/desktop/DesktopLifecycleController.test.ts`: transport, redelivery, retry, and overlap regressions.
- `src/core/host/TauriHost.ts`: split immediate watch retirement from public in-flight completion.
- `src/core/host/TauriHost.contract.test.ts`: successful/failing post-retirement delivery regressions.
- `src/core/desktop/DesktopCommandBridge.ts`: current workflow-generation command gate.
- `src/app/App.tsx`: shared desktop command-generation ownership.
- `src/app/App.desktop.test.tsx`: failed-disable and StrictMode overlap command regressions.
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-fix-3-review.md`: accepted review preserved unchanged.
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-report.md`: final round-4 architecture/evidence addendum.
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-fix-4-report.md`: this report.

## Task 16 Boundary

This round does not add FileWorkflow or CommandRegistry behavior. Task 16 retains these explicit hooks:

- `Task16FileLifecyclePort.runExclusiveCloseState(lease, operation)` owns the exclusive document-state scope and must block or queue edits through native `resolveClose` completion.
- `finalValidateCloseState` and `saveBeforeClose` remain owner-provided operations under that scope.
- `Task16FileCommandPort` remains the narrow Save/Save All/Close Project binding.
- `DesktopCommandBridge` remains a typed stable-command consumer that the future registry can own without changing native menu schemas.

Without a Task 16 file lifecycle binding, native Save, Save All, and Close Project remain disabled and an open unknown document state cannot be represented as clean.

## Self-Review and Concerns

- Rechecked the accepted round-4 review finding by finding. Existing selected-root object identity, exact grant/DTO validation, post-yield watch reentry, exclusive close scope, Rust transactional menus, production error sinks, single-host runtime ownership, browser fallback, CSP, and capability restrictions remain intact.
- No pathname-based remove or hard-link operation remains in the Windows atomic protocol. Every editor-owned live artifact transition uses its owning handle and granted directory handle; backup Drop is non-destructive.
- The packaged target is Windows. Non-Windows atomic replacement and backup restoration intentionally return typed `unsupported`; no false portable guarantee is advertised.
- The Windows root-relative rename uses the native `NtSetInformationFile` information class because the documented Win32 wrapper rejected non-null `RootDirectory` on the verified target. This introduces no new package/version/license, but it is a Windows-specific implementation surface that should remain covered on supported Windows CI.
- Real picker/menu/dialog interaction was not automated. The rebuilt release executable smoke passed, and injected TypeScript ports plus Rust state/command fixtures cover these boundaries deterministically.
- Vite's existing large-chunk advisory remains. It is unrelated to the desktop authority/lifecycle changes.
