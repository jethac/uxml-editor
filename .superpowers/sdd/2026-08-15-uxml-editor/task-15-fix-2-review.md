# Task 15 Fix Round 2 Review (`1537863..7425b18`)

Review only. No production code was changed and nothing was committed or pushed.

## Critical

1. **The true final save interval still silently destroys bytes from an already-open external writer.**

   `src-tauri/src/atomic_save.rs:177-220` hashes the quarantined target, installs the editor temp at the original name, validates only that new inode, and then unlinks the quarantine. On either Windows or non-Windows, a writer that opened the target before the editor's checked handles can write the quarantined inode after the hash at line 178. The editor then succeeds at lines 189-223 and line 220 removes the only name for the external bytes; they disappear when the writer closes. The Windows share mode at `src-tauri/src/atomic_save.rs:368-376` prevents later write opens but cannot revoke an existing handle's write access.

   The same loss occurs on conflict: if the existing writer changes the quarantine after line 178 and another writer creates the destination, `restore_or_retain_quarantine` takes the `retain_when_target_exists = false` branch at `src-tauri/src/atomic_save.rs:288-300` and removes the modified quarantine. The hook at `src-tauri/src/atomic_save.rs:172-179` runs before the final quarantine hash, so both new tests miss this actual hash-to-cleanup interval. `best-effort-safe-write` is a fair description of non-linearizable CAS only if admitted external bytes are preserved; this cleanup violates that condition.

2. **Post-quarantine failures are not failure-atomic and can delete the original or strand it without recovery.**

   After `quarantine_target` removes the destination at `src-tauri/src/atomic_save.rs:170`, any `?` failure opening or reading the quarantine at `src-tauri/src/atomic_save.rs:177-178` unwinds into `CapBackupGuard::drop`, which unconditionally removes the backup at `src-tauri/src/atomic_save.rs:522-526`. A transient read/share error therefore returns `replace-failed` with the original target absent and its backup deleted. Failures after the editor link is installed similarly return an error without rolling the target back at `src-tauri/src/atomic_save.rs:211-218`.

   A process failure between quarantine and installation instead leaves the target absent with hidden `.bak`/`.tmp` files, but there is no startup restoration or artifact registry and native watching suppresses those names at `src-tauri/src/watch.rs:134-140`. In addition, the quarantine "reservation" drops its placeholder before a replacing rename at `src-tauri/src/atomic_save.rs:242-256`; an external entry created in that interval is overwritten, so this part of the protocol is not no-replace. The existing fault tests stop before quarantine and do not cover any of these cases.

## Important

1. **The document lease contract still does not require or verify edit blocking through native destruction.**

   `src/app/App.tsx:39-43` exposes acquire, final-validate, release, and save hooks, but neither the type nor `DesktopLifecycleController` requires the owner to block or queue edits while the lease is held. After validation returns true at `src/core/desktop/DesktopLifecycleController.ts:145-149`, an edit can arrive while the asynchronous native resolution at `src/core/desktop/DesktopLifecycleController.ts:156-160` is pending; the window is destroyed and the lease is released only afterward at `src/core/desktop/DesktopLifecycleController.ts:136-141`. The new tests inject edits before final validation, not between final validation and native destruction. The unbound current-session path remains fail-closed, but the Task 16 binding contract is still insufficient to support the claimed guarantee without an explicit tested lease-blocking invariant.

2. **Close readiness is not generation-scoped, and failed close resolution can still wedge the native gate.**

   Production mounts `App` under React Strict Mode at `src/main.tsx:16-19`. An obsolete effect can finish `lifecycle.start()` at `src/app/App.tsx:94-101` after the replacement effect is ready, then dispose itself and call `setLifecycleReady(false)` at `src/core/desktop/DesktopLifecycleController.ts:54-66`. A controlled review test left one current close listener registered while the native readiness boolean was false, so every native close was prevented. The same stale false transition can clear a lease owned by the current generation.

   Separately, `src/core/desktop/DesktopLifecycleController.ts:156-163` swallows `resolveClose` rejection. If IPC fails before `desktop_resolve_close` runs, the pending lease remains in `src-tauri/src/desktop.rs:181-190`, later close requests return `Prevent`, and no error reaches `desktop.errors`. Initial-not-ready behavior and exact emit-failure cancellation are fixed, but readiness/disposal/resolution are not yet recoverable end to end.

3. **A reentrant watch callback still deadlocks after any asynchronous yield.**

   `src/core/host/TauriHost.ts:216-224` sets `invokingWatch` only for the synchronous portion of the listener call and restores it before awaiting the returned promise. If an async listener first awaits any work and then awaits `host.chooseProject()`, `chooseProject` captures no caller at `src/core/host/TauriHost.ts:63-65`; retirement then awaits that same listener's delivery at `src/core/host/TauriHost.ts:165-173`, while the listener awaits project replacement. A review-only reproduction confirmed the cycle. The committed test calls `chooseProject()` before its first suspension and therefore covers only the special synchronous reentry case. In-flight startup invalidation itself is fixed.

4. **File-menu disable/rollback is still not transactional.**

   `src/app/App.tsx:77-92` removes listeners before asynchronous disable completes, leaving enabled Save/Save All/Close items with no handler during rollback or disposal. Native mutation at `src-tauri/src/desktop.rs:263-282` updates three menu items sequentially and returns immediately on an intermediate `set_enabled` failure, with no rollback; one or more later items can remain enabled indefinitely after the listener has been removed. Obsolete effect cleanup can also race a newer generation's enable call because neither transition carries a generation. Enable-after-listen and rejected-command reporting are fixed, but disable and failure rollback still permit enabled no-ops.

## Minor

No Minor findings.

## Prior Finding Adjudication

| Fix 1 finding | Status | Adjudication |
| --- | --- | --- |
| Critical 1: selected-root acquisition identity | **RESOLVED** | The capability is opened first and Unix device/inode or Windows handle-final-path identity is checked against the ambient canonical result before installation. The authority stored is the opened object. |
| Critical 2: external-writer check/commit race | **OPEN** | Final destination no-replace prevents a competing path entry from being overwritten and the public guarantee is downgraded, but an existing writer can mutate the quarantine after the last hash and cleanup silently unlinks its bytes. Post-quarantine failures are also destructive. See Critical 1-2. |
| Important 1: document-generation close lease | **PARTIAL** | Acquire/validate/release hooks and clean/discard/save revalidation exist, but edit blocking through native destruction is neither contractual nor tested. See Important 1. |
| Important 2: startup/emit close wedge | **PARTIAL** | Native readiness defaults false and exact emit failure clears its lease, but stale frontend generations and swallowed resolution rejection can still disable or wedge close handling. See Important 2. |
| Important 3: watch startup generation and callback deadlock | **PARTIAL** | Pending watch startup is registered and retired before grant publication, but reentry after a listener suspension still self-deadlocks. See Important 3. |
| Important 4: menu readiness and rejected command promises | **PARTIAL** | Enable occurs after listener readiness and command rejections reach the error sink; disable/rollback remains non-transactional and generation-unsafe. See Important 4. |
| Important 5: watcher completion and debounce accountability | **RESOLVED** | `TauriHost` contains listener/timer rejection, reports it, and returns failed completion; `ExternalChangeCoordinator` preserves host stop completion and resolves read/rescan/consumer failures without an unhandled timer promise. |

The fix-1 resolved exact DTO/identifier validation and single-`TauriHost` ownership findings remain resolved.

## Additional Audits

- **Capabilities:** PASS. `src-tauri/capabilities/main.json` targets only `main` and grants exactly event listen/unlisten. No broad filesystem, shell, close-window, glob, or command-execution permission is present.
- **Capability-relative IPC:** PASS. Project filesystem requests remain project/grant/relative-path based with exact DTO and identifier grammars; no absolute path or arbitrary capability ID was added.
- **Browser fallback and host identity:** PASS. Browser startup still selects `BrowserHost`; Tauri bootstrap passes the one runtime-created `TauriHost` into the store.
- **Dependency/license:** PASS. No manifest, lockfile, or notice changed in this range; pinned versions and recorded licenses remain consistent.
- **Task 16 scope:** PASS with the Important 1 contract caveat. No FileWorkflow, CommandRegistry, shortcut, or downstream Task 16 implementation was added, and file commands stay disabled without a bound owner.
- **Capability claim:** FAIL. The label no longer claims linearizable atomic replacement, but `safe-write` still overstates the destructive quarantine cleanup in Critical 1-2.

## Verification

- `npm test`: 40 files, 585 tests passed.
- Focused Task 15 desktop/host/persistence tests: 6 files, 114 tests passed.
- Browser fallback/runtime tests: 2 files, 18 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 52 tests passed; doc tests passed.
- Focused atomic-save tests: 8 passed. Focused scoped-filesystem tests: 9 passed.
- `npm run build`: passed; only the existing large-chunk advisory remains.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`: passed.
- `npx tauri build --no-bundle`: passed and rebuilt the release executable.
- `git diff --check 1537863..7425b18`: passed.
- Two temporary review-only regressions reproduced the post-yield watch deadlock and stale StrictMode readiness withdrawal; the harness was removed before this review was written.

Passing committed tests do not exercise the post-final-hash quarantine interval, post-quarantine I/O/crash recovery, lease blocking through native destruction, stale StrictMode startup completion, async-after-yield watch reentry, or partial native menu failure described above.

NEEDS FIXES
