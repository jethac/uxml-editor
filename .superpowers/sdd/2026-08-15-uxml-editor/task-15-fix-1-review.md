# Task 15 Fix Round 1 Review (`c1d68cc..1537863`)

Scope is limited to the requested commit range and its Task 15 interactions. No production code was changed.

## Critical

1. **The selected-root capability can still be redirected between validation and acquisition.**

   `src-tauri/src/scoped_fs.rs:91-119` canonicalizes the selected pathname, checks ambient metadata, and only then opens the capability with `Dir::open_ambient_dir`. A process that can rename the selected directory can replace `canonical` with a symlink/junction to an outside directory after `fs::metadata` returns but before `open_ambient_dir` resolves the pathname. The resulting grant authorizes the outside directory even though that was not the object validated for selection. The regression at `src-tauri/src/scoped_fs.rs:594-631` swaps `Assets` only after the root capability is already open, so it does not exercise this selection-time race. Bind validation to the opened directory object (including identity/type checks from that handle) rather than resolving the ambient pathname three separate times.

2. **Expected-revision validation is still not coupled to commit, so an external update can be lost.**

   The final target hash at `src-tauri/src/atomic_save.rs:157-164` is followed by a pathname-based rename at `src-tauri/src/atomic_save.rs:174-175` with no stable target identity check at commit. On non-Windows, a writer can update the target after line 164 and before line 174; the editor then renames over those bytes and returns success. The post-commit hash only verifies the editor's replacement and cannot discover the overwritten external update. On Windows, `FILE_SHARE_DELETE` at `src-tauri/src/atomic_save.rs:241-249` allows the checked object to be renamed away; another entry can be installed at the target pathname before the editor's rename, again leaving commit unbound from the object that was hashed.

   The deterministic hook at `src-tauri/src/atomic_save.rs:152-155` runs before the final revalidation, and the test at `src-tauri/src/atomic_save.rs:517-543` therefore cannot enter the final hash-to-rename interval. This is not failure-safe under the review's explicit exception: an admitted hostile writer can have its update erased without a conflict result. `src/core/host/TauriHost.ts:48-55` also advertises `atomicReplace: 'guaranteed'` on every Tauri target, while `.superpowers/sdd/2026-08-15-uxml-editor/task-15-fix-1-report.md:28` and `:241` acknowledge the non-linearizable interval and incorrectly characterize it as failure-safe. The implementation needs platform-appropriate exclusion/identity/rollback behavior that preserves a racing external update, or it must fail the operation and expose a weaker capability without overclaiming.

## Important

1. **The close lease is not a document-generation lease and can approve a stale cleanliness decision.**

   `src/core/desktop/DesktopLifecycleController.ts:65-73` closes immediately after an asynchronous `getDirtyState(lease)` returns `clean`; the discard branch at `:75-82` also closes without a final generation check. A document edit arriving after either decision but before `resolveClose` at `:101-108` is destroyed with the window. The post-save branch rechecks only the same enum at `:91-98`. The Task 16 contract at `src/app/App.tsx:34-37` has no acquire/validate/release operation, no generation value, and no resolution callback with which to release a held lease on every cancel path. Passing the native close token into two methods does not enforce that document state remains the state that was authorized through native destruction.

2. **Close requests can be permanently wedged before lifecycle listener startup or when native emit fails.**

   `src/app/App.tsx:65-73` awaits menu setup and menu-command listener registration before registering `uxml://close-requested`. If a user closes during those awaits, `src-tauri/src/lib.rs:339-345` stores a pending lease and emits to no lifecycle listener. `CloseGate::request` then returns only `Prevent` while that lease remains pending (`src-tauri/src/desktop.rs:164-175`), so later close attempts cannot recover. The same wedge occurs when `window.emit` fails because its result is discarded at `src-tauri/src/lib.rs:343-344`. Register close handling before fallible/awaited setup and cancel the exact pending lease when delivery fails.

3. **Grant replacement still races an in-flight watch startup, and watcher-initiated replacement can deadlock.**

   `src/core/host/TauriHost.ts:147-191` listens, starts the native watch, and flushes queued events before creating and registering `activeWatch` at `:198-231`. `chooseProject` retires only entries already in `this.watches` at `:61-79`. A native old-root event can therefore queue while `host_start_watch` is in flight; native selection can then stop all backend watches and install the new grant; the frontend can publish that new root while its watch set is empty; and the old start response can finally flush the queued old event and register a stale watcher after replacement. The established-watch regression at `src/core/host/TauriHost.contract.test.ts:293-339` does not cover an in-flight startup, while `:519-559` deliberately preserves the pre-response queue that makes this interleaving possible.

   There is also a self-deadlock: retirement awaits the serialized listener chain at `src/core/host/TauriHost.ts:202-208`. If a watch listener calls and awaits `host.chooseProject()`, that `chooseProject` waits for retirement of the delivery promise that contains the same listener. Startup and replacement need one frontend generation/serialization boundary, with in-flight watches registered before they can receive work and without waiting on the current callback from itself.

4. **Native file commands can be enabled without a functioning listener, and command failures become unhandled rejections.**

   With Task 16 bound, `src/app/App.tsx:65-76` enables Save/Save All/Close before `DesktopCommandBridge.start()` resolves. A click in that interval is lost; if command-listener or lifecycle-listener setup fails, the catch reports the startup error but never disables the menu again, leaving enabled commands with no handler. Cleanup at `:79-82` likewise does not restore disabled state. The default-disabled Rust menu definitions at `src-tauri/src/desktop.rs:37-56` are correct, but the frontend transition is not transactional.

   In addition, `src/core/desktop/DesktopCommandBridge.ts:48-53` lets a rejected Task 16 command escape its async event callback. The production adapter at `src/app/createProductionTauriRuntime.ts:5-14` passes that callback to Tauri's synchronous event handler and does not observe the returned promise. A failed save/menu command consequently causes an unhandled rejection instead of reaching `desktop.errors.report`.

5. **Watcher-stop accountability is dropped by the production consumer, and debounced failures are unhandled.**

   `TauriHost.watch` now provides a typed completion outcome at `src/core/host/TauriHost.ts:198-235`, but `src/core/persistence/ExternalChangeCoordinator.ts:176-186` wraps that disposable and omits `hostWatcher.completion`. A `host_stop_watch` failure is therefore observable only to a direct host caller, not through `SaveCoordinator.watch`, which is the Task 15 persistence path. Immediate listener failures are also collapsed without reporting by `src/core/host/TauriHost.ts:170-174`.

   Separately, the debounce callback at `src/core/persistence/ExternalChangeCoordinator.ts:166-174` is async and may reject when `processWhile` encounters a non-`not-found` read failure (`:207-212`). The production timer at `src/app/createProductionTauriRuntime.ts:11-14` ignores the callback promise, producing an unhandled rejection and no typed persistence outcome. Preserve completion through wrappers and route watch/rescan failures to an explicit outcome or error sink.

## Minor

No open Minor finding was found. The prior duplicate-host item is resolved.

## Prior Finding Adjudication

| Prior finding | Status | Adjudication |
| --- | --- | --- |
| Critical 1: scoped-path authorization TOCTOU | **OPEN** | Capability-relative child traversal is improved, but `prepare_selected` still races ambient selected-root validation against capability acquisition. See Critical 1. |
| Critical 2: external-writer check/commit race | **OPEN** | A second hash narrows the interval but does not make the final interval failure-safe; the test hook is before that hash. The cross-platform `guaranteed` capability overclaims. See Critical 2. |
| Important 1: close generation and stale permit | **OPEN** | The one-use native close operation removes the old separable permit, but document generation is not held or revalidated through destruction, and an undelivered lease can remain pending. See Important 1-2. |
| Important 2: old watcher work after grant replacement | **OPEN** | Established watches are retired and drained, but an in-flight watch is absent from the retirement set and can publish old work after the new grant; watcher-initiated replacement can deadlock. See Important 3. |
| Important 3: enabled no-op menus and swallowed startup errors | **OPEN (partially fixed)** | Unsupported items default disabled and startup errors are reported, but enabling precedes listener readiness and is not rolled back on failure/disposal; command rejections are unhandled. See Important 4. |
| Important 4: discarded notify/stop failures | **OPEN (partially fixed)** | Backend notify errors now produce typed rescan events and direct host disposal has a completion, but the coordinator drops that completion and debounced/read errors have no accountable path. See Important 5. |
| Important 5: arbitrary IPC IDs/DTOs | **RESOLVED** | Rust request DTOs deny unknown fields and validate exact ID/grant/revision/watch grammars; `TauriHost` performs exact-record and exact-grammar validation before branding or installing state. |
| Minor 1: duplicate `TauriHost` ownership | **RESOLVED** | `createTauriRuntimeBindings` constructs the single host, and `main.tsx` passes that exact instance into the editor store. Browser fallback selection remains intact and covered. |

## Additional Audits

- **Capabilities:** PASS. `src-tauri/capabilities/main.json` is scoped to window `main` with only event listen/unlisten; no broad filesystem, shell, or frontend close permission is present.
- **Dependency/license:** PASS. `cap-std` is pinned and locked at 4.0.2, and `THIRD-PARTY-NOTICES.md` records the direct dependency and its license/source. The support-stack license inventory is consistent with the lockfile metadata checked in this review.
- **Single-host/browser behavior:** PASS. One production `TauriHost` owns grant/watch state; browser and demo fallback construction was not regressed by the range.
- **DTO/ID validation:** PASS. Exact shapes and native identifier grammars are enforced on both IPC boundaries covered by Task 15.
- **Platform guarantee:** FAIL. The documented non-Windows limitation is not acceptable as written because the final race can silently lose an external update, and the public capability still says `guaranteed`.

## Verification

- `npm test`: 40 files, 571 tests passed.
- Focused Task 15/desktop/persistence tests: 7 files, 105 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 47 tests passed; doc tests passed.
- `npx tauri build --no-bundle`: passed and produced the release executable.
- `npm run build`: passed; the pre-existing Vite large-chunk advisory remains.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`: passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`: passed.
- `git diff --check c1d68cc..1537863`: passed.

Passing tests do not cover the selection-time root swap, final hash-to-rename interval, in-flight watch/selection interleaving, close-listener startup window, or production unhandled-promise paths described above.

## Verdict

**NEEDS FIXES**
