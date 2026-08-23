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

---

## Fix Round 2/5

### Status And Revision

- Status: `DONE_WITH_CONCERNS`.
- Fix base: `54fff984187915b797836bd00289cac8e0cdc3df`.
- Branch: `agent/uxml-editor`.
- Implementation/report commit SHA is recorded in the round-finalization
  addendum after the implementation commit is created.
- No push or PR was performed.

### Finding 1: Aggregate Every Post-Write Save As Failure

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Expected failure: post-write readback, destination rescan, target watcher
  preparation, and source retirement failures must throw
  `SaveAsPartialError` with frozen exact sorted paths, retain the original
  session/recovery authority, show the partial outcome, and dispose staged
  target resources.
- Observed red: 4 failed and 28 passed (32 total). Each injection escaped as a
  raw `HostError` instead of the required aggregate error.
- Production change: target runtime/recent state is prepared before source
  retirement. Every failure after completed writes is routed through the one
  aggregate outcome path; staged target runtime is retired on failure.
- Green command: `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Green result: 32/32 passed.

### Finding 2: Retain The Owned Workflow Across Desktop Replacement

- Red command: `npm test -- src/app/App.test.tsx`.
- Expected failure: replacing only the desktop prop must retain the owned
  workflow, exact session, watcher, and subscribers; unmount disposes once and
  reports asynchronous disposal failure through the latest desktop error port.
- Observed red: 1 failed and 6 passed (7 total). Desktop rerender disposed the
  retained watcher.
- Production change: the ownership cleanup effect depends only on the owned
  workflow. A ref supplies the latest desktop error port to asynchronous
  unmount cleanup without making desktop identity an ownership dependency.
- The first green attempt exposed a test-harness error because its watcher mock
  replaced the real `MemoryHost` watcher. The mock was corrected to wrap the
  real watcher so the test proves live external reload behavior.
- Green command: `npm test -- src/app/App.test.tsx`.
- Green result: 7/7 passed.

### Finding 3: Prepare Replacement Targets Before Discard Finalization

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Expected failure: malformed target recovery, watcher setup failure, recent
  metadata failure, or discard cleanup failure must retain the exact dirty,
  watched source and byte-identical recovery, disposing any staged target.
- Observed red: 4 failed and 32 passed (36 total). Three cases erased source
  recovery; the discard-cleanup abort did not dispose its staged watcher.
- Production change: scan/read, recovery replay, watcher/history setup, and
  recent metadata preparation now complete before source recovery is cleared
  or source authority is retired. Same-root explicit discard reconstructs the
  pristine scanned session only after validating target recovery. All aborts
  retire staged resources.
- Green command: `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Green result: 36/36 passed.

### Finding 4: Exact Native File Command Availability

- TypeScript App red command:
  `npm test -- src/app/App.desktop.test.tsx`.
- Expected failure: the native menu must receive exact no-session, untitled,
  and active states from the registry, while direct activation of an
  unavailable command remains contained and side-effect-free.
- Observed red: 1 failed and 14 passed (15 total). App published boolean
  `true` instead of the four-command availability object.
- Tauri adapter red command: `npm test -- src/app/TauriRuntime.test.ts`.
- Expected failure: IPC must emit an exact availability object and reject
  missing, extra, or non-boolean keys before invocation.
- Observed red: 5 failed and 9 passed (14 total). The adapter emitted the old
  `enabled` field and accepted all four malformed values.
- Rust red command:
  `cargo test --manifest-path src-tauri/Cargo.toml desktop::tests`.
- Expected failure: Rust must deserialize the exact four-key contract and
  transactionally transition no-session, untitled, active, mixed rollback,
  and stale-generation states.
- Observed red: compilation failed because
  `NativeFileCommandAvailability` did not exist and the transition helper still
  inferred a single boolean.
- Production change: native file IDs are filtered from the shared declarative
  command definitions and typed as one exact map. App subscribes to the same
  `CommandRegistry` snapshot used by every other command surface, serializes
  updates, publishes all-false on teardown, and preserves the monotonic owner
  gate. Tauri validates and freezes the exact IPC value. Rust denies unknown
  fields, reads every prior state before writes, restores all successfully
  changed items on failure, and commits a generation only after success.
  Native Open Project now also starts disabled until Task 16 binds ownership.
- First compatibility rerun: Tauri passed 14/14 and Rust passed 19/19; five
  legacy App assertions still modeled the old boolean contract. Those tests
  were updated to assert exact all-enabled/all-disabled maps without changing
  lifecycle behavior.
- Final green commands/results:
  - `npm test -- src/app/App.desktop.test.tsx`: 15/15 passed.
  - `npm test -- src/app/TauriRuntime.test.ts`: 14/14 passed.
  - `cargo test --manifest-path src-tauri/Cargo.toml desktop::tests`: 19/19
    passed; 67 filtered out; 0 main tests.

### Round 2 Green Verification

- Covering matrix:
  `npm test -- src/features/workspace/FileWorkflow.test.ts src/app/App.test.tsx src/app/App.desktop.test.tsx src/core/store/CommandRegistry.test.ts`
  - PASS: 4 files, 66/66 tests.
- Brief matrix: `npm test -- src/features/workspace src/core/store`
  - PASS: 6 files, 127/127 tests.
- Full frontend: `npm test -- --reporter=dot`
  - PASS: 44 files, 682/682 tests in 52.09 seconds.
- TypeScript: `npx tsc --noEmit`
  - PASS, no diagnostics.
- Production frontend: `npm run build`
  - PASS: 1,917 modules transformed. Output included
    `dist/assets/index-Dl33MfwH.js` at 1,061.90 kB (337.94 kB gzip).
- Rust formatting:
  `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
  - Initial check found two formatter-only test wraps. `cargo fmt` was applied;
    final check PASS.
- Full Rust: `cargo test --manifest-path src-tauri/Cargo.toml`
  - PASS: 86/86 library tests; 0 main tests; 0 doc tests.
- Rust quality: `cargo check --manifest-path src-tauri/Cargo.toml` and
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  - PASS.
- Focused accessibility Playwright:
  `npx playwright test tests/e2e/accessibility-workflow.spec.ts --grep "workflow has no automated axe violations and is keyboard operable"`
  - PASS: 1/1 in 14.6 seconds.
- Desktop release boundary: `npm run tauri:build -- --no-bundle`
  - PASS: release executable produced at
    `src-tauri/target/release/uxml-editor.exe`.

### Browser, Keyboard, Axe, And Visual Evidence

- The focused Playwright scenario ran a real `AxeBuilder.analyze()` scan with
  zero violations and completed the keyboard-only open, command-palette focus,
  Escape focus-return, named canvas focus, and canvas Escape assertions.
- Round 2 changes no visual layout or canvas rendering code. The excluded
  canvas heading, toolbar, grid, geometry files, and their tests were not
  touched. The previously recorded desktop and 720px nonblank/no-overlap visual
  baseline remains applicable.
- Component tests additionally prove the exact native state progression and
  side-effect-free unavailable native activation.

### Changed Files

- Workflow: `src/features/workspace/FileWorkflow.ts` and
  `src/features/workspace/FileWorkflow.test.ts`.
- App ownership/native publication: `src/app/App.tsx`, `src/app/App.test.tsx`,
  and `src/app/App.desktop.test.tsx`.
- Tauri frontend boundary: `src/app/TauriRuntime.ts` and
  `src/app/TauriRuntime.test.ts`.
- Shared native identity/defaults: `src/core/desktop/DesktopCommandBridge.ts`
  and `src/core/store/CommandDefinitions.json`.
- Rust boundary/transaction: `src-tauri/src/desktop.rs` and
  `src-tauri/src/lib.rs`.
- Evidence: this append-only report.

### Dependency And License Audit

- No npm or Rust dependency/version changed. `package.json`,
  `package-lock.json`, and Cargo dependency manifests are unchanged.
- `uxml-preview` remains exactly `0.4.0` in `package.json` and
  `package-lock.json`.
- No license or notice changed; Apache-2.0 original code and all existing
  third-party notices are preserved.

### Round 2 Requirement Checklist

- [x] Every tested failure after completed Save As writes reports frozen exact
  written/pending paths, shows the partial outcome, retains the original
  session/recovery authority, and disposes staged target runtime.
- [x] Desktop prop replacement retains one owned workflow; unmount disposes it
  once and asynchronous failure reaches the latest desktop error port.
- [x] Replacement target recovery, watcher/runtime, and recent metadata work is
  staged before source discard/retirement; aborts retain exact dirty source
  bytes, recovery, and watch authority.
- [x] Exact native file availability is state-derived from `CommandRegistry`,
  generation-safe, serialized, schema-validated, and transactionally restored
  on partial native failure.
- [x] No-session, untitled, active, stale generation, partial update, malformed
  IPC, and unavailable direct activation are covered in TypeScript and Rust.
- [x] `DocumentSession` remains the sole exact source/parsed-state authority;
  no second visual model or filesystem authority was added.
- [x] Native work remains behind the existing HostPort/Tauri runtime boundary;
  command IDs remain exact and no execution, upload, telemetry, network,
  shell/process, or broad path authority was introduced.
- [x] Byte-preserving open/save behavior and malformed/unsupported diagnostic
  behavior were not changed.
- [x] No excluded layout/geometry file or test, dependency, license, or notice
  was changed; no push or PR was performed.

### Round 2 Self-Review

- Reviewed every round-2 finding, production diff, test diff, shared command
  schema, native generation gate, and replacement ordering.
- Confirmed App menu transitions are serialized per owner, teardown is queued
  after prior updates, stale generations cannot regain ownership, and failed
  registry-driven updates are contained through the desktop error port.
- Confirmed Rust reads all four prior menu states before mutation, rolls back
  every successfully changed state in reverse order, and leaves generation
  unchanged when transition or rollback reports failure.
- Confirmed target watcher/history callbacks cannot publish before activation
  or after staged retirement, and Save As does not claim rollback of completed
  destination writes.
- The Task 7 recovery serialization and Task 9 listener-throw containment
  remain on their established fixes. This round directly exercises recovery
  and subscription cleanup but required no additional ledger-wide refactor.
- `git diff --check` passed apart from informational CRLF conversion warnings.

### Round 2 Concerns

- This agent environment provides Node `25.2.1` with npm `11.6.2`, outside the
  declared `>=24.15.0 <25` range. All round-2 frontend, build, Playwright, and
  Tauri frontend commands passed on Node 25, but this report does not claim a
  supported-runtime pass for the new wave. Per the findings, the controller
  will independently rerun Node 24 after commit.
- Full Vitest emitted a pre-existing warning at
  `src/core/host/BrowserHost.test.ts:74` for an unawaited
  `expect(...).resolves` assertion. That file is unchanged in round 2 and all
  682 tests passed; it was left outside the exact findings scope.
- Vite retains the existing non-failing large-chunk warning. Playwright retains
  the existing `NO_COLOR`/`FORCE_COLOR` warning.

### Round 2 Commit Finalization

- BASE: `54fff984187915b797836bd00289cac8e0cdc3df`.
- Implementation/report HEAD:
  `8a0604804c72e0c720c413deed9fd9a17ed07742`.
- Commit: `8a0604804c72e0c720c413deed9fd9a17ed07742`
  (`fix: address Task 16 round 2 findings`).
- This SHA contains all production changes, focused tests, and the complete
  round-2 red/green evidence above. The following report-only commit records
  this immutable implementation SHA.

---

## Fix Round 3/5

### Status And Revision

- Status: `DONE_WITH_CONCERNS`.
- Fix base: `c39b86486bf09f25b2c66433f90804707085ef43`.
- Branch: `agent/uxml-editor`.
- The immutable implementation/report SHA is recorded in the round-finalization
  addendum after the implementation commit is created.
- No push or PR was performed.

### Finding 1: Restore Source Authority After Retirement Failure

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Expected failure: a source watcher completion failure after destination
  writes/staging must retain the exact source session, root/name, assets,
  Save All/reload capabilities, recovery bytes, history journaling, and a live
  watcher through a fresh runtime while disposing the staged target and
  returning one exact `SaveAsPartialError`.
- Observed red: 1 failed and 35 passed (36 total). The first authority assertion
  received an empty project-asset catalog instead of
  `Assets/Main.uxml` and `Assets/Second.uxml`, confirming the existing fallback
  had converted the source project into Untitled authority.
- Production change: runtime history/watch setup is separated from recent
  metadata preparation. Save As retirement failure now creates a fresh
  `ActiveProject` runtime object around the same source root, exact
  `DocumentSession`, `SaveCoordinator` baselines, `RecoveryJournal`, and
  recovery queue. The failed runtime remains retired and cannot publish.
- The strengthened test manually delivers the retired watcher callback and
  proves it is inert, observes a real external source conflict through the new
  watcher, makes a subsequent local edit, and disposes/reopens the source to
  prove recovery replays the exact local bytes.
- Green command: `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Green result: 36/36 passed.

### Finding 2: Guard Concurrent Source Mutation Across Save As

- Red command: `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Expected failure: deterministic source transactions during destination
  preflight, between writes, target watcher/recent preparation, and pending
  source watcher disposal must abort at the exact written/pending boundary,
  retain or restore source authority/recovery, dispose staged target runtime,
  and never activate stale target baselines.
- Initial observed red: 4 failed and 36 passed (40 total). Three tests reported
  that Save As incorrectly completed; the preparation test timed out because
  its test spy was installed after source open and therefore gated recent-read
  call 2 instead of target call 1.
- The test-only call counter was corrected before production work.
- Corrected red command:
  `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Corrected observed red: 4 failed and 36 passed (40 total). Every gate failed
  with `Expected Save As to fail`, proving all four source mutations escaped
  detection and stale target authority was activated.
- Production change: Save As captures the exact source session, generation,
  active runtime, asset paths, and source snapshot before picker work. It
  validates the same session/generation after every picker, scan, confirmation,
  preflight read, destination write, readback, target watch/recent, and source
  retirement boundary. A change before writing reports 0 written/all pending;
  a change after a completed write includes that path as written; later changes
  report all completed writes and no pending paths.
- Source history remains subscribed until watcher retirement settles. It may
  append recovery while the runtime is retirement-gated, but cannot publish.
  The listener is then removed before the final recovery-tail drain. A
  post-retirement generation mismatch restores a fresh source runtime from the
  original root/session/save/recovery authority before the aggregate error is
  reported.
- Each gate test disposes/reopens the source and proves recovery yields the
  exact concurrent values `Preflight`, `Between`, `Prepared`, and `Retiring`.
  The preparation test also mutates the disposed destination watcher and proves
  it cannot publish into the retained source workflow.
- Green command: `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Green result: 40/40 passed.

### Round 3 Green Verification

- Focused covering test: `npm test -- src/features/workspace/FileWorkflow.test.ts`
  - PASS: 1 file, 40/40 tests.
- Brief matrix: `npm test -- src/features/workspace src/core/store`
  - PASS: 6 files, 131/131 tests.
- Full frontend: `npm test -- --reporter=dot`
  - PASS: 44 files, 686/686 tests in 59.17 seconds.
- TypeScript: `npx tsc --noEmit`
  - PASS, no diagnostics.
- Production frontend: `npm run build`
  - PASS: 1,917 modules transformed. Output included
    `dist/assets/index-DI-YVzkX.js` at 1,063.94 kB (338.36 kB gzip).
- Focused accessibility Playwright:
  `npx playwright test tests/e2e/accessibility-workflow.spec.ts --grep "workflow has no automated axe violations and is keyboard operable"`
  - PASS: 1/1 in 15.7 seconds.
- Desktop release boundary: `npm run tauri:build -- --no-bundle`
  - PASS: frontend rebuilt and the unchanged native boundary compiled in the
    optimized release profile; executable produced at
    `src-tauri/target/release/uxml-editor.exe`.
- Rust fmt/test/check/strict clippy were conditional on native-file changes.
  No native file or Rust manifest changed in round 3, so those commands were
  not run.

### Browser, Keyboard, Axe, And Visual Evidence

- The focused Playwright test ran the actual axe scan with zero violations and
  completed keyboard-only open, command-palette focus, Escape focus return,
  named canvas focus, and canvas Escape behavior.
- Round 3 changes no visible UI, canvas, or layout code. The excluded canvas
  heading, toolbar, grid, geometry files, and tests were not touched. The
  previously recorded desktop and 720px nonblank/no-overlap screenshots and
  geometry baseline remain applicable.

### Changed Files

- Production: `src/features/workspace/FileWorkflow.ts`.
- Focused tests: `src/features/workspace/FileWorkflow.test.ts`.
- Evidence: this append-only report.

### Dependency And License Audit

- No npm or Rust dependency/version changed. `package.json`,
  `package-lock.json`, Cargo manifests, and lockfiles are unchanged.
- `uxml-preview` remains exactly `0.4.0` in both npm manifests.
- No license or notice changed; Apache-2.0 original code and all existing
  third-party notices are preserved.

### Round 3 Requirement Checklist

- [x] Failed source retirement restores a fresh source runtime object without
  reactivating any callback from the retired runtime.
- [x] Exact source name/root, project assets, Save All/reload capabilities,
  `DocumentSession`, recovery bytes, local journaling, and external watch are
  retained or restored.
- [x] Staged target runtime is disposed on every tested abort and cannot publish
  after disposal.
- [x] Save As source session/generation is captured before picker work and
  validated through every asynchronous boundary and source retirement.
- [x] Prewrite mutation leaves destination byte-identical; partial mutation
  reports exact frozen written/pending paths without claiming rollback.
- [x] Preflight, between-write, target-preparation, and retirement-pending gates
  reopen the source and recover the exact concurrent transaction bytes.
- [x] A changed source session is never attached to destination baselines
  captured before that transaction.
- [x] `DocumentSession` remains the sole exact-source/parsed-state authority; no
  second model or arbitrary native/filesystem authority was added.
- [x] Browser-first HostPort and existing Tauri runtime boundaries remain
  unchanged; no execution, upload, telemetry, network, shell/process, or broad
  path authority was introduced.
- [x] Byte identity, malformed/unsupported preservation, command IDs,
  accessibility conventions, dependency pins, and notices remain unchanged.
- [x] No excluded layout/geometry file or test changed; no push or PR occurred.

### Round 3 Self-Review

- Traced `DocumentSession.generation`, synchronous `CommandHistory` listeners,
  serialized `RecoveryJournal`, `SaveCoordinator` baselines, host watcher
  disposal completion, and `FileWorkflow.operationTail` before design.
- Confirmed source recovery listeners append while retirement is pending but
  publish only from a non-retired current runtime. History is unsubscribed
  before the final recovery drain, closing the unjournaled transaction window.
- Confirmed restoration reuses source save/recovery authority but allocates a
  fresh runtime identity, so old history/watch callbacks fail the retired and
  current-object gates permanently.
- Confirmed path outcomes derive from completed host writes only, are sorted by
  the source snapshot, remain frozen in `SaveAsPartialError`, and never claim
  destination rollback.
- The Task 7 recovery serialization is directly exercised by the pending
  retirement gate and remains on its established serialized journal tail. Task
  9 listener containment is unchanged; no broader refactor was needed.
- Final scope contains only the workflow, its focused test, and this report;
  `git diff --check` passed apart from informational CRLF conversion warnings.

### Round 3 Concerns

- This environment provides Node `25.2.1` with npm `11.6.2`, outside the
  declared `>=24.15.0 <25` range. All round-3 frontend, build, Playwright, and
  Tauri frontend commands passed on Node 25, but this report does not claim a
  supported-runtime pass. Per the findings, the controller will independently
  rerun Node 24 and packaged smoke verification after commit.
- Full Vitest retains the pre-existing unawaited-assertion warning at
  `src/core/host/BrowserHost.test.ts:74`; that file is unchanged and all 686
  tests passed.
- Vite retains the existing non-failing large-chunk warning. Playwright retains
  the existing `NO_COLOR`/`FORCE_COLOR` warning.

### Round 3 Commit Finalization

- BASE: `c39b86486bf09f25b2c66433f90804707085ef43`.
- Implementation/report HEAD:
  `11a604f7f63f52724467c05b10526f04e6838f8d`.
- Commit: `11a604f7f63f52724467c05b10526f04e6838f8d`
  (`fix: address Task 16 round 3 findings`).
- This SHA contains all production changes, deterministic gate tests, and the
  complete round-3 red/green evidence above. The following report-only commit
  records this immutable implementation SHA.

---

## Fix Round 4/5

### Status And Revision

- Status: `DONE_WITH_CONCERNS`.
- Fix base: `fa2461afa86d46306099f8a834d0024ff661dd29`.
- Branch: `agent/uxml-editor`.
- Immutable implementation SHA:
  `58347e25699169cefcbb318b39bdacaa8027a02f`.
- Implementation commit: `58347e25699169cefcbb318b39bdacaa8027a02f`
  (`fix: close Save As retirement journal gap`).
- No push or PR was performed.

### Finding 1: Close The Unjournaled Retirement Window

- Root cause: source retirement disposed the active history subscription and
  then awaited the recovery promise captured at that point. A synchronous
  `DocumentSession` transaction during that await advanced source generation
  without adding its exact commit result to recovery. Round 3 correctly
  restored fresh source runtime authority after the generation mismatch, but
  reopening could recover only the last transaction observed before history
  unsubscription.
- The deterministic test wraps the source runtime's real history disposer only
  to expose the exact unsubscribe boundary. It blocks a real source
  `writeRecovery`, queues the `Queued` transaction while source watcher
  retirement is pending, releases watcher completion, waits until the original
  history listener is removed, and then commits `Concurrent` while retirement
  is still blocked on the queued recovery write.
- The test also proves Save As retains its accepted completed-write outcome
  (`Assets/Main.uxml` and `Assets/Second.uxml` written, no pending paths),
  disposes staged target authority, restores the same source session through a
  fresh source watch runtime, and preserves project assets and Save All/reload
  capabilities.

### Deterministic RED Evidence

- Supported runtime: `npx --yes node@24.15.0 --version` returned
  `v24.15.0`.
- Pre-test baseline command:
  `npx --yes node@24.15.0 node_modules/vitest/vitest.mjs run src/features/workspace/FileWorkflow.test.ts`.
- Baseline result: 1 file passed, 40/40 tests passed.
- Red command after adding only the regression test:
  `npx --yes node@24.15.0 node_modules/vitest/vitest.mjs run src/features/workspace/FileWorkflow.test.ts`.
- Observed RED: 1 failed and 40 passed (41 total). The reopened source was
  exactly `<UXML><Button text="Queued" /></UXML>\r\n` instead of expected
  `<UXML><Button text="Concurrent" /></UXML>\r\n`, proving the post-unsubscribe
  transaction bytes were absent from recovery.
- No production code changed before this failure was observed.

### Production Fix

- Recovery queueing is factored into one workflow-local helper used by both
  normal source history and retirement draining.
- Retirement installs a short-lived recovery-only history listener before
  disposing the original runtime listener. The handoff is synchronous, so
  there is no interval in which neither listener owns local commit results.
- The original runtime listener remains permanently disposed. The drain
  listener never publishes workflow state, retains the existing external
  reload filter, and is gated by the retired runtime's exact active identity.
- Retirement repeatedly captures and awaits the latest `recoveryTail`. If a
  transaction extends the tail during an await, the loop drains the new tail
  before proceeding. The drain listener is disposed synchronously only after
  the observed tail remains stable, with no later await before retirement
  returns.
- Existing failure precedence is retained: watcher, history disposal,
  recovery, and drain disposal failures still preserve the first failure.
- `DocumentSession` operations remain independently executable and are not
  enqueued behind `FileWorkflow`.

### Deterministic GREEN Evidence

- Focused GREEN command:
  `npx --yes node@24.15.0 node_modules/vitest/vitest.mjs run src/features/workspace/FileWorkflow.test.ts`.
- Focused GREEN result: 1 file passed, 41/41 tests passed.
- The regression now disposes/reopens the source and recovers exact
  `Concurrent` bytes.

### Round 4 Verification

- Task 16 brief test matrix, run once:
  `npx --yes node@24.15.0 node_modules/vitest/vitest.mjs run src/features/workspace src/core/store`
  - PASS: 6 files, 132/132 tests.
- Task 16 brief build, run once as its two script stages under Node 24.15.0:
  - `npx --yes node@24.15.0 node_modules/typescript/bin/tsc --noEmit`
    passed with no diagnostics.
  - `npx --yes node@24.15.0 node_modules/vite/bin/vite.js build`
    passed with 1,917 modules transformed.
- Full frontend suite, run once:
  `npx --yes node@24.15.0 node_modules/vitest/vitest.mjs run --reporter=dot`
  - PASS: 44 files, 687/687 tests in 45.30 seconds.
- `git diff --check` passed; PowerShell reported only informational future
  LF-to-CRLF conversion notices before staging. `git diff --cached --check`
  passed with no output.
- Playwright and Tauri/Rust commands were not rerun because round 4 changes no
  UI, accessibility, native, capability, or dependency boundary. The required
  focused, brief, build, and full frontend verification all ran on the
  supported Node runtime.

### Accepted Behavior Preservation

- [x] Failed Save As restores source root/name, exact session, project assets,
  dirty state, recovery authority, Save All/reload capabilities, and a fresh
  source watch runtime.
- [x] Completed destination writes retain exact frozen written/pending paths;
  no destination rollback is claimed.
- [x] Staged target runtime is disposed on the retirement-race abort.
- [x] The original history and watcher callbacks remain retired and cannot be
  reactivated by fresh-runtime restoration.
- [x] Every local result accepted during recovery draining is appended before
  retirement returns, including tails extended while an earlier append waits.
- [x] External reload history remains excluded from local recovery journaling.
- [x] `DocumentSession` is not serialized behind `FileWorkflow`.
- [x] No canvas, toolbar, layout, geometry, native, dependency, capability,
  license, or unrelated file changed.

### Changed Files

- Production: `src/features/workspace/FileWorkflow.ts`.
- Focused tests: `src/features/workspace/FileWorkflow.test.ts`.
- Evidence: this append-only report.

### Round 4 Self-Review

- Traced the listener handoff, promise-tail extension ordering, source runtime
  identity gates, staged target retirement, fresh source restoration, and
  recovery replay through disposal/reopen.
- Confirmed the temporary drain listener cannot publish and is removed before
  the retired runtime returns; the original listener is never reactivated.
- Confirmed the stable-tail loop observes every recovery promise assigned
  during an earlier await and preserves the first retirement failure.
- Confirmed the regression asserts real reopened bytes rather than listener
  call counts; lifecycle spies only provide deterministic host/history gates.
- Confirmed the implementation commit contains only the workflow and its
  focused test.

### Dependency And License Audit

- No npm or Rust dependency/version changed. `package.json`,
  `package-lock.json`, Cargo manifests, and lockfiles are unchanged.
- `uxml-preview` remains exactly `0.4.0`.
- No license or notice changed.

### Round 4 Concerns

- Full Vitest retains the pre-existing unawaited-assertion warning at
  `src/core/host/BrowserHost.test.ts:74`. That file is unchanged; all 687 tests
  passed. The warning remains outside the exact round-4 scope.
- Vite retains the existing non-failing large-chunk warning for the production
  bundle. No dependency, bundling, or layout work was in scope.

### Round 4 Commit Finalization

- BASE: `fa2461afa86d46306099f8a834d0024ff661dd29`.
- Immutable implementation SHA:
  `58347e25699169cefcbb318b39bdacaa8027a02f`.
- Commit: `58347e25699169cefcbb318b39bdacaa8027a02f`
  (`fix: close Save As retirement journal gap`).
- The following report-only commit records this complete round-4 evidence
  against the immutable implementation SHA.

---

## Fix Round 5/5

### Status And Revision

- Status: `DONE_WITH_CONCERNS`.
- Fix base: `4a4d215aa991f6aaaa63a3618ee61a090fd5bff2`.
- Branch: `agent/uxml-editor`.
- Supported runtime: Node `v24.15.0`, npm `11.12.1`.
- Immutable implementation SHA:
  `639d2acf904b7d7a7bb7ac3ddbdbf38a73bec968`.
- Implementation commit: `639d2acf904b7d7a7bb7ac3ddbdbf38a73bec968`
  (`fix: make retirement handoff setup failure-safe`).
- No push or PR was performed.

### Finding 1: Make Retirement Handoff Setup Failure-Safe

- Root cause: round 4 installed the temporary recovery listener before entering
  any `try` block. A synchronous `CommandHistory.subscribe` setup exception
  therefore rejected retirement immediately, even when watcher retirement had
  already established the authoritative first failure.
- That rejection skipped original history-listener disposal, the stable
  recovery-tail drain, recovery-error accumulation, and temporary-listener
  cleanup. In the injected case, the source runtime could be restored while
  the retired runtime's original listener remained registered.
- `CommandHistory.subscribe` remains unchanged and normally total. The test
  uses a workflow-focused prototype spy to throw only from the exact temporary
  source-retirement subscription selected after source watcher completion.

### Deterministic RED Evidence

- Pre-test baseline command:
  `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Baseline result on Node `v24.15.0`: 1 file passed, 41/41 tests passed.
- The regression blocks a real source `writeRecovery`, captures a failed source
  watcher completion, arms only the next history subscription to throw, and
  queues the `Concurrent` transaction in the following microtask while the
  original listener and blocked recovery tail are still authoritative.
- An initial non-evidentiary harness attempt captured the prior round's active
  spy wrapper and recursed. No production file had changed. The seam was
  corrected by retaining the real prototype method at module evaluation time,
  after which the required isolated RED was recorded.
- Valid RED command after adding only the focused test:
  `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Valid RED result on Node `v24.15.0`: 1 failed and 41 passed (42 total).
- Failure 1: `SaveAsPartialError.originalError` was the injected temporary
  subscription `Error`, rather than the previously captured source watcher
  `HostError`.
- Failure 2: the wrapped original source history disposer was expected once
  but was called zero times.
- The remaining assertions completed, including staged-target cleanup and
  reopening the source with exact `Concurrent` recovery bytes. This isolates
  the missing retirement cleanup and first-failure behavior.

### Production Fix

- Temporary retirement subscription setup now executes inside the existing
  retirement failure accumulator and uses the established `failure ??=` first
  failure rule.
- When setup succeeds, round 4 behavior is unchanged: the temporary listener
  is installed synchronously before the original listener is disposed, the
  recovery tail is drained until stable, and the temporary listener is then
  disposed synchronously.
- When setup fails, the original listener remains registered throughout the
  same stable-tail loop. Local source transactions can therefore extend
  `recoveryTail`, and each extension is observed before retirement proceeds.
- After the tail is stable, retirement captures any recovery error, disposes
  the original listener, and performs no later await before returning or
  throwing the accumulated first failure.
- No `CommandHistory`, `DocumentSession`, host, public interface, or runtime
  ownership boundary changed.

### Deterministic GREEN Evidence

- Focused GREEN command:
  `npm test -- src/features/workspace/FileWorkflow.test.ts`.
- Focused GREEN result on Node `v24.15.0`: 1 file passed, 42/42 tests passed.
- The regression preserves the watcher `HostError` as
  `SaveAsPartialError.originalError`, observes exactly one original history
  disposal, disposes staged target authority, restores a second fresh source
  watch runtime, and reopens exact
  `<UXML><Button text="Concurrent" /></UXML>\r\n` bytes.

### Round 5 Verification

- Task 16 brief test matrix, run once:
  `npm test -- src/features/workspace src/core/store`.
  - PASS: 6 files, 133/133 tests.
- Task 16 brief build, run once: `npm run build`.
  - PASS: `tsc --noEmit` completed with no diagnostics.
  - PASS: Vite transformed 1,917 modules and completed the production build.
- Full frontend suite, run once:
  `npm test -- --reporter=dot`.
  - PASS: 44 files, 688/688 tests in 58.33 seconds.
- `git diff --check` passed; PowerShell emitted only informational future
  LF-to-CRLF conversion warnings for the two implementation files.
- `git diff --cached --check` passed with no output before the implementation
  commit.
- Playwright and Tauri/Rust commands were not rerun because round 5 changes no
  UI, accessibility, native, capability, dependency, or manifest boundary.
  The required focused, brief, build, and full frontend commands all ran on the
  supported Node runtime.

### Accepted Behavior Preservation

- [x] A temporary retirement subscription setup exception enters cleanup and
  first-failure accumulation instead of escaping directly.
- [x] A previously captured watcher failure remains authoritative.
- [x] On setup failure, the original listener owns local transactions until
  every observed recovery-tail extension is stably drained.
- [x] The original listener is disposed before retirement completes, with no
  later retirement await that can open an unjournaled interval.
- [x] The successful round-4 synchronous temporary-listener handoff retains its
  accepted order and external-reload filtering.
- [x] Failed Save As reports exact frozen written paths
  (`Assets/Main.uxml`, `Assets/Second.uxml`) and no pending paths.
- [x] Failed Save As restores the same source session and project assets under
  a fresh source runtime with Save All/reload capability and exact recoverable
  `Concurrent` bytes.
- [x] The retired original history listener is removed, the source watcher is
  replaced, staged target authority is disposed, and later target external
  writes cannot publish workflow state.
- [x] No canvas, toolbar, layout, geometry, native, dependency, capability,
  license, public-interface, or unrelated behavior changed.

### Changed Files

- Production: `src/features/workspace/FileWorkflow.ts`.
- Focused tests: `src/features/workspace/FileWorkflow.test.ts`.
- Evidence: this append-only report.

### Round 5 Self-Review

- Traced watcher disposal and completion, synchronous history subscription,
  original/temporary listener ownership, promise-tail extension, fresh source
  restoration, staged target retirement, and recovery replay through reopen.
- Confirmed successful setup still installs the temporary listener before the
  original disposer and removes it only after the stable drain.
- Confirmed failed setup cannot dispose the original listener before the drain,
  and there is no asynchronous boundary between the final original disposal
  and retirement completion.
- Confirmed the deterministic seam throws once, only after the source watcher
  failure and blocked recovery append are established; it does not redesign
  `CommandHistory` or expose a new interface.
- Confirmed the implementation commit contains only FileWorkflow and its
  focused test and is directly parented by the required fix base.

### Dependency And License Audit

- No npm or Rust dependency/version changed. `package.json`,
  `package-lock.json`, Cargo manifests, and lockfiles are unchanged.
- `uxml-preview` remains exactly `0.4.0`.
- No license or notice changed.

### Round 5 Concerns

- Full Vitest retains the pre-existing unawaited-assertion warning at
  `src/core/host/BrowserHost.test.ts:74`. That file is unchanged; all 688 tests
  passed. The warning remains outside the exact round-5 scope.
- Vite retains the existing non-failing large-chunk warning for the production
  bundle. No dependency, bundling, or layout work was in scope.

### Round 5 Commit Finalization

- BASE: `4a4d215aa991f6aaaa63a3618ee61a090fd5bff2`.
- Immutable implementation SHA:
  `639d2acf904b7d7a7bb7ac3ddbdbf38a73bec968`.
- Commit: `639d2acf904b7d7a7bb7ac3ddbdbf38a73bec968`
  (`fix: make retirement handoff setup failure-safe`).
- The following report-only commit records this complete round-5 evidence
  against the immutable implementation SHA.
