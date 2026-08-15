# Task 15 Breaker-Exception Fix Report

## Status

The two open findings from the accepted fix-5 review are resolved on branch
`agent/uxml-editor`, starting at clean commit
`7cb91774b9e0521ec15e35d409e7aef10750b846`. Nothing was pushed. The accepted
review is included unchanged with SHA-256
`D8D2769035999739384BB290F76B5BE0998FC18D423FCCCD6EAF0FFFD03C562B`.

## Finding 1: Same-Identity Hard-Link Cleanup

Recovery now acquires the two final components with distinct no-follow handles:

- backup: `FILE_GENERIC_READ | DELETE`, sharing
  `FILE_SHARE_READ | FILE_SHARE_DELETE`;
- target: `FILE_GENERIC_READ` only, sharing `FILE_SHARE_READ` only; and
- both: `FILE_FLAG_OPEN_REPARSE_POINT`, followed by a same-live-handle
  `FileAttributeTagInfo` rejection of every reparse object.

The same two live handles supply the complete `FILE_ID_INFO` comparison. Only an
exact 64-bit volume serial and complete 128-bit file ID match authorizes cleanup.
Recovery then dispositions the backup, explicitly drops the backup while the
target's no-delete-share handle is live, and explicitly drops the target last.
This ordering is expressed in code and does not depend on Rust scope-exit order.

The deterministic Windows regression creates hard-linked backup and target
names, acquires both exact handles, establishes exact identity, and attempts both
target rename and deletion. Both return sharing violation 32. It then
dispositions and closes the backup while retaining the target handle, proves
that only the backup name disappears, and verifies the target's exact bytes both
before and after target close.

Target-absent recovery is preserved. A read-only target open returning
`NotFound` still restores the already checked backup with the existing
handle-bound no-replace rename. Every acquisition, identity, disposition, and
restore error remains wrapped with the relative backup artifact; no absolute
selected root enters the error.

## Finding 2: Affirmative Local-Device Proof

Replacement support now combines two results derived from the same live selected
root handle:

1. `GetVolumeInformationByHandleW` must return a terminated, valid UTF-16
   filesystem name equal to `NTFS`, case-insensitively.
2. `NtQueryVolumeInformationFile(FileFsDeviceInformation)` must return an exact
   `FILE_FS_DEVICE_INFORMATION` with successful call and completion statuses,
   exact `IO_STATUS_BLOCK.Information`, and neither `FILE_REMOTE_DEVICE` nor
   `FILE_REMOTE_DEVICE_VSMB`.

The query uses the `windows-sys` `IO_STATUS_BLOCK` and
`FILE_FS_DEVICE_INFORMATION` structured bindings. Negative `NTSTATUS` values are
converted with `RtlNtStatusToDosError`; zero is exact success and positive
incomplete/informational statuses fail closed. Failed calls, failed completion,
short or oversized output, remote/VSMB characteristics, missing terminators,
invalid UTF-16, ReFS, empty names, and unknown names all classify as
`unsupported`.

The grant-level `with_replace_file` check remains before path normalization and
before entry into the mutation closure. The existing unsupported-grant test
continues to prove that unsupported projects do not enter mutation. A live test
creates a project under `CARGO_MANIFEST_DIR`, which is on fixed local `B:` NTFS
on this host, and verifies both the handle classifier and serialized selected-root
DTO report `best-effort-safe-write`. The release command serialization test
reports the same value.

## RED/GREEN Evidence

### Hard-link cleanup

RED, before production edits:

`cargo test --manifest-path src-tauri/Cargo.toml --locked atomic_save::tests::same_identity_cleanup_blocks_target_delete_and_rename_until_backup_is_closed -- --exact --nocapture`

Exit 1. The regression panicked because target rename returned `Ok(())` while
both current symmetric recovery handles were live. Both rename and delete had
already been attempted before the assertion.

GREEN, after the split acquisition and explicit close order: the same exact
command passed 1/1. The complete focused `atomic_save::tests` run passed 20/20.

### Local-device proof

RED, before production edits:

`cargo test --manifest-path src-tauri/Cargo.toml --locked scoped_fs::tests::replacement_capability_without_affirmative_locality_is_unsupported -- --exact --nocapture`

Exit 1 with actual `BestEffortSafeWrite`, expected `Unsupported`, proving that a
filesystem-only NTFS result was promoted without locality evidence. The desired
evidence-classifier tests were then added before production changes; their first
compile also failed for the absent classifier/API and absent exact feature. That
compile failure is supplementary to the direct behavioral RED above.

GREEN:

- all three `replacement_capability_` classifier tests passed 3/3;
- malformed UTF-16/terminator decoding passed 1/1;
- the live manifest-volume classifier/DTO integration passed 1/1; and
- the complete focused `scoped_fs::tests` run passed 22/22.

## Unsafe ABI and Lifetime Review

- `NtQueryVolumeInformationFile` receives the raw handle of the still-live
  selected `cap_std::fs::Dir` authority.
- The output pointers address initialized windows-sys `#[repr(C)]` structures;
  the supplied length is exactly `size_of::<FILE_FS_DEVICE_INFORMATION>()`.
- `IO_STATUS_BLOCK` is initialized before the call. Its union status is read only
  while the structure remains live, and support additionally requires successful
  call/completion classifications plus an exact returned-byte count.
- Negative native statuses are never interpreted as Win32 last-error values;
  `RtlNtStatusToDosError` performs that conversion. No converted error or root
  path is exposed through IPC.
- Backup and target attributes and full identities come from their retained live
  no-follow handles. Backup disposition occurs while both handles remain live.
  `drop(backup)` is explicit before byte/name assertions in the regression and
  before `drop(target)` in production.
- The target handle has no `DELETE` access and does not grant delete or write
  sharing. Its observed host behavior excludes target rename and deletion through
  backup disposition and close.

## Full Verification

| Check | Result |
| --- | --- |
| Focused `atomic_save::tests` | 20 passed |
| Focused `scoped_fs::tests` | 22 passed |
| `npm test` | 40 files / 606 tests passed |
| `npm run build` | passed; 1,889 modules transformed |
| `npm run test:e2e` | 13 passed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | passed |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked --all-targets` | passed |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 83 library tests passed; 0 binary/doc tests |
| `npx tauri build --no-bundle` | passed |
| Hidden release executable smoke | 10,059,776-byte executable remained live for five seconds before deliberate termination |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm ls --depth=0` | passed; direct versions remain pinned |
| `cargo tree --locked --depth 1` | passed; exact direct Rust versions unchanged |
| Capability audit | exact `main` window and event listen/unlisten only; no `app.capabilities` |
| Forbidden-surface audit | 0 production shell/fs plugin, execution, broad-path, or window-close matches |
| License and notice audits | exact audited licenses, versions, and required integrity notices passed |
| Accepted review hash | exact SHA-256 preserved |
| Config delta audit | only the exact windows-sys feature module changed; no version, lock, notice, CSP, capability, or generated-config delta |

`Get-Volume -DriveLetter B` reported `NTFS`, `Fixed`, and `Healthy`. The Vite
large-chunk advisory and Playwright `NO_COLOR`/`FORCE_COLOR` warning are unchanged.

## Changed Files

- `src-tauri/Cargo.toml`: adds only `Wdk_System_SystemServices` to the existing
  exact `windows-sys` 0.61.2 feature list.
- `src-tauri/src/atomic_save.rs`: split backup/target recovery acquisition,
  explicit backup-before-target close order, and hard-link regression.
- `src-tauri/src/scoped_fs.rs`: handle-bound device query, pure fail-closed
  evidence classifier, UTF-16 decoder, and classifier/live-volume tests.
- `src-tauri/src/commands.rs`: selected-root command DTO support assertion.
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-report.md`: breaker-exception
  addendum.
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-fix-6-report.md`: this report.
- `.superpowers/sdd/2026-08-15-uxml-editor/task-15-fix-5-review.md`: accepted
  review, included byte-for-byte unchanged.

## Dependencies, Features, and Licenses

No dependency version or lockfile changed. `windows-sys` remains exactly 0.61.2,
licensed MIT OR Apache-2.0. The one added feature is
`Wdk_System_SystemServices`, required for the structured
`FILE_FS_DEVICE_INFORMATION`, `FILE_REMOTE_DEVICE`, and
`FILE_REMOTE_DEVICE_VSMB` bindings. Existing `Wdk_Storage_FileSystem` and
`Win32_System_IO` provide `NtQueryVolumeInformationFile`, its information class,
and `IO_STATUS_BLOCK`. Existing notices remain exact and unchanged.

## Self-Review

- The change resolves only the two accepted findings and adds no Task 16 file
  workflow or command-registry implementation.
- Existing handle-bound no-replace save, incompatible normal-save sharing,
  conservative artifact retention, no-follow checked-child traversal, exact
  identities, target-absent restore, command-authority monotonicity, close retry,
  watch completion, transactional menus, schemas/IDs, one Tauri host, browser
  fallback, CSP, and event-only capability remain unchanged.
- Unsupported grants still fail before normalization and mutation.
- The accepted review was rehashed after all work and remains byte-for-byte exact.
- No shell, unrestricted filesystem/process authority, push, or unrelated source
  change was introduced.

## Concerns

- Live execution covered fixed local `B:` NTFS. No SMB/UNC, mapped remote, ReFS,
  or VSMB project root was available; those branches are covered by the pure
  evidence classifier and fail closed.
- Verification ran on Windows x64 with Rust/Cargo 1.92.0 and Node 25.2.1. Node is
  outside the repository's declared `>=24.15.0 <25` range; the clean Node 24
  release audit remains a Task 18 gate.
- The pre-existing Vite large-chunk and Playwright color-environment warnings
  remain.
