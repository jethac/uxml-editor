# Task 15 Report: Desktop Host, Scoped Permissions, Menus, and Recent Projects

## Status

Implemented on `agent/uxml-editor` from base `a139972`. The desktop runtime now uses a real `TauriHost`; the browser runtime continues to use `BrowserHost`. Rust is the sole filesystem authority, native operations are limited to the current directory-picker grant, and desktop menu/close events terminate in typed, tested frontend controllers.

## Fix Round 4 Addendum (2026-08-16)

This addendum records the accepted fixes from `task-15-fix-3-review.md` after commit `515f25e`. It supersedes conflicting earlier statements about pathname-based quarantine/installation, temporary-artifact deletion, one-shot close delivery, watch retirement completion, and overlapping menu listeners. Full behavioral RED/GREEN evidence is in `task-15-fix-4-report.md`.

### Windows replacement and recovery

- Windows opens the checked target with `FILE_GENERIC_READ | DELETE` and the editor temporary with `FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE`; both use only `FILE_SHARE_READ`. The live handles therefore exclude writable/delete/rename handles throughout their protocol.
- The checked target handle is renamed no-replace to a unique backup name relative to the granted capability directory. The same handle is rehashed after that rename, and the deterministic final-interval hook runs after this hash.
- The synchronized temporary handle is renamed no-replace to the destination relative to the same directory handle. The result is hashed through that installed handle while sharing remains exclusive. A post-result hook proves a competing rename/replacement cannot displace the destination before return.
- Root-relative handle rename uses `NtSetInformationFile(FileRenameInformation)` with the grant directory handle as `RootDirectory` and `ReplaceIfExists = false`. The documented Win32 `SetFileInformationByHandle(FileRenameInfo)` form was tried first but returned `ERROR_INVALID_PARAMETER` with a non-null `RootDirectory` on the supported Windows target. The native operation preserves the required handle-bound, capability-relative semantics.
- The backup is marked deleted through its own `DELETE`-capable handle using `SetFileInformationByHandle(FileDispositionInfo)` only after result verification and the final fallible metadata step. No fallible or destructive step follows successful backup disposition. Temporary cleanup also uses the owning handle, so a raced pathname cannot be removed by a guard.
- A destination or backup-name competitor is never overwritten. Before installation, the original is restored by no-replace handle rename when safe; otherwise its relative backup artifact is retained and surfaced. After installation, both result and original remain available on every injected failure.
- Non-Windows replacement remains typed `unsupported` before mutation. Tauri advertises `best-effort-safe-write` only on Windows and `unsupported` elsewhere; no portable hash-CAS claim is made.
- Recovery never trusts an artifact name as proof of temporary ownership. Matching `.tmp` files are retained and surfaced. An absent target is restored by no-replace handle rename of the backup; target-plus-backup is cleaned only when live handle identity proves both names refer to the same file. Different identities remain surfaced. Recovery is repeatable after interruption and reports only relative artifact names.

### Close, watch, and menu generations

- Rust redelivers the exact pending close lease and lifecycle generation on each later native close attempt. If both resolve and abandon transports fail, the TypeScript controller clears its processing state, reports both failures, and retries the same lease on redelivery.
- Lifecycle withdrawal is exact-generation and retryable. The close listener remains attached until native readiness withdrawal succeeds; startup/disposal failures expose typed completion and retry handles. A failed old withdrawal cannot clear or resolve a newer generation.
- Project replacement still deactivates and unlistens watches synchronously and does not await an active callback. Public watch completion now remains pending for the callback captured at retirement and reports its later rejection; queued callbacks remain suppressed.
- Frontend command listeners share a generation gate per desktop runtime. A listener retained after a failed old disable remains functional while it has no successor, becomes inert immediately when a newer generation registers, and is removed only after exact disable succeeds. Save, Edit, and View overlap regressions execute exactly once on the current owner.

### Round 4 verification

- Focused Task 15 TypeScript: 6 files / 131 tests.
- Focused Rust replacement/scoped/desktop: 45 tests.
- `npm test`: 40 files / 602 tests.
- `npm run build`: passed, 1,889 modules transformed.
- `npm run test:e2e`: 13 passed.
- Cargo fmt/check/strict clippy: passed.
- `cargo test`: 69 passed; doc tests passed.
- `npx tauri build --no-bundle`: passed; the rebuilt 10,074,112-byte release executable remained live for the five-second hidden smoke.
- `npm audit --omit=dev`: 0 vulnerabilities. Exact dependency/license/notice, capability, forbidden-surface, review-hash, and diff audits passed.

Round 4 changes only the enabled `windows-sys` API feature set; versions, lockfiles, notices, CSP, the two event-only capability permissions, exact DTO validation, one-host ownership, and browser fallback are unchanged. The accepted review artifact is unchanged at SHA-256 `105F694D92A19CD3E6BD87150B0FFCED1DA14B5E14F3DA4A2D823F3A4B44434F`.

## Fix Round 3 Addendum (2026-08-16)

This addendum records the accepted fixes from `task-15-fix-2-review.md` after commit `7425b18`. It supersedes conflicting round-2 statements below about cross-platform safe-write availability, quarantine cleanup, Task 16 lease semantics, boolean close readiness, listener-origin watch draining, and menu rollback/disposal. Full RED/GREEN evidence and verification are in `task-15-fix-3-report.md`.

### Replacement and recovery

- Tauri starts with `atomicReplace: "unsupported"` and negotiates the exact native value in the project-selection DTO. Windows publishes `best-effort-safe-write`; non-Windows remains `unsupported` and rejects before creating temp/quarantine artifacts.
- Windows holds checked handles without `FILE_SHARE_WRITE`. An existing writable handle prevents acquisition and the final hook does not run. No claim is made that those handles coexist.
- Quarantine creation is a capability-relative no-replace hard link followed by removal of the original name. The deterministic hook runs after the final quarantine hash. Destination creation never overwrites an external entry.
- Every post-quarantine error restores an absent target or retains a relative surfaced recovery artifact. Backup Drop never removes the only original. Temp cleanup precedes quarantine cleanup, which is the last fallible destructive step.
- Project acquisition restores target-absent backups, surfaces target-plus-backup conflicts without deletion, safely removes completed temps, and retains target-absent temps. Recovery occurs through the acquired directory capability before grant publication.

### Close, watch, and menus

- Task 16 now owns `runExclusiveCloseState`; final validation and native resolution execute inside its edit-blocking callback. The controller cannot validate and then await destruction outside owner exclusivity.
- Close readiness/events/resolution use exact monotonic lifecycle generations. Stale StrictMode completion/disposal is ignored. Resolution failure is reported and the exact lease/generation is abandoned so later close requests recover.
- Project replacement synchronously invalidates every frontend watch and drops queued events without awaiting already-invoked listener promises. Post-yield `chooseProject()` cannot self-deadlock; multi-listener tests prove queued old work never starts after publication.
- File-menu transitions use exact workflow generations. Rust captures all three prior states and rolls back a partial native failure. Frontend disposal disables before removing listeners; disable failure keeps handlers active and exposes reported completion plus retry. Stale cleanup cannot disable a newer binding.

### Corrected verification totals

- `npm test`: 40 files / 594 tests.
- focused Task 15 TypeScript: 6 files / 123 tests.
- `npm run build`: passed, 1,889 modules transformed.
- `npm run test:e2e`: 13 expected, 0 unexpected.
- Cargo fmt/check/strict clippy: passed.
- `cargo test`: 61 passed; doc tests passed.
- `npx tauri build --no-bundle`: passed; rebuilt executable smoke passed with title `UXML Editor`.
- `npm audit --omit=dev`: 0 vulnerabilities; capability/license/forbidden/diff audits passed.

The accepted review artifact is unchanged at SHA-256 `7C3DC51B378D0C3A92B4510C5BBF5BC3E98B50528776456B0F9C92177FA70AEB`.

## Fix Round 2 Addendum (2026-08-16)

This addendum records the accepted fixes from `task-15-fix-1-review.md` after commit `1537863`. It supersedes conflicting statements below and in the fix-round-1 addendum about selected-root acquisition order, overwrite-rename replacement, Tauri atomic-replace capability, Task 16 dirty hooks, close-listener startup, watch startup retirement, menu transactionality, and dropped asynchronous failures. Full RED/GREEN evidence is in `task-15-fix-2-report.md`.

### Authority and replacement

- Selected-root authority is acquired first as `cap_std::fs::Dir`. Type is validated from that handle; ambient canonical display/project-ID work is accepted only after Unix device/inode or Windows handle-path identity matches the opened object. A selection-time root replacement cannot redirect authority.
- Replacement moves the checked target into a capability-relative same-directory quarantine, revalidates it in the final interval, and installs the editor temporary with capability-relative no-replace hard-link semantics. A competing target entry is preserved and causes conflict. Existing-writer bytes are excluded or restored in deterministic platform tests.
- Ordinary temp/quarantine artifacts are removed before the final metadata flush. If competing bytes cannot be automatically restored because another target exists, the `.bak` conflict artifact is retained and identified in the relative typed error; native watch filtering ignores it.
- Tauri now reports `atomicReplace: "best-effort-safe-write"`. No portable linearizable hash-CAS is claimed for an adversarial non-Windows writer mutating an already-open quarantined inode after final revalidation.

### Close, watch, and menu lifecycle

- `Task16FileLifecyclePort` is now an explicit document-state generation lease: acquire `{ generation, dirtyState }`, final-validate, release, and save under that lease. The controller holds it through native close/cancel resolution. Edits after clean, Discard, or post-save decisions invalidate close.
- Rust close delivery starts not ready. `desktop_set_lifecycle_ready({ ready })` is published only after the frontend close listener exists. Early close creates no lease; failed native emit cancels its exact lease; disposal withdraws readiness.
- Pending watch startup joins the frontend retirement set before any await. Successful grant replacement invalidates pending/established watches and queued old events. A listener-originated `chooseProject()` skips only its own delivery drain, preventing self-deadlock while unrelated replacement still drains.
- App enables Save/Save All/Close Project only after lifecycle and command listeners are ready, and restores disabled state on startup failure/disposal. Rejected Task 16 commands reach `desktop.errors.report` without escaping native callbacks.
- Tauri timers/watch listeners and `ExternalChangeCoordinator` contain async failures. Listener, debounce, read, rescan, and native stop failures are observable through the production error sink or preserved `Disposable.completion` through `SaveCoordinator.watch()`.

### Corrected verification totals

- `npm test`: 40 files / 585 tests.
- `npm run build`: passed, 1,889 modules transformed.
- `npm run test:e2e`: 13 passed.
- `cargo fmt --check`, `cargo check`, and strict `cargo clippy`: passed.
- `cargo test`: 52 passed; doc tests passed.
- `npx tauri build --no-bundle`: passed; rebuilt executable stayed live with title `UXML Editor` in smoke.
- `npm audit --omit=dev`: 0 vulnerabilities. Exact capability/license/forbidden-surface audits and `git diff --check` passed.

No dependency, lockfile, notice, CSP, capability permission, exact ID/DTO validation, browser fallback, or one-host ownership changed in fix round 2. The accepted review artifact is included unchanged with SHA-256 `149098D60B8CBA93453A89760EFD71202845265665B358666530F24AFF2B4277`.

## Fix Round 1 Addendum (2026-08-16)

This addendum records the accepted review fixes implemented after commit `c1d68cc`. It supersedes conflicting statements below about ambient canonical-path enforcement, request/event schemas, close authorization, menu defaults, runtime host construction, capability count, test totals, and portable atomic-CAS guarantees. The complete evidence is also recorded in `task-15-fix-1-report.md`.

### Hardened authority model

- `cap-std` 4.0.2 now owns multi-component project traversal. Rust retains a `cap_std::fs::Dir` for the selected canonical root and performs enumeration, reads, target opens, temporary creation, and replacement relative to that handle. Deterministic directory-swap coverage proves an intermediate symlink/reparse replacement cannot redirect a read outside the grant.
- Selection is prepare/retire/install. A failed picker or invalid directory leaves the old grant and watches intact. A successful selection drains native watcher callback gates before publishing the new grant.
- The stable project ID remains `project:v1:<64 lowercase hex>`. Every filesystem/watch request and event additionally carries a current-session `grant:v1:<16 lowercase hex>`. TypeScript preserves that generation in a non-enumerable root/path brand, so reselecting the same stable project invalidates old frontend roots without exposing the token in ordinary HostPort snapshots.
- Project, grant, revision, watch, and close identifiers are validated with exact lowercase grammars in both Rust serde DTOs and TypeScript IPC parsing. Unknown fields remain denied.

### Atomic replacement guarantee

- Project replacement uses capability-relative opens and same-directory rename. A unique sibling temporary is written and synchronized before the target is checked.
- Windows opens and holds the checked target with `FILE_SHARE_READ | FILE_SHARE_DELETE`, denying newly opened writers through the check/commit interval while allowing replacement. The target is re-opened and hash-checked immediately before capability-relative rename. The deterministic external-writer test proves the writer is either prevented or its bytes are preserved; the resulting revision is confirmed.
- Non-Windows also revalidates immediately before same-directory rename and synchronizes directory metadata. This is not claimed as a portable linearizable content-hash CAS: a non-cooperating writer can still race after the final hash check and before rename. No in-place truncation occurs, and all temporary artifacts are RAII-cleaned on failure.

### Watch and lifecycle corrections

- Watch normalization hashes changed files through the granted `Dir`, carries the grant token, filters editor artifacts, deduplicates revisions, and drains callback gates on replacement/disposal. Native backend errors emit `{ kind: "rescan-required", watchId, projectId, grant }`; `ExternalChangeCoordinator` debounces that signal into a rescan of every saved open file.
- Tauri watch disposal is synchronous for listener activity and exposes a `completion` promise. A native stop error resolves to `{ status: "failed", error }` instead of being swallowed.
- Native close requests now emit `{ lease: "close:v1:<16 lowercase hex>" }`. The same lease passes through Task 16 dirty/save hooks. One `desktop_resolve_close({ lease, action })` command consumes it; approved closes use backend `destroy()` and therefore leave no separable or stale close permit.
- `file.save`, `file.save-all`, and `file.close-project` start disabled. `desktop_set_file_workflow_enabled({ enabled })` updates exactly those three items. App binds them only when a real Task 16 lifecycle port exists and reports menu/listener startup failures through the injected error port.
- Production bootstrap creates one `TauriHost` and passes that exact instance to `EditorStore`. Browser bootstrap remains `BrowserHost`-based and testable.

### Corrected schemas

Filesystem/watch requests now use:

- enumerate/start watch: `{ projectId, grant }`
- read: `{ projectId, grant, relativePath }`
- replace: `{ projectId, grant, relativePath, expectedRevision, text }`
- stop watch: `{ projectId, grant, watchId }`

Project selection returns `{ projectId, displayName, grant }`. Changed/deleted watch events include `watchId`, `projectId`, and `grant`; rescan-required omits path/revision. Recovery and recent-project records continue to use the stable project ID only and never restore authority. Close uses `desktop_resolve_close({ lease, action: "close" | "cancel" })`; file menu ownership uses `desktop_set_file_workflow_enabled({ enabled })`.

### Corrected capabilities and dependencies

- `src-tauri/capabilities/main.json` now contains exactly `core:event:allow-listen` and `core:event:allow-unlisten`. `core:window:allow-close` was removed because close authority is backend-owned.
- There is no shell plugin/permission, broad filesystem permission/glob, frontend command execution, arbitrary path IPC, or explicit `app.capabilities` key.
- Added exact `cap-std = 4.0.2`, license `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`, with lockfile and notice updates. Existing `@tauri-apps/api` remains exactly 2.11.1, `tauri` 2.11.5, `tauri-build` 2.6.3, and CLI 2.11.4.

### Final fix-round verification

- `npm test`: exit 0, 40 files / 571 tests.
- `npm run build`: exit 0, TypeScript plus Vite production build.
- `npm run test:e2e`: exit 0, 13 tests.
- `cargo fmt --check`: exit 0.
- `cargo check --manifest-path src-tauri/Cargo.toml`: exit 0.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: exit 0.
- `cargo test --manifest-path src-tauri/Cargo.toml`: exit 0, 47 tests.
- `npx tauri build --no-bundle`: exit 0; rebuilt release executable produced.
- Release smoke: exit 0; process stayed live with title `UXML Editor` and was then terminated by the harness.
- `npm audit --omit=dev`: exit 0, 0 vulnerabilities.
- Exact capability/dependency audits and `git diff --check`: exit 0.

The real directory picker and native Save/Discard/Cancel dialog were not interactively automated in this fix round. The rebuilt executable/window smoke passed, while injected TypeScript ports and Rust command/state fixtures cover those native boundaries. The existing Vite large-chunk advisory remains non-blocking.

## Architecture and Security Model

### Runtime boundary

- `createProductionTauriRuntime` detects Tauri through the runtime marker and wires official `@tauri-apps/api` `invoke`, `listen`, and current-window APIs into injected ports.
- `createRuntimeEditorStore` constructs `TauriHost` only in Tauri and constructs the existing `BrowserHost` in browser/test contexts. Browser layout storage and initial viewport behavior are preserved.
- `TauriHost` implements the existing `HostPort`; it does not introduce a second persistence model. Recovery, recent projects, revisions, snapshots, scheduling, dialogs, and watches retain the established contracts.
- Every untrusted IPC response is shape-checked before branded values are created. Exact object keys, SHA-256 revision syntax, safe integer timestamps, recent ordering/bounds/deduplication, normalized paths, watch identity, dialog decisions, and void responses are validated. Returned roots, paths, capabilities, read results, recents, and disposables are immutable snapshots.

### Filesystem authority

- `host_choose_project` is the only command that receives a user-selected directory. The Rust dialog backend returns the chosen path directly to managed Rust state; the frontend receives only `{ projectId, displayName }`.
- Managed `ScopedProjects` state contains one canonical current-session root. A successful replacement atomically installs the new grant and then stops all old watches; a failed replacement preserves the prior grant and watcher. Old project IDs fail with `root-not-granted` after success.
- Ordinary commands accept only a project ID and a normalized relative path. No ordinary command accepts or returns an absolute root path, including through filesystem or watcher error messages.
- Relative paths reject empty input, NUL, backslashes, leading separators, colon/scheme/drive ambiguity, empty segments, `.` segments, and parent segments. Enumeration and access reject symlinks and Windows reparse points, canonicalize targets, enforce canonical containment, reject non-files, and reject duplicate or case-colliding enumeration results.
- Project IDs are opaque `project:v1:<sha256>` identifiers derived inside Rust from the canonical root. Recent metadata may mention an old ID but never installs a grant; recovery access also requires the current grant.

### Atomic replacement

- Content revisions are exact `sha256:v1:<64 lowercase hex>` hashes of file bytes.
- Replacement creates a unique sibling with `create_new`, writes exact UTF-8 bytes, flushes the temporary file, compares the current target revision under a process-wide writer lock, and never truncates the destination.
- Windows uses `ReplaceFileW(..., REPLACEFILE_WRITE_THROUGH, ...)` for correct existing-destination semantics. Non-Windows uses same-directory `rename` and then synchronizes the parent directory. The resulting target revision is reread and compared with the requested bytes.
- RAII cleanup removes temporary artifacts on stale revisions, injected precommit failures, write/flush failures, and replacement failures. No backup artifact is created.

### Watches

- Rust uses `notify` recursively under the canonical current grant. Every event includes its watch ID and project ID.
- Events are canonicalized, normalized to `/` relative paths, revision-hashed, deduplicated by path/revision, and filtered for editor-owned `.tmp`/`.bak` siblings. Rename-style atomic writes resolve to a final target change.
- The TypeScript adapter buffers native events emitted during watcher startup until the authoritative watch ID arrives, then validates and drains them before `watch()` resolves.
- A callback gate makes disposal synchronous with in-flight normalization. Rust stops the watcher and frontend listeners fail closed immediately, so no callback is delivered after disposal. Selecting another project stops all prior watches, and both Rust and TypeScript reject cross-project events.

### App-data

- Recovery records and the recent-project store live only below Tauri's app-data directory. Project roots are never used for journals.
- Both formats are JSON version 1 records with `deny_unknown_fields` and validated project IDs. Recent entries validate names/timestamps, are newest-first, deduplicated, and capped at 10.
- App-data writes use unique sibling temporaries, file flush, failure-safe replacement, parent metadata flush where supported, and cleanup on failure.

### Menus and lifecycle

- Rust creates native File, Edit, and View menus with stable IDs. Only allowlisted IDs emit `uxml://menu-command` with `{ commandId }`.
- `DesktopCommandBridge` validates that payload and delegates to `EditorDesktopCommandController`, which uses the current store commands for open, undo, redo, zoom, and pane selection. Save/save-all/close are narrow typed hooks, not a duplicate command registry.
- Native close requests are intercepted by a one-use Rust `CloseGate` and emitted as `uxml://close-requested`. `DesktopLifecycleController` owns clean/dirty/unknown decisions over injected dirty, save, confirm, and window ports. Save, Discard, Cancel, save failure/cancellation, post-save dirty races, duplicate requests, window-close failure, and disposal are covered.
- The unbound App state reports `clean` only when no document session exists. An open session without Task 16 ownership reports `unknown` and is prevented from closing; it is not represented as clean.

## Command and Event Schemas

All request DTOs use camelCase plus `deny_unknown_fields` where deserialized. Tauri wraps command parameters as `{ request: ... }`.

| Command | Request | Result |
| --- | --- | --- |
| `host_choose_project` | none | `null` or `{ projectId, displayName }` |
| `host_enumerate_files` | `{ projectId }` | `{ relativePaths: string[] }` |
| `host_read_text` | `{ projectId, relativePath }` | `{ text, revision }` |
| `host_replace_text` | `{ projectId, relativePath, expectedRevision, text }` | `{ revision }` |
| `host_start_watch` | `{ projectId }` | `{ watchId }` |
| `host_stop_watch` | `{ watchId }` | void |
| `host_read_recovery` | `{ projectId }` | `{ journal: string | null }` |
| `host_write_recovery` | `{ projectId, journal }` | void |
| `host_clear_recovery` | `{ projectId }` | void |
| `host_list_recent_projects` | none | `[{ projectId, displayName, lastOpenedAt }]` |
| `host_remember_recent_project` | `{ projectId, displayName }` | void |
| `host_confirm` | `{ kind, title, message, confirmLabel, cancelLabel }` | `{ confirmed }` |
| `host_show_message` | `{ kind, title, message }` | void |
| `desktop_confirm_close` | none | `"save" | "discard" | "cancel"` |
| `desktop_authorize_close` | none | void |
| `desktop_revoke_close_authorization` | none | void |

Events:

- `uxml://file-change`: changed `{ watchId, projectId, kind: "changed", relativePath, revision }`; deleted `{ watchId, projectId, kind: "deleted", relativePath }`.
- `uxml://menu-command`: `{ commandId }`, where the ID is one of `file.open-project`, `file.save`, `file.save-all`, `file.close-project`, `edit.undo`, `edit.redo`, `view.zoom-in`, `view.zoom-out`, `view.pane-hierarchy`, `view.pane-inspector`, `view.pane-diagnostics`, or `view.pane-source`.
- `uxml://close-requested`: no payload contract; it is a close-attempt signal only.

Errors serialize as `{ code, message }` and map to existing `HostError` codes. Unknown/malformed native errors use the operation-specific fallback code.

## Changed Files

### TypeScript runtime and host

- `src/core/host/HostPort.ts`
- `src/core/host/TauriHost.ts`
- `src/core/host/TauriHost.contract.test.ts`
- `src/app/createRuntimeEditorStore.ts`
- `src/app/createRuntimeEditorStore.test.ts`
- `src/app/createProductionTauriRuntime.ts`
- `src/app/TauriRuntime.ts`
- `src/app/TauriRuntime.test.ts`
- `src/main.tsx`

### Desktop command and lifecycle boundary

- `src/core/desktop/DesktopCommandBridge.ts`
- `src/core/desktop/DesktopCommandBridge.test.ts`
- `src/core/desktop/DesktopLifecycleController.ts`
- `src/core/desktop/DesktopLifecycleController.test.ts`
- `src/app/App.tsx`
- `src/app/App.desktop.test.tsx`

### Rust authority and desktop integration

- `src-tauri/src/lib.rs`
- `src-tauri/src/error.rs`
- `src-tauri/src/scoped_fs.rs`
- `src-tauri/src/atomic_save.rs`
- `src-tauri/src/watch.rs`
- `src-tauri/src/app_data.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/desktop.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json` (removed)
- `src-tauri/capabilities/main.json` (minimal replacement)

### Dependencies and notices

- `package.json`
- `package-lock.json`
- `THIRD-PARTY-NOTICES.md`

`src-tauri/tauri.conf.json` preserves the restrictive CSP and now explicitly labels the sole window `main`, matching `capabilities/main.json`. Tauri 2 automatically includes the sole capability file; adding the newer explicit `app.capabilities` selector was rejected by the pinned `tauri-build` schema and was not retained.

## TDD Record

Behavioral RED was recorded before each production slice. Import-only failures were not used as the sole evidence.

| Slice and command | RED | GREEN |
| --- | --- | --- |
| Shared host contract, `npm test -- src/core/host/TauriHost.contract.test.ts` | exit 1: 13 failed, 6 passed | exit 0: 19 passed; later validation cases also green |
| Desktop command/lifecycle controllers, focused Vitest command | exit 1: 15 failed, 1 passed | exit 0: 16 passed |
| App desktop binding/capability behavior, focused Vitest command | exit 1: 3 failed, 19 skipped | exit 0: 3 passed |
| Tauri runtime serialization, `npm test -- src/app/TauriRuntime.test.ts` | exit 1: 6 failed | exit 0: 6 passed |
| Atomic replacement, `cargo test --manifest-path src-tauri/Cargo.toml atomic_save::tests` | exit 101: 5 failed | exit 0: 5 passed |
| Scoped grants/paths, `cargo test --manifest-path src-tauri/Cargo.toml scoped_fs::tests` | exit 101: 5 failed | exit 0: 5 passed |
| App-data formats/replacement, `cargo test --manifest-path src-tauri/Cargo.toml app_data::tests` | exit 101: 4 failed, 1 passed | exit 0: 5 passed |
| Watch normalization/disposal, `cargo test --manifest-path src-tauri/Cargo.toml watch::tests` | exit 101: 4 failed, 2 passed; first fix still 3 failed, 3 passed on Windows canonical paths | exit 0: 6 passed |
| Rust menu/close behavior, `cargo test --manifest-path src-tauri/Cargo.toml desktop::tests` | exit 101: 4 failed | exit 0: 4 passed |
| Rust command fixtures/schemas, `cargo test --manifest-path src-tauri/Cargo.toml commands::tests` | exit 101: 3 failed, 1 passed | exit 0: 4 passed |
| Generic dialog confirmation edge case, focused Rust desktop test | exit 101: 1 failed | exit 0: 1 passed |
| Recent metadata authority rejection, focused Rust command test | exit 101: 1 failed | exit 0: 1 passed |
| Oversized native recent list, focused TauriHost test | exit 1: 1 failed | exit 0: 1 passed |
| Unsafe native recent timestamps, focused TauriHost parameterized test | exit 1: 2 failed | exit 0: 2 passed |
| Failed native close authorization rollback, focused TypeScript and Rust tests | exit 1: 1 failed in each runtime | exit 0: both passed |
| Browser viewport regression, `npm run test:e2e` | exit 1: 12 passed, 1 failed | focused unit 4 passed and focused E2E 1 passed; final full E2E green |
| Watch startup delivery race, focused `TauriHost` contract test | exit 1: expected one change, received none | exit 0: 25 focused contract tests passed |
| Failed project replacement watcher loss, focused Rust command test | exit 101: watcher count was 0 instead of 1 | exit 0: replacement regression tests passed |
| Absolute-path disclosure, focused Rust command/watch tests | exit 101: project root and watcher path appeared in errors | exit 0: both redaction regressions passed |
| Explicit native window/capability label, focused Rust config test | exit 101: label was absent | exit 0: `main` label assertion passed |

Baseline before implementation: Rust had 0 tests. The baseline npm run produced 509/510 passing with one `InspectorPanel` timeout; that test passed 1/1 in isolation and the final full suite passed.

## Final Verification

| Command/check | Result |
| --- | --- |
| Focused host/runtime/lifecycle Vitest run | exit 0, 9 files and 85 tests passed |
| `npm test` | exit 0, 40 files and 561 tests passed |
| `npm run build` | exit 0, TypeScript and Vite build passed; 1,892 modules transformed |
| `npm run test:e2e` | exit 0, 13 Playwright tests passed |
| `cargo check --manifest-path src-tauri/Cargo.toml --all-targets` | exit 0 |
| `cargo fmt --check` | exit 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | exit 0; an earlier cleanup run reported two diagnostics, both corrected before this run |
| `cargo test --manifest-path src-tauri/Cargo.toml` | exit 0, 38 tests passed |
| `npx tauri build --no-bundle` | exit 0; release executable produced at `src-tauri/target/release/uxml-editor.exe` |
| Release executable smoke | process remained live for 5 seconds with window title `UXML Editor`, then was terminated by the test harness |
| `npm audit --omit=dev` | exit 0, 0 vulnerabilities |
| Capability assertion and forbidden-term scan | exit 0, exactly 3 permissions and no shell/broad-fs/command-execution permission |
| Dependency tree audit | exit 0; `tauri-plugin-fs` appears only as a transitive type dependency of `tauri-plugin-dialog` and is neither initialized nor capability-granted |
| `git diff --check` | exit 0; only Git's existing Windows LF-to-CRLF notices were emitted |

## Dependencies and Licenses

- npm runtime: `@tauri-apps/api` exactly 2.11.1, Apache-2.0 OR MIT, integrity `sha512-M2FPuYND2m+wh5hfW9ZpSdxMPdEJovPBWwoHJmwUpysTYNHaOkVFN419m/K0LIgjb/7KU2vBgsUepJWugQCvAA==`.
- Rust/build: `tauri` exactly 2.11.5 and `tauri-build` exactly 2.6.3, Apache-2.0 OR MIT.
- Native dialog: `tauri-plugin-dialog` exactly 2.7.1, Apache-2.0 OR MIT.
- Watching: `notify` exactly 6.1.1, CC0-1.0.
- Serialization/hashing: `serde` 1.0.229, `serde_json` 1.0.151, and `sha2` 0.10.9, each MIT OR Apache-2.0.
- Windows replacement API: `windows-sys` exactly 0.61.2, MIT OR Apache-2.0.
- Transitive `tauri-plugin-fs` 2.5.1 is Apache-2.0 OR MIT. It is present through dialog-plugin types only and is not initialized or granted.

Versions are exact in the manifests and lockfiles. Notices and the npm integrity value are recorded in `THIRD-PARTY-NOTICES.md`.

## Capability Audit

The removed `core:default` capability was replaced by one `main` window capability containing only:

1. `core:event:allow-listen`
2. `core:event:allow-unlisten`
3. `core:window:allow-close`

There is no shell plugin, shell capability, command execution, frontend filesystem plugin initialization, filesystem glob, arbitrary path permission, or frontend dialog capability. Native dialogs and filesystem operations run only in registered custom Rust commands. Generated capability schema output contains the single `main` capability with the same three permissions. Existing production and development CSP values are unchanged.

## Task 16 Boundary

Task 15 intentionally does not implement the complete file workflow or unified `CommandRegistry`.

- `Task16FileCommandPort` exposes only `save`, `saveAll`, and `closeProject` to the current desktop controller.
- `Task16FileLifecyclePort` adds `getDirtyState` and `saveBeforeClose`, so Task 16 can bind `SaveCoordinator`/`FileWorkflow` ownership without replacing the native lifecycle controller.
- `DesktopCommandBridge` consumes stable native IDs through a single typed executor interface, allowing the future registry to become that executor without changing Rust menu events.
- Until that binding exists, an open session is `unknown` and close is blocked. This is the explicit tested hook proving the lifecycle boundary is complete without pretending no document is dirty.

## Self-Review

- Rechecked every detailed Task 15 requirement against source and tests.
- Confirmed ordinary IPC contains no absolute root or arbitrary path field.
- Confirmed grant replacement revokes old IDs and stops old watches.
- Confirmed exact CRLF/Unicode bytes, stale/concurrent revisions, precommit cleanup, Windows replacement, normalized/deduplicated watch events, disposal, app-data isolation, recent non-authority, schema rejection, listener cleanup, malformed IPC, menu IDs, and all close decisions have tests.
- Confirmed runtime wiring reaches `TauriHost` and browser tests continue through `BrowserHost`.
- Confirmed no plan, ledger, `UXML_GOAL.md`, downstream consumer, or unrelated source file was modified.

## Concerns

- Native UI automation was not available in this session, so the real directory picker, menu clicks, and Save/Discard/Cancel dialog were not driven interactively. The release executable/window smoke passed, and command fixtures plus injected frontend/Rust boundary tests cover those behaviors.
- Vite reports the existing large-chunk advisory for the approximately 828 kB editor bundle; the build succeeds and Task 15 does not add a new UI chunking boundary.
