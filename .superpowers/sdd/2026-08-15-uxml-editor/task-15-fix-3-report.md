# Task 15 Fix Round 3 Report

## Status

All findings accepted from `task-15-fix-2-review.md` are addressed on `agent/uxml-editor` from clean head `7425b18`. The review artifact is included unchanged; its SHA-256 remains `7C3DC51B378D0C3A92B4510C5BBF5BC3E98B50528776456B0F9C92177FA70AEB`.

No Task 16 FileWorkflow or CommandRegistry was implemented. Browser fallback, one production `TauriHost`, opaque current-session grants, exact DTO validation, existing watch failure completion, narrow capabilities, and pinned dependencies remain intact. Nothing was pushed.

## Finding Resolution

### 1. Atomic save safety and recovery

Scoped replacement now has an explicit platform negotiation. Before project selection, `TauriHost.capabilities.atomicReplace` is `unsupported`. The exact `host_choose_project` result includes `atomicReplace`; Windows returns `best-effort-safe-write`, while non-Windows returns `unsupported`. A non-Windows replacement fails with typed `unsupported` before creating a temporary or quarantine entry. No portable hash-CAS claim remains.

The supported Windows protocol is capability-relative:

1. Validate the target and open a checked handle whose sharing mode permits read/delete but not write.
2. Hash the checked bytes, create a unique sibling `.tmp`, write exact UTF-8 bytes, and synchronize the temporary.
3. Reopen and hash the checked target while the no-write-sharing handles remain live.
4. Create the quarantine as a hard link with no-replace semantics. There is no placeholder/remove/rename reservation interval. Remove the original name only after the exact bytes have a second name.
5. Open and hash the quarantine. The deterministic final hook is after this hash and before destination installation or cleanup.
6. Install the synchronized temporary at the destination with a capability-relative no-replace hard link. A competing destination is preserved.
7. Reopen/hash the result, flush supported metadata before destructive cleanup, remove the temporary link, and remove the quarantine last. There is no fallible operation after successful quarantine removal.

An existing Windows writable handle prevents checked-handle acquisition because the requested share mode omits `FILE_SHARE_WRITE`; the exact regression receives `permission-denied` and proves the final hook did not execute. The implementation does not claim that an acquired checked handle coexists with an admitted writable handle.

Every post-quarantine error either restores the absent target by no-replace hard link or retains the quarantine and returns a typed error naming the relative recovery artifact. `CapBackupGuard::drop` never deletes a backup. Destination creation, result read/hash failure, cleanup/flush failure, and rollback failure cannot silently delete the original byte set. A raced quarantine name is never overwritten and is surfaced as a conflict.

Project acquisition recursively recovers editor artifacts through the acquired `cap_std::fs::Dir`: an absent target is restored no-replace from `.bak`; target-plus-backup is surfaced and both byte sets remain; a `.tmp` is removed only when its target exists, otherwise it is retained and surfaced. Recovery runs before grant publication. Failed recovery therefore preserves the prior grant/watch session. Native watch filtering continues to suppress editor `.tmp`/`.bak` mechanics.

### 2. Exclusive close contract

`Task16FileLifecyclePort` now requires `runExclusiveCloseState(nativeLease, operation)`. The owner supplies the document lease and must block, reject, or queue document edits until the operation settles. Dirty evaluation, confirmation, save, final validation, and `desktop_resolve_close` all execute inside that callback. The owner releases in its own `finally`; the unbound adapter does the same and remains fail-closed for an open unowned session.

The regression attempts an edit after final validation while native resolution is pending. The edit is not accepted until resolution completes, and exclusivity releases on success and failure. Task 16 receives a concrete ownership hook without this task implementing its FileWorkflow.

### 3. Close generation and recovery

Close readiness is generation-scoped with exact `lifecycle:v1:<16 lowercase hex>` tokens. Frontend generations are monotonic. Rust ignores stale ready/withdraw transitions, binds each pending close lease to its lifecycle generation, and emits exact `{ lease, lifecycleGeneration }`. Resolve and abandon requests carry both values.

Listener registration still precedes readiness. Startup response loss triggers withdrawal of the exact generation before listener removal. StrictMode stale startup completion/disposal cannot withdraw a newer listener or clear its lease. Failed `resolveClose` reaches `desktop.errors.report`; the controller invokes `desktop_abandon_close` for the exact lease/generation, allowing a later native close. Abandonment failure is also reported rather than leaked as an unhandled rejection.

### 4. Watch reentry and grant publication

Successful selection synchronously marks every pending and established frontend watch inactive, clears queued payloads, and unlistens before new grant publication. Replacement retirement does not await any already-invoked listener promise, removing the impossible-to-identify post-yield caller cycle without browser-only async-context assumptions.

A listener that first yields and then awaits `chooseProject()` now completes. Multi-listener coverage keeps an unrelated callback blocked across replacement and queues another event behind it: the new grant publishes, the old branded root immediately fails, the already-invoked callback can unwind, and the queued old-grant callback is never invoked. Failed selection still leaves the old grant/watch active.

### 5. Transactional native menus

File-menu transitions carry exact `workflow:v1:<16 lowercase hex>` generations. Rust serializes transitions through `FileWorkflowGate`; stale generations are no-ops. Before mutation it captures Save, Save All, and Close Project states. An intermediate failure rolls every already-mutated item back in reverse order and returns the failure. Exact partial-failure, stale-generation, and schema fixtures pass.

App enables the workflow only after close and command listeners are ready. Disposal and rollback disable the generation before removing listeners. If disable fails, listeners remain functional and `DesktopWorkflowDisableError` reaches the production error sink with failed completion metadata and an explicit `retry()`; successful retry disables first and then disposes. Delayed stale cleanup cannot disable a newer StrictMode generation. Rejected Task 16 command promises continue to reach `desktop.errors.report`.

## Schemas

Changed native schemas are exact and deny unknown fields in Rust:

| Boundary | Schema |
| --- | --- |
| project selection result | `{ projectId, displayName, grant, atomicReplace: "best-effort-safe-write" | "unsupported" }` |
| close request event | `{ lease: "close:v1:<16 hex>", lifecycleGeneration: "lifecycle:v1:<16 hex>" }` |
| lifecycle readiness | `{ lifecycleGeneration, ready: boolean }` |
| close resolution | `{ lease, lifecycleGeneration, action: "close" | "cancel" }` |
| close abandonment | `{ lease, lifecycleGeneration }` |
| file workflow transition | `{ workflowGeneration: "workflow:v1:<16 hex>", enabled: boolean }` |

Project IDs remain exact `project:v1:<64 lowercase hex>`, grants `grant:v1:<16 lowercase hex>`, revisions `sha256:v1:<64 lowercase hex>`, and watches `watch:v1:<16 lowercase hex>`.

## TDD Evidence

Behavioral RED commands exited 1 for Vitest or 101 for Cargo unless noted; corrected setup-only failures are not counted.

| Slice | RED evidence | GREEN evidence |
| --- | --- | --- |
| Post-quarantine faults | `cargo test ... every_post_quarantine_failure...`: original silently discarded at `BeforeQuarantineOpen` | atomic module 10/10 |
| Crash restore | `cargo test ... project_acquisition_restores...`: `not-found` | acquisition recovery 2/2 |
| Crash conflict | `cargo test ... project_acquisition_surfaces...`: selection incorrectly returned `Ok` | both byte sets retained and relative artifact surfaced |
| Quarantine reservation race | `cargo test ... a_raced_quarantine_name...`: raced entry was missing/overwritten | raced entry preserved, target unchanged |
| Final destination conflict | `cargo test ... external_path_replacement...`: original bytes discarded | destination and original recovery bytes both preserved |
| Atomic capability negotiation | focused TauriHost Vitest: received `best-effort-safe-write` before selection | conservative start plus exact selection negotiation |
| Exclusive close and resolve failure | focused lifecycle Vitest: 2/2 failed; edit accepted and no error/abandon | lifecycle suite GREEN |
| StrictMode readiness | focused lifecycle Vitest: stale disposal set readiness false | newer generation remains ready |
| Native stale readiness | focused Cargo test: stale withdrawal prevented all closes | current generation emits |
| Post-yield watch reentry | focused TauriHost Vitest: replacement remained unsettled | post-yield and multi-listener interleavings GREEN |
| Frontend menu disposal/overlap | focused App Vitest: listeners removed on disable failure; stale disable won | listeners retained/retriable; newer generation remains enabled |
| Native partial menu failure | focused Cargo test: `file.save` remained enabled | all prior states restored |
| Request token validation | focused runtime Vitest: malformed lifecycle request resolved | lifecycle/workflow malformed requests rejected before invoke |
| Readiness response loss | focused lifecycle Vitest: only ready=true observed | exact ready=false withdrawal observed before listener removal |

One initial Cargo invocation supplied two test filters and was rejected by Cargo argument parsing. One first partial-menu test compile used a borrowed map key that escaped the closure. Both setup errors were corrected before the behavioral REDs above and are not counted.

## Verification

| Command/check | Result |
| --- | --- |
| focused Task 15 TypeScript | 6 files / 123 tests passed after the final lifecycle regression |
| `npm test` with JSON reporter | 40 files / 594 tests passed |
| `npm run build` | passed; TypeScript and Vite, 1,889 modules |
| `npm run test:e2e` with JSON reporter | 13 expected, 0 unexpected, 0 skipped/flaky |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | passed |
| `cargo check --manifest-path src-tauri/Cargo.toml --all-targets` | passed |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | passed |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 61 tests passed; doc tests passed |
| `npx tauri build --no-bundle` | passed; release executable rebuilt at 02:59:38 |
| rebuilt executable smoke | stayed live 5 seconds; title `UXML Editor`; controlled termination |
| `npm audit --omit=dev` | 0 vulnerabilities |
| capability/forbidden audit | exactly main + event listen/unlisten; 0 forbidden matches; no `app.capabilities` |
| dependency/license audit | exact pins and notices passed |
| accepted review hash | unchanged |
| `git diff --check` | passed; only configured LF-to-CRLF notices |

The Tauri CLI returned before its detached Cargo children completed in this environment. Verification explicitly waited for those children, confirmed the release executable timestamp advanced to `2026-08-16T02:59:38+09:00`, and only then ran the successful smoke. Vitest was similarly counted only after its JSON report finalized and no worker remained.

## Dependencies and Capabilities

No manifest or lockfile dependency changed in this round. Exact versions/licenses remain:

- `cap-std` 4.0.2: `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`.
- `@tauri-apps/api` 2.11.1 and CLI 2.11.4: `Apache-2.0 OR MIT`.
- `tauri` 2.11.5, `tauri-build` 2.6.3, `tauri-plugin-dialog` 2.7.1: `Apache-2.0 OR MIT`.
- `notify` 6.1.1: `CC0-1.0`.
- `serde` 1.0.229, `serde_json` 1.0.151, `sha2` 0.10.9, `windows-sys` 0.61.2: `MIT OR Apache-2.0`.

`THIRD-PARTY-NOTICES.md` now explicitly lists the already-pinned CLI and `tauri-build` versions/licenses. `src-tauri/capabilities/main.json` still grants exactly `core:event:allow-listen` and `core:event:allow-unlisten` to `main`. There is no shell/fs plugin capability, broad glob, arbitrary path IPC, command execution, frontend close/destroy permission, telemetry, or explicit `app.capabilities`. CSP is unchanged.

## Changed Files

Rust authority/runtime: `src-tauri/src/atomic_save.rs`, `scoped_fs.rs`, `identifiers.rs`, `desktop.rs`, `commands.rs`, and `lib.rs`.

TypeScript host/lifecycle/runtime: `src/core/host/HostPort.ts`, `TauriHost.ts`, `TauriHost.contract.test.ts`, `src/core/desktop/DesktopLifecycleController.ts`, its test, `src/app/App.tsx`, its desktop test, `TauriRuntime.ts`, and its test.

Metadata/reports: `THIRD-PARTY-NOTICES.md`, `task-15-report.md`, this report, and unchanged `task-15-fix-2-review.md`.

No plan, ledger, `UXML_GOAL.md`, CSP/config capability, dependency manifest/lock, downstream consumer, or unrelated source was changed.

## Task 16 Boundary and Concerns

Task 16 must implement `runExclusiveCloseState` so its document mutation path actually queues or rejects edits for the callback lifetime, including native resolution. It must bind Save/Save All/Close Project before App enables that workflow generation. It can consume `DesktopWorkflowDisableError.retry()` and existing watch `Disposable.completion`; no Task 16 workflow logic was preempted here.

The packaged target is Windows. Windows replacement is tested as a recoverable best-effort safe write, not a linearizable hash-CAS. Non-Windows replacement is deliberately unavailable until a platform implementation can preserve both byte sets across the final interval and interruption paths. Native directory picker/menu/dialog interaction was not UI-automated; injected boundary tests, browser E2E, release build, and rebuilt executable smoke passed. The existing Vite large-chunk advisory remains.
