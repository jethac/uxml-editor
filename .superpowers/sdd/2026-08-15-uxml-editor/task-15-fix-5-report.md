# Task 15 Fix Round 5 Report

## Status

Implemented every accepted Critical, Important, and Minor finding from `task-15-fix-4-review.md` on `agent/uxml-editor`, starting at clean commit `6c423e4`. The accepted review artifact is included unchanged with SHA-256 `F37B977FBD0D05FF75D649C98C7DEBFD0E0B1F51D700EF783580C9A6D3A4E2C8`.

This final SDD fix round makes recovery deletion authority no-follow and identity-exact, binds recursive traversal to checked directory handles, limits replacement negotiation to verified local NTFS roots, and makes frontend command ownership monotonic across separate wrappers for the same runtime. Task 16's `FileWorkflow` and `CommandRegistry` remain out of scope.

## Finding-by-Finding Resolution

### 1. Recovery rejects final-component reparse objects

On Windows, `open_recovery_identity_file` now opens each one-component backup or target name relative to the granted `cap_std::fs::Dir` with:

- `FILE_GENERIC_READ | DELETE` access;
- `FILE_SHARE_READ | FILE_SHARE_DELETE` sharing; and
- `FILE_FLAG_OPEN_REPARSE_POINT` no-follow behavior.

The implementation queries `FileAttributeTagInfo` through `GetFileInformationByHandleEx` on that same live handle. Any `FILE_ATTRIBUTE_REPARSE_POINT` bit is rejected, independent of reparse tag or whether the object is a name surrogate. This follows the documented [`FILE_FLAG_OPEN_REPARSE_POINT` behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew): the opened handle addresses the reparse object rather than its target. There is no pathname precheck followed by a target-following open.

Recovery opens the backup first. It then opens the target through the same no-follow helper. Only `NotFound` means target-absent and permits a no-replace restore through the already-authorized backup handle. Every other target-open or attribute failure retains the backup and reports its relative artifact.

The deterministic regression acquires the backup handle, then replaces the target with a file symlink to that backup before target acquisition. Recovery rejects the target handle as a reparse object. The backup bytes and name remain; the target symlink is not treated as authorization to delete the backup. Symlink creation and the complete test path executed on the verification host.

### 2. Deletion uses full `FILE_ID_INFO`

Recovery identity is now the complete Windows [`FILE_ID_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info) returned by `GetFileInformationByHandleEx(FileIdInfo)`:

- the complete 64-bit `VolumeSerialNumber`; and
- all 16 bytes of `FILE_ID_128.Identifier`.

Only exact equality of both fields on the two still-open, deletion-grade handles can authorize same-object backup cleanup. A zero 128-bit identifier is treated as malformed. API failure, incomplete or malformed proof, metadata failure, and unequal identities all fail closed without deleting the backup. The previous `BY_HANDLE_FILE_INFORMATION` 32-bit volume plus 64-bit index path has been removed.

Focused policy tests distinguish changes in the high volume-serial bits and in every region of the 128-bit identifier. Exact recovery tests prove target identity-query and comparison failures retain bytes and identify the relative backup.

### 3. Workflow ownership is runtime-stable and monotonic

`RawTauriRuntimePorts` and `AppDesktopPorts` now carry an opaque `commandAuthority: object`. `createTauriRuntimeBindings` copies that identity into every binding wrapper. Production runtime wiring owns one module-stable frozen authority object, so React/StrictMode wrappers over the same transport share the same command gate without coupling to wrapper object identity.

The gate is a `WeakMap` keyed by `commandAuthority`. Each value contains:

- `highWater`, the greatest fixed-width workflow generation ever registered; and
- `current`, the currently active owner or no owner.

A generation can register only above `highWater`. Retiring the current generation clears `current` but preserves the high-water tombstone, so an older retained listener never becomes current again. Late registration of an older generation is inert. Stale retirement remains harmless. Tests cover successor retirement, distinct wrappers sharing one authority, delayed old registration, and exactly-once Save plus representative Edit/View execution.

This is narrow listener ownership infrastructure. It does not implement Task 16 commands or duplicate command logic.

### 4. Recursive traversal is checked on the opened directory object

Recovery and ordinary enumeration both reject every Windows entry whose metadata carries `FILE_ATTRIBUTE_REPARSE_POINT`, including non-name-surrogate tags.

For a child directory, the parent capability opens the final component with `FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`. The implementation queries `FileAttributeTagInfo` from the same handle and requires both directory and non-reparse attributes. It then converts that exact checked `cap_std::fs::File` with `into_std` and `Dir::from_std_file`; it never reopens the pathname to obtain traversal authority.

This closes the check/open/reopen interval. Tests cover the attribute policy, an ordinary checked child, and a directory symlink. The symlink is rejected rather than traversed.

### 5. Replacement support is verified from the live root

Project selection classifies replacement support from the selected live root directory handle with [`GetVolumeInformationByHandleW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew). The call supplies the filesystem name on supported handles and is documented as unsupported for SMB 3.0, Transparent Failover, and Scale-out shares.

The grant stores `best-effort-safe-write` only when the handle-derived call succeeds and the reported filesystem is exactly NTFS, case-insensitively. API failure, empty or malformed names, ReFS, SMB/UNC, mapped or remote storage, and every unknown filesystem produce `unsupported`. No path-string or `cfg(windows)` inference grants support.

`ScopedProjects::with_replace_file` checks the stored grant support before path normalization and before entering the replacement closure. The native `replace_project_file` command uses this gate. A deterministic unsupported-grant test proves the closure is never invoked and existing target bytes remain exact.

The supported local NTFS implementation retains the round-4 handle-bound no-replace protocol and incompatible share modes. Non-Windows and unverified Windows backends return typed `unsupported` before save mutation. The capability is not a portable hash-CAS claim.

### 6. Retained-backup errors always name the artifact

Once a matching backup is identified, all errors add the normalized relative backup artifact, including:

- backup and target opens;
- handle attribute and metadata queries;
- identity query and comparison;
- non-identical target/backup conflicts;
- no-replace restoration; and
- same-identity cleanup.

The scanner also preserves the relative artifact when file-type or metadata inspection fails for a syntactically valid backup name. Error text never exposes an absolute project root.

### 7. Non-Windows tests match the unsupported contract

Windows recovery-success and replacement-success regressions are `cfg(windows)`. Non-Windows coverage asserts the exact typed `unsupported` result and verifies no target or artifact mutation. This verification session ran on Windows; the non-Windows branch was reviewed and compiled conditionally but was not executed on a non-Windows target.

## Security and Platform Guarantee

The only supported replacement backend is a selected live local NTFS directory whose filesystem was verified through `GetVolumeInformationByHandleW`. The existing Windows atomic-save protocol uses capability-relative handles, no-replace root-relative renames, incompatible writable/delete sharing, exact revision hashes, and handle-owned cleanup. It remains reported as `best-effort-safe-write`, not as a portable linearizable content-hash CAS.

Recovery deletion is narrower than ordinary read authority: both names must yield live final-component no-follow, non-reparse, deletion-grade handles and complete matching `FILE_ID_INFO`. Any uncertainty retains the backup and reports its relative artifact.

The Tauri capability remains limited to the exact main window and `core:event:allow-listen` plus `core:event:allow-unlisten`. Rust custom commands retain all filesystem authority. There is no shell/fs plugin, broad filesystem glob, arbitrary path IPC, command execution, window-close permission, or incompatible `app.capabilities` field.

## TDD Evidence

Focused behavioral regressions were added and observed failing against the existing production behavior before each production slice. Missing-import failures are listed only where paired with the earlier destructive behavioral RED that established the defect.

| Slice | RED evidence | GREEN evidence |
| --- | --- | --- |
| Target symlink to backup | `cargo test --manifest-path src-tauri/Cargo.toml --locked scoped_fs::tests::project_acquisition_never_follows_a_target_symlink_to_authorize_backup_deletion -- --exact --nocapture`, exit 1: 0/1; recovery returned `Ok(ProjectRootDto { ... })`, proving the following target open authorized backup cleanup. | Same exact command, exit 0: 1/1; reparse target rejected and backup bytes/name preserved. |
| Target-open artifact reporting | `cargo test --manifest-path src-tauri/Cargo.toml --locked scoped_fs::tests::failed_recovery_target_open_names_and_retains_the_relative_backup_artifact -- --exact --nocapture`, exit 1: 0/1; returned bare `permission-denied` instead of the expected retained-artifact `replace-failed`. | Same exact command, exit 0: 1/1 with the normalized relative backup artifact. |
| Full identity and reparse policy | Focused compile/run of `atomic_save::tests::recovery_identity_compares_the_full_volume_serial_and_all_128_file_id_bits` and `recovery_rejects_every_reparse_attribute_independent_of_tag_shape`, exit 1 because the exact policy helpers did not exist; this was paired with the preceding destructive symlink RED. | Both exact tests, exit 0: 1/1 each; full serial/ID comparison and all-reparse rejection pass. |
| Same-handle child traversal | Exact `atomic_save::tests::recovery_child_directory_is_opened_no_follow_and_checked_on_the_same_handle`, exit 1 because existing traversal reopened the pathname and exposed no checked-handle helper. | Exact test, exit 0: 1/1; enumeration directory-symlink rejection also passed 1/1. |
| Replacement capability | Exact classification and unsupported-mutation focused run, exit 1 because support was a blanket platform value and no grant-level replacement gate existed. | Classification and unsupported-mutation exact tests, exit 0: 1/1 each; replacement closure did not run. |
| Target-open race | Exact deterministic recovery target-open race test, exit 1 before a post-backup-acquisition hook existed. | Exact race test, exit 0: 1/1; raced reparse target rejected. |
| Metadata artifact reporting | Exact recovery metadata-error test, exit 1 before the scanner's error formatter carried the retained backup path. | Exact test, exit 0: 1/1 with relative artifact. |
| Successor retirement | `npm test -- --run src/app/App.desktop.test.tsx -t "never resurrects a retained older listener"`, exit 1: 1 failed / 8 skipped; stale Save executed once after its successor retired. | Exact test and full App desktop suite, exit 0. |
| Shared authority and late old registration | `npm test -- --run src/app/App.desktop.test.tsx -t "distinct desktop wrappers|late older listener"`, exit 1: 2 failed / 9 skipped; old Save executed once where zero was expected. | Exact focus, exit 0: 2 passed; representative Save/Edit/View delivery is exactly once on the current owner. |
| Runtime authority propagation | `npm test -- --run src/app/TauriRuntime.test.ts -t "preserves one explicit command authority"`, exit 1: 1 failed / 9 skipped; wrapper authority was `undefined`. | Exact focus, exit 0: 1 passed; separate bindings preserve the same opaque identity. |

Final focused totals:

- Rust atomic replacement/recovery: 18 tests passed.
- Rust scoped filesystem/grants/recovery: 18 tests passed.
- Rust command fixtures/gates: 11 tests passed.
- TypeScript host/lifecycle/command/App/runtime/save: 6 files / 135 tests passed.

## Full Verification

| Command/check | Result |
| --- | --- |
| `npm test` | exit 0, 40 files / 606 tests passed |
| `npm run build` | exit 0, TypeScript and Vite production build passed; 1,889 modules transformed |
| `npm run test:e2e` | exit 0, 13 passed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | exit 0 |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked --all-targets` | exit 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | exit 0 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | exit 0, 78 unit tests passed; 0 doc tests |
| `npx tauri build --no-bundle` | exit 0; release executable built |
| Hidden release executable smoke | exit 0; 10,075,136-byte executable remained live for 5 seconds |
| `npm audit --omit=dev` | exit 0; 0 vulnerabilities |
| Capability audit | passed; exact main window and two core event permissions only |
| Forbidden-surface audit | passed; 0 shell/fs plugin, broad permission, command execution, window-close, or `app.capabilities` matches |
| Dependency/license/notice audit | passed; exact versions and all required notices present |
| Review hash | passed; exact accepted SHA-256 preserved |
| Dependency/config delta audit | passed; no manifest, lock, notice, CSP, capability, or generated-config changes |
| `git diff --check` | passed; line-ending conversion notices only |

The Vite build retains its existing large-chunk advisory. E2E retains the existing `NO_COLOR`/`FORCE_COLOR` warnings. Neither is a Task 15 regression.

## Dependencies and Licenses

No dependency or feature changed in this round. Audited exact Rust packages:

| Package | Version | License |
| --- | ---: | --- |
| `cap-std` | 4.0.2 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| `notify` | 6.1.1 | CC0-1.0 |
| `serde` | 1.0.229 | MIT OR Apache-2.0 |
| `serde_json` | 1.0.151 | MIT OR Apache-2.0 |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 |
| `tauri` | 2.11.5 | Apache-2.0 OR MIT |
| `tauri-build` | 2.6.3 | Apache-2.0 OR MIT |
| `tauri-plugin-dialog` | 2.7.1 | Apache-2.0 OR MIT |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 |

The npm runtime remains pinned to `@tauri-apps/api` 2.11.1 and the development CLI to `@tauri-apps/cli` 2.11.4, both Apache-2.0 OR MIT. The existing seven required third-party notice entries remain exact.

## Changed Files

- `src-tauri/src/atomic_save.rs`: no-follow recovery handles, full `FILE_ID_INFO`, checked child traversal, artifact-complete errors, and regressions.
- `src-tauri/src/scoped_fs.rs`: live-root replacement support, grant-level mutation gate, enumeration reparse policy, and acquisition/recovery tests.
- `src-tauri/src/commands.rs`: replacement command uses the support-checked grant operation.
- `src/app/App.tsx`: authority-keyed monotonic high-water/tombstone command gate.
- `src/app/App.desktop.test.tsx`: retained-successor, shared-wrapper, and late-registration regressions.
- `src/app/TauriRuntime.ts`: typed opaque command authority propagation.
- `src/app/TauriRuntime.test.ts`: separate-wrapper authority regression.
- `src/app/createProductionTauriRuntime.ts`: one stable production transport authority.
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-report.md`: corrected round-5 architecture and verification addendum.
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-fix-5-report.md`: this report.
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-fix-4-review.md`: accepted review, preserved byte-for-byte and included unchanged.

## Self-Review

- Every accepted finding has a production change and focused regression.
- Recovery deletion cannot be authorized through a followed target/backup final component or a partial legacy identity.
- Traversal authority is created from the same checked child directory handle.
- Replacement availability is derived from the live selected root and enforced in the command path before mutation.
- Listener generations cannot fall back or cross wrapper identities for one runtime.
- Exact DTO/ID validation, one `TauriHost`, browser fallback, watch completion/errors, close exclusivity/retry, narrow Tauri capabilities, CSP, and disabled unbound file-menu commands remain intact.
- No Task 16 workflow/registry implementation, broad permission, telemetry, arbitrary code execution, unrelated plan/ledger/UXML goal change, or push was introduced.

## Concerns and Intentional Limits

- Packaged replacement support is intentionally limited to live roots verified as local NTFS. ReFS, SMB/UNC, mapped or remote, unknown Windows filesystems, and non-Windows targets report `unsupported` before save mutation.
- The Windows symlink regressions require symlink creation privileges; they executed fully on this host. The non-Windows unsupported branch was not executed on a non-Windows machine in this round.
- The release executable was rebuilt and smoke-tested hidden for five seconds. Real picker, native menu, dialog, and dirty-close interaction were covered through injected/native tests rather than an interactive manual desktop session.
- The existing Vite chunk-size advisory remains.
