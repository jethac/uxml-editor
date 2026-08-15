# Task 15 Fix Round 5 Review (`6c423e4..7cb9177`)

Review only. No production code was changed and nothing was committed or pushed.

## Critical

1. **Same-identity recovery permits the target hard-link name to be removed before the delete-pending backup handle closes, so cleanup can delete the sole bytes.**

   `src-tauri/src/atomic_save.rs:969` and `src-tauri/src/atomic_save.rs:985` open both the backup and target through `open_recovery_identity_file`. That helper requests `FILE_GENERIC_READ | DELETE` at `src-tauri/src/atomic_save.rs:1066` and grants `FILE_SHARE_READ | FILE_SHARE_DELETE` at `src-tauri/src/atomic_save.rs:1067` for both names. After identity succeeds at `src-tauri/src/atomic_save.rs:987`, `src-tauri/src/atomic_save.rs:1003` dispositions the backup, and `src-tauri/src/atomic_save.rs:1010` returns without an explicit close order.

   Concrete failure: target and backup are hard links to the same NTFS file. A competing process removes or renames the target name after the identity proof; both recovery handles allow later delete access. The backup is now the sole link. `FileDispositionInfo` succeeds on the backup, and closing the handles deletes that final link and the bytes. A direct host-OS probe using the implementation's access/share modes reproduced exactly `target_removed_while_handles_open=True`, successful backup disposition, and `backup_survived=False`. Microsoft documents that `FILE_SHARE_DELETE` permits later delete access and that delete access includes rename; disposition with `DeleteFile=TRUE` deletes on close: [CreateFile sharing](https://learn.microsoft.com/en-us/windows/win32/api/FileAPI/nf-fileapi-createfilea), [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle), and [FILE_DISPOSITION_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information).

   Required correction: split backup and target acquisition while retaining `FILE_FLAG_OPEN_REPARSE_POINT` and same-live-handle reparse/identity checks. Open the backup with `FILE_GENERIC_READ | DELETE` and `FILE_SHARE_READ | FILE_SHARE_DELETE`. Open the target read-only, without `DELETE`, and with `FILE_SHARE_READ` only, without `FILE_SHARE_DELETE`. After the full `FILE_ID_INFO` match, disposition the backup and explicitly close/drop the backup handle while the target no-delete-share handle is still live; only then close/drop the target. Do not rely on scope exit: the target is declared in the inner match arm after the outer backup and therefore drops first under Rust's specified reverse declaration/inner-to-outer drop ordering: [Rust Reference](https://doc.rust-lang.org/reference/destructors.html). The tested corrected arrangement blocked target deletion with sharing violation, allowed backup disposition, removed the backup on explicit backup close, and preserved the target before and after target close.

   Add a deterministic Windows regression that holds these exact two live handles after identity acquisition, proves target delete and rename are denied, dispositions and explicitly closes the backup while the target guard is live, and verifies the target bytes survive while only the backup name disappears. Every new acquisition, disposition, and close-adjacent failure must continue to name the retained relative artifact without exposing the absolute root.

## Important

1. **Replacement support proves an NTFS filesystem name but does not prove that the selected live root is local.**

   `src-tauri/src/scoped_fs.rs:379` derives support solely from `filesystem_name_from_handle`; `src-tauri/src/scoped_fs.rs:389` returns `BestEffortSafeWrite` for any case-insensitive `NTFS` result. `src-tauri/src/scoped_fs.rs:399` calls only `GetVolumeInformationByHandleW`; it never queries whether the handle is remote. Standard SMB fails closed because Microsoft documents that this volume-information API is unsupported for SMB, but that is not affirmative locality proof for every redirector/provider: [GetVolumeInformationByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew).

   Concrete failure: a mapped, UNC, or other redirected provider on which this call succeeds and reports `NTFS` receives `best-effort-safe-write`, even though Task 15 requires every remote/mapped root to be unsupported and the root-handle rename form was verified only locally. The gate at `src-tauri/src/scoped_fs.rs:309` is correctly before path normalization and mutation, but it enforces an overbroad capability value.

   Required correction: derive both filesystem and locality from the same selected-root live handle, and advertise support only when both are affirmatively verified as local and NTFS. One documented handle-bound route is `NtQueryVolumeInformationFile(FileFsDeviceInformation)` and rejection of `FILE_REMOTE_DEVICE`: [NtQueryVolumeInformationFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntqueryvolumeinformationfile) and [FileFsDeviceInformation](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/616b66d5-b335-4e1c-8f87-b4a55e8d3e4a). Fail closed on missing API support, failure status, short/malformed output, missing filesystem terminator, invalid UTF-16, remote characteristics, ReFS, or unknown filesystems. Extend the pure classifier and DTO/integration tests with local NTFS, remote NTFS, API failure, and malformed-data cases.

## Prior Finding Map

| Fix-4 finding | Status | Adjudication |
| --- | --- | --- |
| Critical 1: recovery follows target reparse before redundant-backup cleanup | **RESOLVED** | Backup and target acquisition now pass `FILE_FLAG_OPEN_REPARSE_POINT` through cap-std, query `FileAttributeTagInfo` on the returned live handle, and reject every `FILE_ATTRIBUTE_REPARSE_POINT`. Local cap-std 4.0.2 source confirms the custom flag reaches `CreateFileAtW` and the same returned handle is retained. The Critical finding above is a distinct delete-sharing interval after valid same-object proof. |
| Critical 2: legacy 64-bit identity is not unique on ReFS | **RESOLVED** | `GetFileInformationByHandleEx(FileIdInfo)` is checked on both live handles; comparison uses the full 64-bit `VolumeSerialNumber` and all 128 file-ID bits, rejects an all-zero ID, fails closed on API errors, and has no `BY_HANDLE_FILE_INFORMATION` fallback. |
| Important 1: frontend workflow gate resurrects stale listener and is wrapper-local | **RESOLVED** | A stable opaque `commandAuthority` keys shared state across wrappers for one runtime. The fixed-width generation high-water mark is monotonic, retirement never lowers it or reactivates an older listener, late older registration is rejected, and distinct injected authorities remain independent. StrictMode and disable-failure ordering are covered. |
| Important 2: recovery/enumeration recurse through non-name-surrogate directory reparses | **RESOLVED** | Both walkers open each child capability no-follow, inspect that same handle for directory/non-reparse status, and derive `Dir` directly from that checked handle without a pathname reopen. Intermediate traversal remains capability-relative. |
| Important 3: atomic-replace capability is broader than the verified local rename form | **PARTIAL** | Support is now NTFS-only and ReFS/unknown/non-Windows/standard SMB fail closed, and enforcement precedes normalization/mutation. The Important finding above remains because locality is not affirmatively established for every successful `NTFS` result. |
| Minor 1: recovery errors omit the relative retained artifact | **RESOLVED** | Backup open, target open, metadata/attribute, identity, comparison, restore, and cleanup errors all include the relative artifact; messages do not expose the absolute selected root. |
| Minor 2: Rust recovery tests contradict non-Windows unsupported behavior | **RESOLVED** | Platform-specific success cases are Windows-gated and non-Windows assertions match the fail-closed `unsupported` contract before mutation. Non-Windows execution was unavailable in this review environment, as noted below. |

## Preserved Task 15 Properties

- The local-NTFS normal save path remains handle-bound and no-replace: incompatible writers/deleters are excluded through final hashing and return, temp/backup handles remain authoritative across rename, and uncertain temporary/backup bytes are retained conservatively.
- Recovery and normal enumeration retain final-component no-follow behavior and checked-handle directory derivation. Relative artifact reporting is complete. The sole-byte preservation claim remains blocked only by the new Critical delete-sharing/close-order finding.
- Replacement support is propagated through the selected-root DTO and enforced before relative-path parsing or mutation. ReFS, unknown filesystems, non-Windows, and failed volume queries remain unsupported; remote locality still needs the Important correction.
- Close retry/readiness, truthful nonblocking watch retirement, transactional native menus, schema and branded-ID validation, one production `TauriHost`, browser fallback, CSP, and the exact `main` event listen/unlisten capability remain intact. No shell, unrestricted filesystem, process authority, or Task 16 `FileWorkflow`/`CommandRegistry` implementation was added.

## Verification

- Accepted fix-4 review SHA-256: `F37B977FBD0D05FF75D649C98C7DEBFD0E0B1F51D700EF783580C9A6D3A4E2C8` exactly.
- HEAD: `7cb91774b9e0521ec15e35d409e7aef10750b846` exactly; reviewed range `6c423e4..7cb9177`.
- Focused frontend command/runtime/host tests: 5 files / 87 tests passed.
- Focused `atomic_save::tests`: 19 passed, 0 failed, 59 filtered.
- `npm test`: 40 files / 606 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 78 library tests passed; 0 binary tests and 0 doc tests; no failures.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml --locked --all-targets`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`: passed.
- `npm run build`: passed; 1,889 modules transformed, with the existing greater-than-500-kB chunk advisory.
- `npm run test:e2e`: 13 passed in 48.4 seconds; existing `NO_COLOR`/`FORCE_COLOR` warning only.
- `npx tauri build --no-bundle`: passed; release executable built and remained alive through a five-second hidden smoke run before deliberate termination.
- `npm audit --omit=dev`: 0 vulnerabilities. `npm ls --depth=0` passed with pinned direct dependencies.
- `git diff --check 6c423e4..7cb9177`: passed. The supplied review patch reversed HEAD to the exact base tree `3b7b85036de6c5e4a2246d5d7fc140ac51b57b9d`; live and supplied numstats matched.
- Scope validation found no manifest, lockfile, notice, CSP, or capability delta and no Task 16 implementation.
- Two ephemeral direct `CreateFileW`/`SetFileInformationByHandle` probes modified no repository files. The current symmetric mode reproduced sole-byte deletion. The required asymmetric mode produced `handles=True/True; targetDelete=False/32; mark=True/0; afterBackupCloseTarget=True; afterBackupCloseBackup=False; finalTarget=True; finalBackup=False`.

## Environment Limits

The review ran on Windows x64 with Rust/Cargo 1.92.0 and Node 25.2.1. Node is outside the repository's declared `>=24.15.0 <25` engine range. Only `x86_64-pc-windows-msvc` and `wasm32-unknown-unknown` targets were installed, so non-Windows cfg source/tests were inspected but not cross-compiled or executed. No SMB/UNC, mapped remote, ReFS, or other redirected project root was available for live integration testing; the locality finding follows from the source's lack of a remote-handle query and the documented API contracts.

NEEDS FIXES
