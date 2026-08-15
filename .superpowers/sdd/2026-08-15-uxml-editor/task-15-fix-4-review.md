# Task 15 Fix Round 4 Review (`515f25e..6c423e4`)

Review only. No production code was changed and nothing was committed or pushed.

## Critical

1. **Recovery follows a target reparse point before deciding that a backup is redundant, so a target symlink to the backup can delete the sole original bytes.**

   `src-tauri/src/scoped_fs.rs:161` runs recovery before the selected project is enumerated or any project file is opened through the normal reparse checks. In the target-present branch, `src-tauri/src/atomic_save.rs:858` uses `symlink_metadata` only to establish existence. `open_recovery_identity_file` then uses default-following open options at `src-tauri/src/atomic_save.rs:945` and `src-tauri/src/atomic_save.rs:950`, so the target open at `src-tauri/src/atomic_save.rs:870` follows a final-component symlink/reparse point. If `Main.uxml` is a relative file symlink to `.Main.uxml.uxml-editor-42-10.bak`, both handles identify the backup object; `same_file_identity` returns true and `src-tauri/src/atomic_save.rs:880` marks the backup link for deletion. On handle close, the backup name disappears while `Main.uxml` remains a dangling symlink. The sole bytes are lost.

   This is also raceable: checking no-follow metadata and then doing a following open does not stop an attacker or synchronizer from replacing the target with a reparse point between the two operations. Recovery needs final-component no-follow/reparse-resistant handle acquisition and must reject every target or backup reparse object before using identity to authorize cleanup. A pathname precheck alone is insufficient.

2. **The identity used to authorize backup deletion is not unique on ReFS.**

   `src-tauri/src/atomic_save.rs:957` defines identity as `(u32, u64)`, and `src-tauri/src/atomic_save.rs:963` obtains the legacy `BY_HANDLE_FILE_INFORMATION` fields. `src-tauri/src/atomic_save.rs:973` compares the 32-bit volume serial plus `nFileIndexHigh/nFileIndexLow`; a match authorizes deletion at `src-tauri/src/atomic_save.rs:880`. Microsoft explicitly documents that this 64-bit file identifier is not guaranteed unique on ReFS and directs callers to `GetFileInformationByHandleEx(FileIdInfo)` for the 128-bit ID: [BY_HANDLE_FILE_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information).

   Concrete failure: on a ReFS project, a real target and a distinct retained backup return the same legacy 64-bit value. Recovery treats them as the same object and dispositions the backup, potentially deleting the only pre-save bytes. `src-tauri/src/scoped_fs.rs:328` nevertheless advertises `best-effort-safe-write` for every Windows grant, with no filesystem restriction. Use `FILE_ID_INFO` (including its full volume serial and 128-bit file ID), or explicitly reject filesystems where a deletion-grade identity proof is unavailable.

## Important

1. **The frontend workflow gate can resurrect a stale retained listener and is not shared across separate runtime wrappers.**

   The gate is a stack-like array at `src/app/App.tsx:175`; successful retirement removes a generation at `src/app/App.tsx:182`, and `src/app/App.tsx:186` then declares the last remaining entry current. Concrete sequence: generation N's disable fails at `src/app/App.tsx:117`, so N remains registered; N+1 registers and correctly supersedes it; N+1 later disables successfully and retires; N becomes current again even though the monotonic Rust gate has already observed N+1. A later always-enabled Edit/View event passes `src/core/desktop/DesktopCommandBridge.ts:57` and mutates the unmounted N store. The round-4 test at `src/app/App.desktop.test.tsx:182` checks N only while N+1 remains mounted, not after N+1 retires.

   Separately, `src/app/App.tsx:164` keys the `WeakMap` by the whole `AppDesktopPorts` wrapper. `src/app/TauriRuntime.ts:22` creates a fresh wrapper for each runtime binding. Two App/runtime instances over the same Tauri event transport therefore get independent gates and both consider their listener current; one broadcast menu event executes twice. StrictMode with the same wrapper is covered, but the claimed App/runtime-wide ownership is not. The shared authority needs a transport/runtime identity plus a monotonic high-water mark that can never reactivate an older generation.

2. **Recovery does not reject every Windows directory reparse point before recursive mutation.**

   `src-tauri/src/atomic_save.rs:794` skips only entries for which Rust reports `FileType::is_symlink()`. `src-tauri/src/atomic_save.rs:797` queues every remaining directory and `src-tauri/src/atomic_save.rs:825` opens it before recursively processing artifacts at `src-tauri/src/atomic_save.rs:832`. A Windows directory reparse tag that is not a name surrogate can report `is_dir()` rather than `is_symlink()`; a filesystem filter can then expose or hydrate matching `.bak`/`.tmp` entries and recovery acts on them before normal file access reaches the explicit reparse check at `src-tauri/src/scoped_fs.rs:474`. Normal enumeration has the same incomplete classification at `src-tauri/src/scoped_fs.rs:435`.

   Standard file/directory symlinks and mount-point junctions are name-surrogate tags and are skipped by `src-tauri/src/atomic_save.rs:794`; I did not reproduce the concern as ordinary junction recursion. The open issue is the broader `FILE_ATTRIBUTE_REPARSE_POINT` policy: the walker should inspect no-follow metadata and reject all directory reparse objects before `open_dir`, matching the final-file rule.

3. **Atomic-replace capability negotiation is broader than the native rename form that was verified.**

   `src-tauri/src/scoped_fs.rs:328` reports `best-effort-safe-write` solely from `cfg(windows)`. Every rename then supplies a non-null directory handle in `FILE_RENAME_INFORMATION.RootDirectory` at `src-tauri/src/atomic_save.rs:673`. The local x64 Windows ABI and behavior are sound, but the round-4 tests cover a local filesystem only. Microsoft's network `FileRenameInformation` contract documents a nonzero `RootDirectory` as invalid for a network operation: [MS-FSCC FileRenameInformation](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/1d2673a8-8fb9-4868-920a-775ccaa30cf8).

   Concrete support case: a user selects a mapped or UNC SMB project, receives a replace-capable root, and then gets an invalid-parameter/unsupported save when the redirector cannot honor this root-handle form. This is a safe failure before the first successful quarantine rename, not a demonstrated network data-loss path, but it violates the negotiated capability. Restrict the capability to verified local backends/filesystems or add supported-target integration coverage and a capability-relative network implementation.

## Minor

1. **Several recovery failures still omit the relative retained artifact.**

   The backup open is wrapped with the artifact at `src-tauri/src/atomic_save.rs:860`, but the target open and identity comparison are bare `?` operations at `src-tauri/src/atomic_save.rs:870` and `src-tauri/src/atomic_save.rs:871`. The metadata-error branch at `src-tauri/src/atomic_save.rs:913` also omits it. Concrete case: target and backup are distinct, backup opens, but a sharing mode denies the target's requested `DELETE` access. Project acquisition fails while the backup remains, yet the error names neither its relative path nor the bytes the user must preserve. The fix-3 `CapBackupGuard::remove` omission is fixed; these are new recovery-path omissions.

2. **The Rust recovery tests no longer match the intentional non-Windows behavior.**

   `src-tauri/src/atomic_save.rs:845` now returns typed `unsupported` for backup recovery on non-Windows before mutation. However, the unguarded absent-target test still unwraps successful acquisition at `src-tauri/src/scoped_fs.rs:826`, the conflict test expects `replace-failed` at `src-tauri/src/scoped_fs.rs:845`, and the new same-identity test unwraps success at `src-tauri/src/scoped_fs.rs:888`. A non-Windows `cargo test` therefore deterministically fails these cases. The packaged Rust target is Windows, so this is not a production portability claim, but tests should be Windows-gated or assert the exact non-Windows unsupported contract.

## Prior Finding Map

| Fix-3 finding | Status | Adjudication |
| --- | --- | --- |
| Critical 1: destructive pathname operations after delete sharing | **RESOLVED** | Target-to-backup and temp-to-target transitions now rename the owning live handle relative to the grant directory; backup/temp cleanup is handle disposition. No production pathname remove or hard-link operation remains, and both source handles deny write/delete sharing through return. The recovery findings above are distinct. |
| Important 1: recovery deletes unauthenticated `.tmp` | **RESOLVED** | `src-tauri/src/atomic_save.rs:921` always retains and surfaces a matching temp. The committed collision test confirms bytes remain. |
| Important 2: absent-target backup recovery is not interruption-idempotent | **PARTIAL** | Restoration is now one no-replace handle rename, and the NTFS hard-link same-identity case passes. The cleanup authorization is still unsafe for followed reparses and legacy ReFS IDs, so the broad same-identity claim is not resolved. |
| Important 3: close gate wedges after double transport/readiness withdrawal failure | **RESOLVED** | Rust redelivers the same pending lease; frontend processing clears after each attempt; failed resolve plus abandon is retryable on redelivery; failed readiness withdrawal retains the listener and exposes serialized retry/current-generation behavior. |
| Important 4: replacement watch completion settles before listener failure | **RESOLVED** | Replacement retirement remains nonblocking, while public completion separately awaits the captured delivery and returns its failure. Queued delivery is suppressed. |
| Important 5: failed menu disable overlaps a newer command listener | **PARTIAL** | A newer generation suppresses the old listener while the successor remains registered. Stale resurrection and independent runtime wrappers still permit duplicate/stale execution. |
| Minor 1: retained backup cleanup/restoration error omits artifact | **RESOLVED** | `CapBackupGuard` cleanup/restoration/conflict errors now include the relative path. Minor 1 above identifies separate recovery-open/identity error paths. |

The fix-2 final-interval byte-loss finding remains resolved by incompatible Windows sharing and live-handle reads. The fix-2 post-quarantine preservation finding is resolved for the save protocol itself but is **PARTIAL overall** because startup recovery can delete through an unauthenticated reparse/identity match. The fix-1 selected-root identity finding remains resolved.

## Additional Adjudication

- **Windows access/share modes:** PASS for local Windows. Target is opened with `FILE_GENERIC_READ | DELETE` and `FILE_SHARE_READ`; temp with `FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE` and `FILE_SHARE_READ`. Existing incompatible writers make the save fail before mutation, and live editor handles exclude later write/delete/rename access.
- **`NtSetInformationFile` ABI/layout/status/no-replace:** PASS for the declared `x86_64-pc-windows-msvc` local target, subject to Important 3. `windows-sys` is exactly 0.61.2 with the required WDK/IO features; the buffer is aligned and at least `sizeof(FILE_RENAME_INFORMATION) + FileNameLength`; `RootDirectory` is the capability handle; `ReplaceIfExists` is false; negative `NTSTATUS` values are converted through `RtlNtStatusToDosError`. The API reports `STATUS_SUCCESS` or an error for this information class, so treating nonnegative status as `NT_SUCCESS` is correct. Microsoft documents the structure, access, buffer, and no-replace rules here: [FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information).
- **Handle identity through rename and final hash:** PASS. The same checked target handle becomes the backup, the same synchronized temp handle becomes the target, and the returned revision is read from that temp handle. Its sharing mode prevents displacement/content mutation after the hash and before return.
- **Backup disposition semantics:** PASS. Handles request `DELETE`; `FileDispositionInfo` is the exact fixed-size buffer; after successful disposition the code only closes/drops the handle. Hard-link cleanup leaves the target link, while a single-link backup is removed on close.
- **Post-quarantine failure/crash behavior:** PASS for the save protocol, subject to recovery findings. Explicit faults restore or retain original bytes. A crash before install leaves a restorable backup; a crash after install leaves target plus distinct backup and recovery refuses to delete either. Unauthenticated temp artifacts are retained.
- **Non-Windows mutation boundary:** PASS in production. Conditional replacement returns `unsupported` before creating a temp or quarantining the target; backup recovery returns `unsupported` without rename/delete; temp recovery retains the artifact. See Minor 2 for tests.
- **Close lifecycle and watch replacement:** PASS. Same-lease redelivery, double-transport retry, failed-withdraw listener retention, exact current generations, nonblocking watch replacement, pending public completion, and listener-failure reporting are covered and coherent.
- **Schemas, permissions, dependencies, licenses:** PASS. DTOs remain exact/deny-unknown with lowercase branded identifiers. The sole capability remains event listen/unlisten; no shell/fs/window-close authority or `app.capabilities` was added. No version or lockfile changed; `windows-sys` remains exactly 0.61.2 under MIT OR Apache-2.0, with only feature modules added.
- **Browser fallback and Task 16 boundary:** PASS. Production creates one normal runtime, browser startup still uses `BrowserHost`, and no FileWorkflow/CommandRegistry/shortcut implementation crossed into Task 15. The Task 16 ownership interfaces remain narrow and unbound file commands remain disabled.

## Verification

- Focused Task 15 TypeScript: 4 files / 79 tests passed.
- Focused atomic replacement: 14 tests passed.
- `npm test -- --run`: 40 files / 602 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 69 tests passed; doc tests passed.
- `npm run test:e2e`: 13 tests passed.
- `npx tsc --noEmit` and `npm run build`: passed; existing chunk-size advisory only.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`: passed.
- `git diff --check 515f25e..6c423e4`: passed.
- `git apply --check --reverse -- .superpowers/sdd/2026-08-15-uxml-editor/review-515f25e..6c423e4.diff`: passed.

The review environment has Node 25.2.1, outside the repository's declared Node 24.x range. The plan's `npm run typecheck` and `scripts/check-licenses.mjs` commands are not present; the actual build TypeScript command and the round-4 manifest/license delta were checked directly.

NEEDS FIXES
