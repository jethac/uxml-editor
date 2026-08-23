# Task 16 Implementation Report

## Status

`DONE_WITH_CONCERNS`

## Baseline

- Requested BASE: `445d4e3e70b0b98cde07176245ccb9105f9d88ed`
- Verified starting HEAD: `445d4e3e70b0b98cde07176245ccb9105f9d88ed`
- Branch: `agent/uxml-editor`
- Starting worktree: clean linked worktree
- Implementation HEAD: `74be979968d82f7837abf0f2e4c0078583d4cb9e`
- Implementation commit: `74be979 feat: complete accessible project workflow`
- Report commit: the report-only commit containing this file (self-reference;
  resolve the final HEAD with `git rev-parse HEAD`).
- Baseline command: `npm test`
- Baseline result: PASS, 40 test files and 606 tests.

## Architecture

- `FileWorkflow` is the only project/file lifecycle owner. It holds the active
  granted root, `SaveCoordinator`, `RecoveryJournal`, watch generation, and
  desktop close-state leases around the authoritative `DocumentSession`.
- `CommandRegistry` is the single command metadata, availability, shortcut,
  and execution definition consumed by toolbar, browser menus, desktop menu
  events, keyboard handling, and command palette.
- React renders derived workflow and command state only. Exact source and the
  parsed model continue to advance atomically in `DocumentSession`; no second
  visual model is introduced.
- New/Save As uses a create-new-only `HostPort` operation scoped to the selected
  project root. Existing files still require revision-checked atomic replacement.

## Red-Green Evidence

### Slice 1: Core open/save/close/reopen lifecycle

- Red command: `npm test -- src/features/workspace src/core/store/CommandRegistry.test.ts`
- Expected failure: `FileWorkflow` is not implemented.
- Observed failure: Vite could not resolve `./FileWorkflow` from
  `src/features/workspace/FileWorkflow.test.ts`; 1 suite failed while the 32
  pre-existing tests selected by the command passed.

### Slice 2: New, Save As, and scoped create-new text

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts src/core/host/MemoryHost.test.ts`
- Expected failure: the workflow and host do not yet expose New, Save As, or
  create-new text.
- Observed failure: 3 focused tests failed with `host.createText is not a
  function` and `workflow.newProject is not a function`; 21 tests passed.

### Slice 3: Browser and Tauri create-new adapters

- Red command: `npm test -- src/core/host/BrowserHost.test.ts src/core/host/TauriHost.contract.test.ts`
- Expected failure: browser and Tauri adapters do not implement the new scoped
  create operation.
- Observed failure: the two new contract tests failed with `host.createText is
  not a function`; 51 existing tests passed.

### Slice 4: Native scoped create-new command

- Red command: `cargo test --manifest-path src-tauri/Cargo.toml create_text_is_scoped_exact_and_create_new_only`
- Expected failure: the Rust request schema and command do not exist.
- Observed failure: Rust compilation failed with unresolved
  `CreateTextRequest` and missing `HostState::create`, exactly identifying the
  unimplemented boundary.

### Slice 5: Unified command registry

- Red command: `npm test -- src/core/store/CommandRegistry.test.ts`
- Expected failure: the registry module is not implemented.
- Observed failure: Vite could not resolve `./CommandRegistry`; the focused
  suite failed before collecting tests.

### Slice 6: Recovery, recent authorization, reload, and external changes

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure: recent reauthorization, recovery append integration, and
  external watch processing are not implemented.
- Observed failure: 4 focused tests failed: missing `openRecent`, absent
  recovery data, unchanged clean external bytes, and absent conflict state;
  the earlier 4 workflow tests passed.

### Slice 7: Keyboard guards and canvas Escape

- Red command: `npm test -- src/features/workspace/Accessibility.test.tsx`
- Expected failure: `KeyboardShortcuts` and the required canvas behavior are
  not implemented.
- Observed failure: Vite could not resolve `./KeyboardShortcuts`; the focused
  suite failed before collecting tests.

### Slice 8: App-owned workflow, toolbar, and command palette

- Red command: `npm test -- src/features/workspace/Accessibility.test.tsx`
- Expected failure: the existing toolbar does not yet consume the unified
  registry or expose Save and Command Palette controls.
- Observed failure: the App integration test could not find a Save button;
  1 focused test failed and the 2 lower-level keyboard/canvas tests passed.

### Slice 9: Browser Save, Discard, Cancel, and picker cancellation

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure: dirty close has only a discard/cancel prompt, and project
  replacement closes the current session before a picker succeeds.
- Observed failure: 4 focused tests failed: Save discarded bytes, only one
  decision was requested, explicit second-stage discard did not close, and the
  cancelled replacement picker was never reached; 8 workflow tests passed.

### Slice 10: Selection-derived Edit command owner

- Red command: `npm test -- src/features/workspace/WorkspaceEditingCommands.test.ts`
- Expected failure: no production adapter connects registry Edit commands to
  the established clipboard and UXML transaction APIs.
- Observed failure: Vite could not resolve `./WorkspaceEditingCommands`; the
  focused suite failed before collecting tests.

### Slice 11: Accessible external-change resolution

- Red command: `npm test -- src/features/workspace/Accessibility.test.tsx`
- Expected failure: dirty external conflicts have workflow state but no visible
  resolution surface.
- Observed failure: the test could not find the `External file changes`
  dialog; 1 focused test failed and 3 accessibility tests passed.

### Slice 12: Global Search command

- Red command: `npm test -- src/features/workspace/Accessibility.test.tsx`
- Expected failure: Search aliases Command Palette instead of activating the
  established source-editor search.
- Observed failure: the Search keyboard test timed out with the active panel
  still `hierarchy`; 1 focused test failed and 4 accessibility tests passed.

### Slice 13: Independent subscriptions and thrown `undefined`

- Red command: `npm test -- src/core/commands/CommandHistory.test.ts src/core/store/EditorStore.test.ts src/core/store/CommandRegistry.test.ts`
- Expected failure: duplicate subscriptions are collapsed by `Set`, and the
  store does not preserve a listener that throws `undefined`.
- Observed failure: each of the 3 focused subscription tests received one
  callback instead of two; 54 existing tests passed.

### Slice 14: Selection-only external-read race

- Red command: `npm test -- src/core/persistence/SaveCoordinator.test.ts`
- Expected failure: a concurrent selection generation is conflated with dirty
  source during an external read.
- Observed failure: the outcome reported `localDirty: true` and omitted the
  separate concurrent-generation signal; 1 focused test failed and 48 passed.

### Slice 15: Restore an externally deleted local file

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure: the external coordinator predates scoped create-new and
  cannot restore a deleted file from the authoritative local session.
- Observed failure: the resolved file remained absent and `readText` returned
  `not-found`; 1 focused workflow test failed and 12 passed.

### Slice 16: Axe, keyboard, and nonblank browser canvas

- Red command: `npx playwright test tests/e2e/accessibility-workflow.spec.ts`
- Expected failure: axe integration is absent before the pinned dependency;
  after installation, visible browser behavior may expose accessibility or
  geometry defects.
- Observed failures: the first run could not resolve
  `@axe-core/playwright`; after pinning it, 2 of 3 tests passed and the desktop
  workflow failed because the built-in `<UXML />` demo rendered a blank canvas.

### Slice 17: Recovery finalization after explicit external reload

- Red command: `npm test -- src/features/workspace src/core/store`
- Expected failure: final focused integration could expose recovery/lifecycle
  races across the completed workflow.
- Observed failure: 1 of 96 tests failed because Reload accepted external
  source and became clean while retaining the local recovery journal; 95 tests
  passed.

### Slice 18: Retryable external-resolution failures

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure: failed conflict resolution is removed from observable UI
  state even though the persistence coordinator retains it for retry.
- Observed failure: the pending conflict list became empty after an injected
  replacement failure; 1 focused test failed and 13 passed.

### Slice 19: Desktop Save As grant replacement

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure: selecting a Save As directory in the single-grant Tauri
  host revokes the old grant before a later overwrite cancellation.
- Observed failure: exact source remained, but the workflow incorrectly
  reported `Old Project` as reloadable instead of retaining the document as
  dirty `Untitled Project`; 1 focused test failed and 14 passed.

### Slice 20: Validate replacement before project teardown

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure: open closes the current session before the selected grant
  has been scanned and shown to contain a UXML document.
- Observed failure: an invalid replacement rejected correctly but left the
  store session `null`; 1 focused test failed and 15 passed.

## Changed Files

- Dependency and notice metadata: `package.json`, `package-lock.json`, and
  `THIRD-PARTY-NOTICES.md`.
- Native scoped create boundary: `src-tauri/src/commands.rs`,
  `src-tauri/src/lib.rs`, and `src-tauri/src/scoped_fs.rs`.
- App composition and layout: `src/app/App.tsx`, `src/app/app.css`,
  `src/features/workspace/CommandBar.tsx`,
  `src/features/workspace/Workbench.tsx`, and `src/styles/workbench.css`.
- File workflow and UI: new `FileWorkflow`, `KeyboardShortcuts`,
  `CommandPalette`, `ExternalChangeDialog`, `WorkspaceEditingCommands`, and
  `WorkspaceUiController` modules plus focused unit/component tests.
- Command ownership: new `src/core/store/CommandRegistry.ts` and tests, plus
  duplicate-listener hardening in `CommandHistory` and `EditorStore`.
- Host adapters: `HostPort`, `BrowserHost`, `MemoryHost`, and `TauriHost` plus
  their contract tests.
- Persistence: `ExternalChangeCoordinator`, `RecoveryLifecycle`,
  `SaveCoordinatorContracts`, and focused `SaveCoordinator` tests.
- Accessibility integration: `PreviewCanvas`, `useCanvasClipboard`, new
  `Accessibility.test.tsx`, and new
  `tests/e2e/accessibility-workflow.spec.ts`.
- This implementation report.

## Verification

- Initial build command: `npm run build`
- Initial build result: FAIL during `tsc --noEmit`; strict typing found a
  non-void desktop executor wrapper, incomplete null workflow fallback,
  nullable CodeMirror lookup, untyped registry callback destructuring, and
  two mock-function intersection declarations. These were compile-only
  integration defects and were corrected before final verification.
- Final focused command:
  `npm test -- src/features/workspace src/core/store`
- Final focused result: PASS, 6 files and 100 tests in 12.45 seconds.
- Final complete command: `npm test`
- Final complete result: PASS, 44 files and 641 tests in 59.12 seconds.
- Final web build command: `npm run build`
- Final web build result: PASS; TypeScript passed and Vite transformed 1,914
  modules. Vite emitted only its non-failing greater-than-500 kB chunk warning
  (main JS 1,053.02 kB, gzip 335.91 kB).
- Final browser command: `npm run test:e2e`
- Final browser result: PASS, 16 of 16 Playwright tests in 38.1 seconds.
- Native formatting: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
  PASS. One earlier check found formatting changes; `cargo fmt` was applied and
  the final check passed.
- Native tests: `cargo test --manifest-path src-tauri/Cargo.toml` PASS, 84
  library tests, 0 failures; main and doc targets contained 0 tests.
- Native compile: `cargo check --manifest-path src-tauri/Cargo.toml` PASS.
- Native lint:
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  PASS with no warnings.
- Desktop build: `npm run tauri:build -- --no-bundle` PASS; the release
  executable was produced after the configured frontend build.
- Hygiene: `git diff --check` reported no whitespace errors. Package auditing
  found no ranged npm dependency and confirmed `uxml-preview` is exactly
  `0.4.0`.

## Browser, Keyboard, Axe, And Visual Evidence

- The Task 16 Playwright spec executes `AxeBuilder.analyze()` after opening the
  demo project and asserted the actual result `violations = []`.
- Keyboard-only coverage tabs from page entry to the accessible `Open Project`
  button, opens it with Enter, opens the command palette with
  `Control+Shift+P`, verifies its named search box receives focus, closes it
  with Escape, and verifies focus returns to the canvas.
- Canvas Escape is exercised again after palette dismissal and keeps focus on
  the named `Canvas editing area`, preserving the established clear-selection
  behavior without focus loss.
- Hierarchy keyboard coverage focuses the named document tree and verifies
  ArrowRight expansion plus ArrowDown traversal. Inspector coverage verifies
  the `Name` and `Classes` labels and the icon-only `Remove selected` command's
  accessible name and tooltip title.
- Component tests also cover editable-target shortcut guards for input,
  contenteditable, and CodeMirror targets, while canvas/global commands remain
  available outside those targets.
- Desktop `1366x768` and compact `720x768` screenshots were inspected. Both
  show the demo Button in a nonblank renderer, contain all content within the
  viewport, and have no overlapping controls or text. The compact layout moves
  supporting panes into keyboard-accessible tabs below the canvas.
- Geometry assertions prove document width/height do not exceed the viewport
  and canvas/renderer width/height are nonzero. The disabled Save button's
  bounding box is byte-for-byte equal before and after it becomes enabled,
  demonstrating stable control dimensions.
- The pre-existing responsive geometry suite also passed at 1920, 1366, 1024,
  and 720 pixel widths.

## Dependency And License Changes

- Added development-only `@axe-core/playwright` exactly `4.13.0`; the lockfile
  resolves its `axe-core` dependency exactly `4.13.0`.
- Added both packages, versions, integrity values, MPL-2.0 license, source
  links, and license-location notice to `THIRD-PARTY-NOTICES.md`.
- No runtime dependency changed. All npm versions remain exact and
  `uxml-preview` remains exactly `0.4.0`.
- Original Apache-2.0 project licensing and all prior third-party notices are
  preserved.

## Requirement Checklist

- [x] New, open, open recent, save, Save As, save all, close, reopen, explicit
  reload, and external-change decisions work through one `FileWorkflow` owner
  in browser and desktop modes.
- [x] Recent entries are display metadata only; opening one always reacquires a
  host grant and never turns metadata into path authority.
- [x] `DocumentSession` remains the sole source of exact source and parsed
  state. Opens, reloads, recovery, and external adoption use its atomic APIs;
  no second visual document model was added.
- [x] The native command IDs remain exactly `file.open-project`, `file.save`,
  `file.save-all`, and `file.close-project`. One frontend `CommandRegistry`
  supplies toolbar, desktop event, shortcut, and palette paths.
- [x] `Task16FileLifecyclePort` is owned in `App` and implements
  `runExclusiveCloseState`, `finalValidateCloseState`, `saveBeforeClose`, and
  `Task16FileCommandPort` without weakening monotonic desktop ownership.
- [x] Platform command definitions cover file lifecycle, undo/redo,
  cut/copy/paste, duplicate/delete, zoom, search, diagnostics, and panes.
  Availability derives from current workflow/editor state.
- [x] Disabled commands remain rendered in stable layout. Lucide icons are
  retained and unfamiliar icon-only commands retain accessible names/tooltips.
- [x] Shortcut handling preserves native editable behavior for form controls,
  contenteditable, and CodeMirror and uses platform primary-modifier
  conventions.
- [x] Browser-first boundaries are preserved: native work crosses `HostPort`;
  no project execution, upload, telemetry, mandatory network, broad path,
  shell, or process authority was added. Production Tauri imports remain only
  in the existing `src/app/TauriRuntime.ts` boundary.
- [x] Scoped create is create-new-only on native hosts and confined to the
  selected project grant. Existing writes retain revision-checked atomic
  replacement and symlink/reparse protections.
- [x] Open/save without edits uses the session's exact source and remains
  byte-identical. Unsupported or malformed source remains present with explicit
  diagnostics.
- [x] External conflicts remain retryable on failure; deleted files can be
  restored from authoritative local source; reload finalizes recovery state.
- [x] Browser Save/Discard/Cancel, picker cancellation, invalid replacement,
  Save As grant replacement, close/reopen, and recovery races have focused
  regression tests.
- [x] Axe, keyboard-only navigation, accessible names, focus order, hierarchy
  navigation, inspector labels, icon tooltips, dialog focus return, and canvas
  Escape have automated evidence.
- [x] Desktop and 720px browser screenshots and geometry checks show a nonblank
  canvas, stable controls, no overflow, and no overlap.
- [x] Every production slice followed an observed focused failure recorded
  above before its implementation.
- [x] The native boundary was changed, so Rust format, test, check, clippy, and
  desktop build verification were run.
- [x] No push or pull request was performed.

## Self-Review

- Reviewed all changes against the brief, the prior desktop bridge/lifecycle
  contracts, and the browser-first authority boundary.
- Confirmed failure paths do not tear down a valid project before replacement
  validation, do not hide retryable external conflicts, and do not retain a
  revoked Tauri Save As grant as reopenable authority.
- Confirmed editor mutations use established command history/clipboard/UXML
  transactions and all UI derives from `DocumentSession` and existing stores.
- The Task 7 deferred localDirty/recovery races were directly exercised and
  fixed with separate concurrent-session signaling and reload recovery cleanup.
  The Task 9 duplicate subscription/listener-throw cleanup was directly
  exercised and fixed in `CommandHistory`, `EditorStore`, and the new registry.
- No unrelated refactor, generated asset, production dependency, runtime
  network behavior, or third-party notice removal was introduced.
- No independent review agent was available in this environment; the final
  diff and requirements audit were performed manually and backed by the full
  automated matrix above.

## Concerns

- Commands ran under Node `25.2.1`, outside the project's declared
  `>=24.15.0 <25` range, so npm emitted `EBADENGINE`; all required commands
  nevertheless passed. CI should continue using the declared Node 24 line.
- Browser File System Access does not expose native exclusive-create flags.
  Browser `createText` is scoped to the explicit directory grant and rejects a
  file observed to exist, but an external actor can race that best-effort check.
  Native and memory hosts enforce true create-new-only semantics.
- Vite retains its non-failing large-chunk warning. Playwright retains the
  pre-existing `NO_COLOR`/`FORCE_COLOR` warning from its server environment.
  Neither changed behavior or test results.

---

# Task 16 Fix Round 1/5

## Fix Status

`DONE_WITH_CONCERNS`

## Fix Baseline And Commits

- Review BASE and verified starting HEAD:
  `db83384db93ff3b2f2e79e0b9a8b0530109f7f91`
- Branch: `agent/uxml-editor`
- Starting worktree: clean
- Implementation HEAD: `407d53658025d01ecf6c9194ca1985edb030f0af`
- Implementation commit: `407d536 fix: address Task 16 review findings`
- Report commit: the report-only commit containing this append (self-reference;
  resolve final HEAD with `git rev-parse HEAD`).
- No push or pull request was performed.

## Fix Red-Green Evidence

### Finding 1: Discard Owns Recovery Cleanup

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure before production change: discard-confirmed close and
  replacement leave the recovery journal available, and cleanup failure closes
  the session instead of aborting visibly.
- Observed red: 3 of 20 tests failed. Reopen restored `Race` instead of the
  exact disk `Play` source in both lifecycle regressions, and injected recovery
  cleanup failure left the session null.
- Green command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Green result after the initial slice: 20/20 tests passed.
- Self-review red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure: same-root replacement must clear recovery before replaying
  the selected root.
- Observed red: 1 of 28 tests failed; same-root replacement restored `Race`.
- Final green: 28/28 tests passed after moving recovery replay behind validated
  discard cleanup.

### Finding 2: One Recovery Serialization Authority

- Red command: `npm test -- src/core/persistence/RecoveryJournal.test.ts src/features/workspace/FileWorkflow.test.ts`
- Expected failure: `prepareSave`, append, recover, and clear can overtake a
  blocked append, and ordinary Save can write before active recovery settles.
- Observed red: 2 of 44 tests failed. Journal writes advanced out of order and
  ordinary Save reached replacement while the append gate remained blocked.
- Green result: 44/44 tests passed. `RecoveryJournal` now queues all four
  operations on one non-poisoning tail; Save and Save All await the active
  workflow recovery tail and propagate its failure.

### Finding 3: Browser Exclusive Create Is Unsupported

- Red command: `npm test -- src/core/host/BrowserHost.test.ts`
- Expected failure: browser File System Access must reject create without
  resolving or creating a file handle, while demo-memory creation remains
  deterministic.
- Observed red: 2 of 16 tests failed. An existing target returned
  `stale-revision`, and a missing target was created.
- Green result: 16/16 tests passed. Browser FSA `createText` returns typed
  `unsupported` without touching the target; memory/demo behavior is unchanged.

### Finding 4: Shared Command Metadata

- Frontend red command: `npm test -- src/core/store/CommandRegistry.test.ts`
- Expected failure: the registry must load one declarative command source.
- Observed red: the JSON authority was unresolved and the suite could not run.
- Rust red command:
  `cargo test --manifest-path src-tauri/Cargo.toml native_menu_metadata_matches_the_shared_declarative_command_source`
- Expected failure: native menu identity, labels, sections, and current-platform
  accelerators must derive from that same source.
- Observed red: Rust compilation failed because the shared source did not exist.
- Green results: frontend registry 6/6; Rust contract 1/1; registry plus desktop
  bridge 10/10. Save As is `Ctrl/Meta+Shift+S`; Save All is
  `Ctrl/Meta+Alt+S`. Native command IDs remain exact.

### Finding 5: One App Workflow Owner

- Red command:
  `npm test -- src/app/App.test.tsx src/app/App.desktop.test.tsx src/core/store/CommandRegistry.test.ts`
- Expected failure: host-plus-injected lifecycle must use the injected owner for
  rendered state, registry, native commands, and close leases; only an owned
  workflow may be disposed.
- Observed red: 3 of 18 tests failed. Native Save did not reach the injected
  owner, rendered status came from an internal owner, and the owned watcher was
  not disposed on unmount.
- Green result: 24/24 tests passed. `Task16FileLifecyclePort` now exposes the
  complete workflow port and `App` selects exactly one owner.

### Finding 6: Capabilities And One Error Boundary

- Red command:
  `npm test -- src/core/store/CommandRegistry.test.ts src/features/workspace/Accessibility.test.tsx src/app/App.desktop.test.tsx`
- Expected failure: explicit false capabilities disable file commands and every
  invocation surface contains rejected execution in one visible boundary.
- Observed red: 6 of 29 tests failed and one rejected command was unhandled.
  Toolbar, palette, shortcut, and native paths did not show the alert dialog.
- Green result: 29/29 tests passed with no unhandled rejection. Workflow
  snapshots publish explicit file capabilities; `CommandRegistry` is the sole
  execution boundary and `WorkspaceUiController` owns the named command-error
  alert dialog.

### Finding 7: Editable Shortcut Semantics

- Red command: `npm test -- src/features/workspace/Accessibility.test.tsx`
- Expected failure: file and pane commands remain global from editable targets,
  text-conflicting edit/search commands remain native, and physical Shift for
  `Ctrl++`/`Meta++` is normalized.
- Observed red: 2 of 9 tests failed. Focused-input Save was blocked and zoom
  remained `1` instead of `1.1`.
- Green result: 9/9 tests passed. Input, contenteditable, and CodeMirror only
  suppress edit/search conflicts; file, pane, zoom, diagnostics, and palette
  commands remain available.

### Finding 8: Shared Modal Focus Authority

- Red command: `npm test -- src/features/workspace/Accessibility.test.tsx`
- Expected failure: palette and external-change dialogs must wrap Tab and
  Shift+Tab, resolve Escape safely, and restore prior focus after Escape or an
  explicit decision.
- Observed red: 3 of 10 tests failed. Focus did not wrap, external Escape did
  nothing, and external resolution returned focus to `body`.
- Green result: 10/10 tests passed. `useModalFocus` is shared by palette,
  external-change, and command-error dialogs. External Escape invokes the
  existing `cancel` decision and never drops pending state silently.

### Finding 9: Deterministic Save As Outcomes

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure: all known destination revisions are preflighted before the
  first write, and create/replace failures expose aggregate written and pending
  path sets while retaining source authority and recovery.
- Observed red: 3 of 24 tests failed. Raw `HostError` escaped in all cases, and
  stale second-file detection occurred after the first file was replaced.
- Green result: 24/24 tests passed. `SaveAsPartialError` freezes sorted written
  and pending paths, the host shows the same path lists, and no rollback is
  claimed. Installation occurs only after every write and post-write read
  succeeds.

### Finding 10: Central Runtime Installation And Retirement

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`
- Expected failure: Close waits for watcher disposal completion, failed
  completion is reported while retaining the exact source, and callbacks after
  retirement cannot publish.
- Observed red: 2 of 27 tests failed. Close settled before the completion gate
  and ignored a failed disposal result; the stale-callback test already passed.
- Green result: 27/27 tests passed. Open, Save As, close, grant detachment,
  replacement, and App disposal use one runtime installer/retirer. Retirement
  marks the runtime stale before unsubscribe/dispose, drains recovery, awaits
  watcher completion, and falls back to an untitled authoritative session on
  failure with a visible `Project cleanup failed` message.

## Final Green Verification

- Covering matrix:
  `npm test -- src/features/workspace/FileWorkflow.test.ts src/core/persistence/RecoveryJournal.test.ts src/core/host/BrowserHost.test.ts src/core/store/CommandRegistry.test.ts src/features/workspace/Accessibility.test.tsx src/app/App.test.tsx src/app/App.desktop.test.tsx`
  - PASS: 7 files, 104/104 tests.
- Brief focused matrix: `npm test -- src/features/workspace src/core/store`
  - Initial integration run exposed a test-only missing `vi` import:
    1 failed, 117 passed.
  - Final PASS: 6 files, 119/119 tests.
- Full frontend suite: `npm test`
  - PASS: 44 files, 667/667 tests.
- TypeScript: `npx tsc --noEmit`
  - PASS, no diagnostics.
- Production frontend: `npm run build`
  - PASS, 1,917 modules transformed; only the existing non-failing large-chunk
    warning remains.
- Shared native metadata contract:
  `cargo test --manifest-path src-tauri/Cargo.toml native_menu_metadata_matches_the_shared_declarative_command_source`
  - PASS: 1/1, 84 filtered.
- Focused desktop Rust:
  `cargo test --manifest-path src-tauri/Cargo.toml desktop::tests`
  - PASS: 18/18, 67 filtered.
- Full Rust: `cargo test --manifest-path src-tauri/Cargo.toml`
  - PASS: 85/85 library tests; 0 main tests; 0 doc tests.
- Rust quality: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`,
  `cargo check --manifest-path src-tauri/Cargo.toml`, and
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  - PASS. The first format check observed formatter-only wrapping; `cargo fmt`
    was applied and the final check passed.
- Desktop release boundary: `npm run tauri:build -- --no-bundle`
  - PASS; release executable built at `src-tauri/target/release/uxml-editor.exe`.
- Focused non-geometry Playwright:
  `npx playwright test tests/e2e/accessibility-workflow.spec.ts --grep "workflow has no automated axe violations and is keyboard operable"`
  - PASS: 1/1 in 15.2 seconds.

## Browser, Keyboard, Axe, And Visual Evidence

- The final Playwright run opened the real demo workflow, asserted the canvas
  renderer was nonempty, ran actual `AxeBuilder.analyze()`, and found zero
  violations.
- Keyboard-only Playwright opened the project with Enter, opened the palette
  with `Control+Shift+P`, verified the named search field received focus,
  dismissed with Escape, verified focus returned to the named canvas, and
  verified canvas Escape retained focus.
- Component keyboard coverage additionally proves focused input Save,
  contenteditable pane switching, CodeMirror-native copy, physical-Shift zoom,
  modal Tab wrapping, safe external Escape, explicit reload, and focus return.
- The deliberately excluded canvas heading/toolbar/grid and their geometry
  tests were not edited. The desktop and 720px screenshots and nonblank/no-
  overlap geometry evidence already recorded in the main report therefore
  remain the applicable visual baseline for this fix wave.

## Changed Files

- Shared command/native authority: `src/core/store/CommandDefinitions.json`,
  `src/core/store/CommandRegistry.ts`,
  `src/core/desktop/DesktopCommandBridge.ts`, `src-tauri/src/desktop.rs`.
- Workflow/persistence/host: `src/features/workspace/FileWorkflow.ts`,
  `src/core/persistence/RecoveryJournal.ts`, `src/core/host/BrowserHost.ts`.
- App and accessible UI: `src/app/App.tsx`,
  `src/features/workspace/CommandBar.tsx`,
  `src/features/workspace/CommandPalette.tsx`,
  `src/features/workspace/ExternalChangeDialog.tsx`,
  `src/features/workspace/KeyboardShortcuts.tsx`,
  `src/features/workspace/Workbench.tsx`,
  `src/features/workspace/WorkspaceUiController.ts`,
  `src/features/workspace/CommandErrorDialog.tsx`, and
  `src/features/workspace/useModalFocus.ts`.
- Focused tests: `src/app/App.test.tsx`, `src/app/App.desktop.test.tsx`,
  `src/core/host/BrowserHost.test.ts`,
  `src/core/persistence/RecoveryJournal.test.ts`,
  `src/core/store/CommandRegistry.test.ts`,
  `src/features/workspace/Accessibility.test.tsx`,
  `src/features/workspace/FileWorkflow.test.ts`, and
  `src/features/workspace/WorkspaceEditingCommands.test.ts`.
- Evidence: `.superpowers/sdd/2026-08-15-uxml-editor/task-16-report.md`.
- No excluded canvas layout/geometry file was changed.

## Dependency And License Audit

- No dependency or version changed in this fix wave; `package.json` and
  `package-lock.json` are unchanged.
- `uxml-preview` remains exactly `0.4.0` in both files.
- All npm dependency versions remain exact. No notice or license file changed;
  existing Apache-2.0 and third-party notices are preserved.

## Fix Requirement Checklist

- [x] Discard awaits and clears serialized recovery; failure aborts visibly.
- [x] Same-root, close/reopen, and replacement/reopen regressions prove
  discarded edits cannot return.
- [x] Save and Save All await the same journal serialization authority.
- [x] Browser FSA exclusive create is unavailable without target mutation;
  deterministic demo/memory and native create-new remain intact.
- [x] One declarative metadata source drives registry, toolbar/palette/
  shortcuts, desktop bridge allowlisting, and native menu construction.
- [x] Native file command IDs remain exact and generation-safe defaults remain
  unchanged until App binds the Task 16 owner.
- [x] App selects one injected-or-owned workflow for rendering, commands, and
  lifecycle; only an owned workflow is disposed.
- [x] File availability is explicit and state-derived; disabled controls remain
  rendered with stable dimensions.
- [x] Toolbar, palette, shortcut, and native errors converge on one visible,
  contained command-error boundary.
- [x] Editable shortcuts preserve native text conventions while global file,
  pane, zoom, diagnostics, and palette commands remain available.
- [x] Shared modal focus covers names, containment, Escape resolution, explicit
  resolution, and return focus.
- [x] Save As preflights known revisions and reports real partial outcomes
  without claiming rollback; source `DocumentSession` and recovery remain
  authoritative until complete installation.
- [x] Runtime setup/teardown is centralized, completion-aware, stale-safe, and
  used by App unmount.
- [x] `DocumentSession` remains the sole exact-source/parsed-state authority; no
  visual model or native authority was added.
- [x] Browser-first HostPort boundaries, byte identity, malformed-source
  preservation, no execution/upload/telemetry/network/shell/process authority,
  and existing production Tauri import boundaries remain unchanged.
- [x] The Task 7 recovery-phase race was directly exercised and fixed by the
  serialized journal/save tails. Task 9 subscription cleanup was directly
  exercised by centralized runtime retirement; its existing listener-throw
  containment required no additional change in this round.
- [x] No excluded layout files were touched and no push/PR was performed.

## Fix Self-Review

- Reviewed all 11 findings, the brief constraints, the final diff, and the
  shared command/native contract. Finding 11 is recorded as a toolchain concern
  rather than a supported pass.
- Confirmed all replacement mutation occurs only after picker selection,
  destination validation/confirmation, discard finalization, and Save As
  revision preflight. Picker cancellation and invalid roots retain the current
  session and recovery.
- Confirmed active callbacks check retirement/current identity before publish,
  and watcher completion failure cannot silently close or replace the exact
  source session.
- Confirmed `git diff --check` passed apart from informational line-ending
  conversion warnings, dependency files are unchanged, and production Tauri
  imports remain confined to the existing runtime boundary.

## Fix Concerns

- Node 24 is not installed (`nvm list` contains only `25.2.1`). All npm,
  Playwright, TypeScript, build, and Tauri frontend commands therefore ran on
  unsupported Node `25.2.1`, outside `>=24.15.0 <25`. This report does not claim
  a supported-toolchain pass; the controller still needs to run the Node 24
  matrix.
- Vite retains its existing non-failing large-chunk warning. Playwright retains
  the existing `NO_COLOR`/`FORCE_COLOR` warning.
- The browser FSA host now intentionally disables New Project and Save As
  because that API cannot guarantee exclusive create. Demo-memory and desktop
  modes retain the complete creation workflow.

## Controller-Supplied Supported Toolchain Verification

The controller resolved Finding 11 with a portable Node runtime after the fix
wave stabilized. No machine-wide runtime or dependency pin was changed.

- Runtime: Node `24.15.0`, npm `11.6.2`.
- Full frontend: `npm test` under Node 24.
  - PASS: 44 files, 667/667 tests.
- Production frontend: `npm run build` under Node 24.
  - PASS: 1,917 modules transformed; output included
    `dist/assets/index-D_SzMJ8_.js` at 1,060.42 kB (337.61 kB gzip).
  - The already-recorded non-failing chunk-size warning remains.
- Focused accessibility browser workflow under Node 24:
  `playwright test tests/e2e/accessibility-workflow.spec.ts --grep
  "workflow has no automated axe violations and is keyboard operable"`.
  - PASS: 1/1 in 17.1 seconds.
  - The already-recorded `NO_COLOR`/`FORCE_COLOR` warning remains.
- Desktop release boundary: `npm run tauri:build -- --no-bundle` under Node 24.
  - PASS: the frontend rebuilt under Node 24 and Rust completed the optimized
    release profile; `src-tauri/target/release/uxml-editor.exe` was produced.

Finding 11 is therefore resolved with evidence from the declared
`>=24.15.0 <25` runtime range.
