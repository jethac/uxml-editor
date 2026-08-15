# Task 15 Fix Round 3 Review (`7425b18..515f25e`)

Review only. No production code was changed and nothing was committed or pushed.

## Critical

1. **Windows replacement still performs destructive pathname operations after granting delete sharing, so a concurrent rename can delete a competitor or produce false success.**

   `src-tauri/src/atomic_save.rs:553-560` opens every checked file with `FILE_SHARE_DELETE`. That correctly excludes writable handles by omitting `FILE_SHARE_WRITE`, but Windows delete access also permits rename. The quarantine is then created from a pathname at `src-tauri/src/atomic_save.rs:405` and the same pathname is removed separately at `src-tauri/src/atomic_save.rs:421`; neither action is bound to the checked handle or followed by a file-identity comparison.

   Concrete quarantine interleaving: (1) line 405 hard-links checked file A to the backup; (2) an external process, permitted by every live checked handle's delete sharing, renames `Main.uxml` (A) away and creates competitor B at `Main.uxml`; (3) line 421 removes B, not A; (4) the quarantine hash still reads A through the backup handle, installation succeeds, and lines 376-380 remove the temp and original backup. The editor silently deletes the competing entry.

   There is a second false-success interval after `src-tauri/src/atomic_save.rs:346-352` hashes the installed result. An external process can rename that destination and create a competitor at the original name while `resulting_file` remains open because it also grants delete sharing. Lines 376 and 380 then destroy the temp and original recovery links, and line 381 returns the editor revision without revalidating the destination pathname. The caller is told the save succeeded while `Main.uxml` contains the competitor; the editor inode can be made delete-pending and disappear when the final handle closes. The path-only `CapTempGuard` and `CapBackupGuard` removals have the same replaced-name problem.

   The committed hooks do not enter either interval: the quarantine hook runs before line 405, and the commit hook runs before destination installation. A Windows spot-check confirmed that a read handle with exactly `FILE_SHARE_READ | FILE_SHARE_DELETE` can be renamed and replaced while continuing to read the old object. This matches Microsoft's documentation that `FILE_SHARE_DELETE` permits later delete access and that delete access includes rename: [CreateFile sharing modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea).

## Important

1. **Recovery can delete a raced or user-owned `.tmp` solely because its name matches the editor pattern.**

   `src-tauri/src/atomic_save.rs:715-731` treats every `.<target>.uxml-editor-<pid>-<counter>.tmp` as editor-owned and removes it whenever `<target>` exists. Concrete interleaving: an external process wins a candidate name just before `create_new` at `src-tauri/src/atomic_save.rs:524-537`; the save correctly skips that occupied name and succeeds with the next counter; on the next project acquisition, recovery sees the still-present target and deletes the external candidate at line 723. There is no registry, file identity, or content relation proving ownership. The test suite has backup restore/conflict fixtures, but no temporary recovery or collided-temp fixture.

2. **Absent-target backup recovery is not interruption-idempotent.**

   `src-tauri/src/atomic_save.rs:686-705` restores an absent target by hard-linking the backup and then removing the backup in a later operation. If the process stops after line 695 and before line 696, the next acquisition enters the target-present branch at lines 678-685 and reports a target/backup conflict, even though both names are links to the same restored object. The project remains ungrantable until manual cleanup. The target-present crash case preserves both byte sets, but the target-absent recovery path is not itself crash-recoverable.

3. **Close-gate recovery remains one-shot and can still wedge after transport failure.**

   `src/core/desktop/DesktopLifecycleController.ts:179-188` reports a rejected `resolveClose` and attempts one `abandonClose`; if both requests fail before reaching Rust, it only reports the second error. The original native lease remains pending, so `CloseGate::request` returns `Prevent` at `src-tauri/src/desktop.rs:229-230` and no later close event reaches the controller. A generation remount clears it, but there is no retry/reconciliation path in the live generation. Disposal has the analogous gap: `src/core/desktop/DesktopLifecycleController.ts:80-91` removes the listener before the one readiness-withdrawal request, and a pre-native withdrawal failure can leave Rust ready with no listener. Exact generation matching and single-failure abandonment are correct, but end-to-end recovery is still partial.

4. **Project replacement can resolve watch completion before an in-flight listener later fails.**

   Successful selection calls `retire(true, true)` at `src/core/host/TauriHost.ts:83`. The `skipDelivery` branch at `src/core/host/TauriHost.ts:173-203` does not await the current delivery chain and resolves the public `completion` as `disposed`. Concrete interleaving: a listener has yielded while its promise is pending; replacement retires the watch and its completion resolves `disposed`; the listener then rejects; lines 226-231 record and report the failure, but the already-settled completion cannot become `failed`. This regresses the previously resolved completion-accountability contract. The post-yield self-deadlock and queued old-grant delivery are fixed, and old branded roots fail after publication.

5. **A failed menu disable can leave an old command listener overlapping a newer workflow generation.**

   On disable failure, `src/app/App.tsx:110-123` intentionally retains all disposables, and cleanup at lines 150-153 has no automatic retry. Concrete StrictMode/effect-replacement interleaving: generation N is enabled; its cleanup disable fails or loses its response, so its `DesktopCommandBridge` remains active; generation N+1 registers another bridge and enables successfully; a native menu event has no workflow generation, so both listeners pass `src/core/desktop/DesktopCommandBridge.ts:55-59` and execute Save/Save All/Close Project twice, potentially against different Task 16 owners. Retrying the reported error eventually disposes the old bridge, and native stale-generation suppression correctly protects menu state, but listener lifetime is not generation-scoped.

## Minor

1. **Some retained backup failures do not identify the relative recovery artifact.**

   If final backup removal fails at `src-tauri/src/atomic_save.rs:380`, `CapBackupGuard::remove` builds the error at `src-tauri/src/atomic_save.rs:860-865` without `self.path`; the no-op `Drop` correctly retains the backup, but the surfaced error does not tell the user which relative artifact contains the original bytes. The same omission occurs when restoration succeeds but cleanup fails at lines 453-459. No reviewed recovery message disclosed the absolute selected root; this is missing relative disclosure, not absolute-path leakage.

## Prior Finding Adjudication

| Fix-2 open/partial finding | Status | Adjudication |
| --- | --- | --- |
| Critical 1: true final interval destroys bytes from an already-open writer | **RESOLVED** | `open_checked_target` omits `FILE_SHARE_WRITE`; Windows rejects acquisition while a writable handle exists. The final hook does not run. The new Critical 1 is a distinct delete-sharing/path-identity race. |
| Critical 2: post-quarantine failures delete or strand the original | **PARTIAL** | Explicit post-quarantine branches now restore or retain the backup, `CapBackupGuard::drop` is non-destructive, and startup recovery exists. Pathname replacement, unauthenticated temp cleanup, and interruption of recovery remain unsafe. |
| Important 1: close lease does not block edits through native destruction | **RESOLVED** | `runExclusiveCloseState` encloses dirty evaluation, confirmation/save, final validation, and awaited native resolution. Success and failure release through the owner's callback lifetime. |
| Important 2: lifecycle generation and failed close resolution wedge | **PARTIAL** | Exact monotonic generations fix stale StrictMode withdrawal, and one resolve failure triggers exact abandonment. Double transport failure and failed readiness withdrawal still have no live retry path. |
| Important 3: post-yield watch callback self-deadlocks | **RESOLVED** | Replacement no longer awaits an invoked listener, queued old events check `active`, and old branded roots are revoked. The separate completion regression is Important 4 above. |
| Important 4: file-menu disable/rollback is non-transactional | **PARTIAL** | Native menu transitions serialize by generation, capture prior states, and roll back already-mutated items. Failed frontend disable can still overlap an old listener with a newer generation, causing duplicate command execution. |

The fix-1 selected-root identity finding remains resolved. The fix-1 external-writer race is **PARTIAL** overall: writable-handle exclusion is correct, but delete-sharing rename interleavings remain. The fix-2 resolved watcher-completion finding is **REGRESSED** on automatic project replacement. Exact DTO/identifier validation and single-production-`TauriHost` ownership remain resolved.

## Additional Audits

- **Windows/non-Windows capability gating:** PASS. `TauriHost` begins at `unsupported`; the exact selection DTO negotiates the platform result; non-Windows Rust returns typed `unsupported` before temp/quarantine mutation.
- **CreateFile share exclusion:** PASS for writable handles. A local Windows check received sharing violation `0x80070020` when the checked read open was attempted against an existing read/write handle.
- **Backup guard and routine fault paths:** PASS with the findings above. `CapBackupGuard::drop` does nothing, and every explicit post-quarantine fault preserves original bytes at the target or backup. The remaining failures are pathname identity, recovery ownership/idempotence, and artifact discoverability.
- **Schemas:** PASS. Project selection, close request/readiness/resolution/abandonment, and workflow transition records are exact; Rust denies unknown fields and both sides enforce the specified lowercase token grammars.
- **Browser fallback and host identity:** PASS. Browser startup still selects `BrowserHost`; production creates one Tauri runtime host and injects that instance into the store.
- **Capabilities and permissions:** PASS. `main` has only event listen/unlisten; no filesystem/shell capability, broad glob, arbitrary-path IPC, close/destroy frontend permission, telemetry, or `app.capabilities` was added.
- **Dependencies and licenses:** PASS. No manifest or lockfile changed; the notice additions match pinned `@tauri-apps/cli` 2.11.4 and `tauri-build` 2.6.3.
- **Task 16 scope:** PASS. The change defines the exclusive lifecycle and file-command ownership interfaces but does not add FileWorkflow, CommandRegistry, shortcuts, or Task 16 behavior. Unbound open sessions remain fail-closed and file commands remain disabled.
- **Capability claim:** FAIL. `best-effort-safe-write` still overstates the Critical pathname races because a save can delete a competing entry or return success for bytes no longer at the destination.

## Verification

- Focused Task 15 TypeScript: 4 files, 71 tests passed.
- `npm test`: 40 files, 594 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 61 tests passed; doc tests passed.
- `npm run build`: passed; only the existing large-chunk advisory remains.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `git diff --check 7425b18..515f25e`: passed.
- `git apply --check --reverse review-7425b18..515f25e.diff`: passed, confirming the supplied review artifact matches the scoped working tree state.
- Windows share-mode spot-check: rename/replacement succeeded while the checked handle retained the old bytes; checked acquisition against an existing writable handle failed with `0x80070020`.

The passing committed tests do not exercise the hard-link-to-unlink quarantine interval, destination rename after the final result hash, collided temporary recovery, interruption during recovery itself, double resolve/abandon transport failure, post-retirement watch callback failure, or failed-disable overlap with a newer menu listener.

NEEDS FIXES
