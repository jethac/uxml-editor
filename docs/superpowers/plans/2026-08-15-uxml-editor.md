# UXML Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and release a standalone, lossless visual editor for UXML and USS in `jethac/uxml-editor`.

**Architecture:** A browser-testable TypeScript core owns an authoritative `DocumentSession` that atomically pairs exact source buffers with their parsed `uxml-preview` model, and converts every visual operation into deterministic minimal source patches that immediately produce the next parsed session state. React renders a dense editor workbench around the `uxml-preview` DOM/Yoga canvas without maintaining a second visual object graph. Tauri 2 is the default thin desktop host for scoped filesystem access, dialogs, watching, atomic saves, and Windows packaging; the host decision is retained only if an executable spike passes.

**Tech Stack:** TypeScript 7, React 19, Vite 8, `uxml-preview@0.4.0`, CodeMirror 6, Lucide React, Vitest 4, Testing Library, Playwright 1.62, Tauri 2, Rust 1.92, npm lockfiles.

## Global Constraints

- Repository: public `https://github.com/jethac/uxml-editor`.
- License: Apache-2.0 for original code; preserve all third-party notices.
- Pin `uxml-preview` exactly to `0.4.0` initially and commit `package-lock.json`.
- Never copy or redistribute Unity Editor, UI Builder, UnityCsReference, or mirrored Unity package source.
- The editor must not require Unity for normal operation.
- `DocumentSession` is the sole source of truth: exact source buffers and the
  parsed document advance atomically, while rendered and component state are
  derived and replaceable.
- Opening and saving without edits must be byte-identical.
- Unsupported or malformed content must survive and must produce explicit diagnostics.
- Every mutation is a typed transaction with deterministic apply, undo, redo, and replay.
- The full editor core must run in a normal browser; native operations cross a narrow `HostPort` boundary.
- No production behavior is implemented without first observing its focused test fail.
- No telemetry, project upload, arbitrary project code execution, or mandatory network access.
- Windows is the first packaged target; browser tests and shell boundaries remain cross-platform.

---

## Planned File Structure

```text
uxml-editor/
  .github/workflows/ci.yml              test, browser build, Rust, license checks
  .github/workflows/release.yml         tagged Windows artifacts and checksums
  docs/adr/                             load-bearing decisions
  docs/architecture.md                  system boundaries and data flow
  docs/compatibility.md                 measured support matrix
  docs/progress.md                      current evidence and next action
  docs/superpowers/plans/               executable plans
  e2e/                                  Playwright workbench flows
  fixtures/projects/                    realistic UXML/USS projects
  scripts/check-licenses.mjs            dependency license allowlist
  src/app/                              React entry point and workbench layout
  src/core/adapter/                     uxml-preview isolation boundary
  src/core/commands/                    source patches, transactions, history
  src/core/documents/                   sessions, buffers, locators, dirty state
  src/core/host/                        browser and Tauri host ports
  src/core/persistence/                 atomic saves and recovery journals
  src/core/project/                     project indexing and path resolution
  src/core/store/                       observable editor state
  src/features/canvas/                  rendering and direct manipulation
  src/features/diagnostics/             grouped diagnostics
  src/features/hierarchy/               tree and structural operations
  src/features/inspector/               attributes and computed style origins
  src/features/palette/                 supported element creation
  src/features/source/                  CodeMirror UXML/USS editing
  src/features/workspace/               pane composition and command bar
  src/styles/                           tokens, workbench, controls, canvas
  src-tauri/                             scoped desktop host
  tests/                                 unit and integration tests
```

The core directories may contain additional small files when a responsibility
cannot be named clearly in one of the files below. Do not merge independent
responsibilities into a large catch-all module.

---

### Task 1: Repository Foundation And Executable Shell Decision

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `index.html`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/app.css`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/Cargo.lock`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `docs/adr/0001-application-shell.md`
- Create: `docs/progress.md`
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**
- Produces: `npm run dev`, `npm run test`, `npm run build`, `npm run tauri:dev`, and `npm run tauri:build`.
- Produces: an ADR selecting Tauri, browser/PWA, or Electron from executable evidence.

- [ ] **Step 1: Scaffold a disposable Vite React TypeScript spike**

Run:

```powershell
npm create vite@latest . -- --template react-ts
npm install --save-exact uxml-preview@0.4.0 react@19.2.8 react-dom@19.2.8 lucide-react@1.31.0
npm install --save-dev --save-exact typescript@7.0.2 vite@8.2.1 vitest@4.1.10 jsdom@30.0.1 @testing-library/react@16.3.2 @testing-library/user-event@14.6.4 @playwright/test@1.62.1 @tauri-apps/cli@2.11.4
```

Keep the generated app only if `npm test` and `npm run build` work under the
available Node version. If TypeScript 7 or Node 25 exposes an upstream blocker,
pin the newest mutually supported stable versions and record the exact failure
and replacement versions in the ADR.

- [ ] **Step 2: Write the shell capability smoke test**

Create `src/app/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('application shell', () => {
  it('renders the editor workbench without native APIs', () => {
    render(<App />);
    expect(screen.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
  });
});
```

- [ ] **Step 3: Run the test and observe the expected failure**

Run: `npm test -- src/app/App.test.tsx`

Expected: FAIL because `App` does not yet export an accessible editor application.

- [ ] **Step 4: Implement the smallest browser workbench shell**

Export `App` with `role="application"`, an accessible name, a command bar, and
empty hierarchy/canvas/inspector/diagnostic regions. Do not add editor behavior.

- [ ] **Step 5: Initialize and exercise Tauri**

Run:

```powershell
npx tauri init --ci --app-name "UXML Editor" --window-title "UXML Editor" --frontend-dist "../dist" --dev-url "http://localhost:1420" --before-dev-command "npm run dev -- --port 1420" --before-build-command "npm run build"
npx tauri build --no-bundle
```

Verify the Yoga WASM module loads in both `npm run dev` and a launched Tauri
debug executable. Record startup outcome, binary size, WebView2 behavior, and
build prerequisites.

- [ ] **Step 6: Record the architecture decision**

`docs/adr/0001-application-shell.md` must contain:

```markdown
# ADR 0001: Application Shell

## Decision
Use Tauri 2 as a thin desktop host around a browser-first React editor core.

## Evidence
- Browser production build: record the exact command, exit code, output path, and byte size.
- Yoga WASM in browser: record the exercised fixture and observed rendered element count.
- Tauri no-bundle build: record the exact command, exit code, executable path, and byte size.
- Native dialog/filesystem feasibility: official plugin APIs with scoped capabilities
- Automated testing: Vitest/Playwright for the core; tauri-driver smoke on Windows

## Boundaries
Native filesystem, dialog, watch, recovery-directory, and window lifecycle
operations are available only through HostPort. Editor commands never import
Tauri packages.

## Rejected Alternatives
Document the executable PWA and Electron comparison and the concrete reason
each was not selected.
```

Replace the evidence instructions with actual measurements before committing.

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run build && npx tauri build --no-bundle`

Commit: `chore: establish browser-first Tauri foundation`

---

### Task 2: Pinned UXML Preview Adapter And Characterization

**Files:**
- Create: `src/core/adapter/UxmlPreviewAdapter.ts`
- Create: `src/core/adapter/types.ts`
- Create: `src/core/adapter/UxmlPreviewAdapter.test.ts`
- Create: `tests/fixtures/minimal.uxml`
- Create: `tests/fixtures/minimal.uss`
- Create: `THIRD-PARTY-NOTICES.md`

**Interfaces:**
- Produces: `UxmlPreviewPort.parseProject(input): ParsedPreviewDocument`.
- Produces: `UxmlPreviewPort.render(document, container, options): PreviewFrame`.
- Produces: `UxmlPreviewPort.explain(document, nodeId, property): StyleExplanation`.
- The rest of the application must not import `uxml-preview` directly.

- [ ] **Step 1: Write failing characterization tests**

```ts
it('round-trips an untouched document byte-for-byte', () => {
  const parsed = adapter.parseProject({ uxml, stylesheets: new Map([['screen.uss', uss]]) });
  expect(adapter.serializeEntry(parsed)).toEqual({ uxml, stylesheets: new Map([['screen.uss', uss]]) });
});

it('maps every rendered DOM element back to an editor node', async () => {
  const frame = await renderFixture();
  expect(frame.nodeForElement(frame.elements.get(frame.rootChildren[0])!)).toBe(frame.rootChildren[0]);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/core/adapter/UxmlPreviewAdapter.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the narrow adapter**

Define:

```ts
export interface ProjectParseInput {
  uxmlPath: string;
  uxml: string;
  stylesheets: ReadonlyMap<string, string>;
  resolveImport(url: string, from: string | null): ResolvedText | null;
}

export interface ParsedPreviewDocument {
  readonly source: ProjectParseInput;
  readonly model: UxmlDocument;
  readonly diagnostics: readonly EditorDiagnostic[];
  readonly originsBySheet: readonly (string | null)[];
}
```

Load Yoga once, dispose every prior `RenderResult`, and map upstream warnings
into editor-owned diagnostic types.

- [ ] **Step 4: Verify upstream pin and notices**

Assert `package.json` contains exactly `"uxml-preview": "0.4.0"`, record the
npm integrity from `package-lock.json`, and add the Apache-2.0 attribution to
`THIRD-PARTY-NOTICES.md`.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/core/adapter/UxmlPreviewAdapter.test.ts && npm run build`

Commit: `feat: isolate pinned UXML preview engine`

---

### Task 3: Minimal Source Patch Engine

**Files:**
- Create: `src/core/commands/SourcePatch.ts`
- Create: `src/core/commands/SourcePatch.test.ts`
- Create: `src/core/documents/SourceBuffer.ts`

**Interfaces:**
- Produces: `applyPatches(source, patches): string`.
- Produces: `invertPatches(source, patches): readonly SourcePatch[]`.
- Produces: `validatePatchSet(source, patches): PatchValidation`.

- [ ] **Step 1: Write failing patch invariant tests**

```ts
it('applies non-overlapping edits from the end of the source', () => {
  const patches = [
    { start: 1, end: 2, replacement: 'X' },
    { start: 4, end: 4, replacement: '!' },
  ];
  expect(applyPatches('abcde', patches)).toBe('aXcd!e');
});

it('rejects overlapping edits without changing source', () => {
  expect(() => applyPatches('abc', [
    { start: 0, end: 2, replacement: 'x' },
    { start: 1, end: 3, replacement: 'y' },
  ])).toThrow(/overlap/i);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/core/commands/SourcePatch.test.ts`

- [ ] **Step 3: Implement validated immutable patches**

```ts
export interface SourcePatch {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}
```

Reject negative, reversed, out-of-range, and overlapping spans. Preserve source
outside changed spans exactly. Inversion must restore the original bytes.

- [ ] **Step 4: Add property-based boundary cases**

Cover insertion at zero/end, CRLF, surrogate pairs, XML entities, zero-length
replacement, and multiple adjacent patches.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/core/commands/SourcePatch.test.ts`

Commit: `feat: add deterministic source patch engine`

---

### Task 4: Document Sessions, Stable Locators, Transactions, And History

**Files:**
- Create: `src/core/documents/DocumentSession.ts`
- Create: `src/core/documents/ElementLocator.ts`
- Create: `src/core/documents/DocumentSession.test.ts`
- Create: `src/core/commands/EditorTransaction.ts`
- Create: `src/core/commands/CommandHistory.ts`
- Create: `src/core/commands/CommandHistory.test.ts`

**Interfaces:**
- Produces: `DocumentSession.open(files, entryPath, adapter): DocumentSession`.
- Produces: `DocumentSession.commit(transaction): CommitResult`.
- Produces: `CommandHistory.execute`, `undo`, `redo`, and `replay`.
- Consumes: `SourcePatch` and `UxmlPreviewPort`.

- [ ] **Step 1: Write failing transaction tests**

```ts
it('undo restores every file byte-for-byte and redo is deterministic', () => {
  const session = openFixture();
  const before = session.snapshot();
  session.history.execute(renameButton('Start'));
  const after = session.snapshot();
  session.history.undo();
  expect(session.snapshot()).toEqual(before);
  session.history.redo();
  expect(session.snapshot()).toEqual(after);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/core/documents/DocumentSession.test.ts src/core/commands/CommandHistory.test.ts`

- [ ] **Step 3: Implement source-backed sessions**

```ts
export interface EditorTransaction {
  readonly id: string;
  readonly label: string;
  readonly patchesByFile: ReadonlyMap<string, readonly SourcePatch[]>;
  readonly selectionAfter?: readonly ElementLocator[];
  readonly coalesceKey?: string;
}
```

After each commit, reparse from new source buffers through the adapter. Resolve
selection using a unique `name` first and a structural element path plus tag
signature otherwise. Clear redo on a new command and coalesce only adjacent
transactions sharing an explicit key.

- [ ] **Step 4: Add replay and invalidation coverage**

Test duplicate names, unnamed siblings, node insertion before selection,
parse-warning documents, redo invalidation, and drag transaction coalescing.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/core/documents src/core/commands`

Commit: `feat: add source-backed command history`

---

### Task 5: UXML Structural And Attribute Commands

**Files:**
- Create: `src/core/commands/uxmlCommands.ts`
- Create: `src/core/commands/uxmlCommands.test.ts`
- Create: `src/core/commands/xmlFormatting.ts`

**Interfaces:**
- Produces: `setAttribute`, `removeAttribute`, `insertElement`, `removeElement`,
  `duplicateElement`, `moveElement`, `wrapElements`, and `renameElement`.
- Consumes: upstream element spans through `UxmlPreviewPort`.

- [ ] **Step 1: Write failing localized-diff tests**

```ts
it('changes only the existing attribute value span', () => {
  const tx = setAttribute(session, buttonLocator, 'text', 'Continue');
  const result = previewTransaction(session, tx);
  expect(changedRegions(original, result.uxml)).toEqual([originalTextValueSpan]);
});

it('inserts a sibling without dropping an intervening comment', () => {
  execute(insertElement(session, parent, 1, '<ui:Button text="Options" />'));
  expect(session.text(entry)).toContain('<!-- keep this -->');
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/core/commands/uxmlCommands.test.ts`

- [ ] **Step 3: Implement span-based XML edits**

Patch existing attribute values directly, including entity-safe quoting. For
new attributes, insert before `/>` or `>` while matching the tag's spacing.
Structural commands splice exact node source and synthesize only indentation
owned by the inserted or moved region. Never set upstream `childrenDirty` for
operations where it would discard comments.

- [ ] **Step 4: Add preservation cases**

Cover XML declaration, namespace prefixes, single/double quotes, both quote
characters in a value, self-closing/paired tags, CRLF, comments between
children, mixed indentation, unsupported tags, and malformed siblings.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/core/commands/uxmlCommands.test.ts`

Commit: `feat: add lossless UXML editing commands`

---

### Task 6: USS Commands And Provenance-Aware Write Targets

**Files:**
- Create: `src/core/commands/ussCommands.ts`
- Create: `src/core/commands/ussCommands.test.ts`
- Create: `src/core/documents/StyleTarget.ts`
- Create: `src/core/documents/StyleTarget.test.ts`

**Interfaces:**
- Produces: `setDeclaration`, `removeDeclaration`, `insertRule`, `setInlineStyle`.
- Produces: `styleTargetsFor(node, property, state): readonly StyleTarget[]`.
- Consumes: `explainProperty` results from the adapter.

- [ ] **Step 1: Write failing provenance tests**

```ts
it('offers the winning rule, inline style, and a new local rule as explicit targets', () => {
  const targets = styleTargetsFor(session, button, 'width', []);
  expect(targets.map((target) => target.kind)).toEqual(['rule', 'inline', 'new-rule']);
});

it('patches only the selected declaration value in an imported stylesheet', () => {
  execute(setDeclaration(session, importedTarget, '240px'));
  expect(unchangedFiles(session)).toEqual(['screen.uxml', 'base.uss']);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/core/commands/ussCommands.test.ts src/core/documents/StyleTarget.test.ts`

- [ ] **Step 3: Implement stylesheet-local editing**

Map each upstream sheet origin to a project source buffer. Parse the target USS
as a standalone sheet when writing an imported file, locate the declaration by
source span and property, and patch only the selected source region. Create new
rules at the end while preserving final newline convention.

- [ ] **Step 4: Add cascade and state cases**

Cover inline vs rule, inherited values, built-in theme values with no editable
source, pseudo-state selectors, multiple linked sheets, relative imports,
custom properties, shorthand declarations, and unsupported selectors.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/core/commands/ussCommands.test.ts src/core/documents/StyleTarget.test.ts`

Commit: `feat: add provenance-aware USS editing`

---

### Task 7: Host Port, Atomic Persistence, File Watching, And Recovery

**Files:**
- Create: `src/core/host/HostPort.ts`
- Create: `src/core/host/BrowserHost.ts`
- Create: `src/core/host/MemoryHost.ts`
- Create: `src/core/persistence/SaveCoordinator.ts`
- Create: `src/core/persistence/RecoveryJournal.ts`
- Create: `src/core/persistence/SaveCoordinator.test.ts`
- Create: `src/core/persistence/RecoveryJournal.test.ts`

**Interfaces:**
- Produces: `HostPort` with project selection, text I/O, atomic replacement,
  file watch, app-data recovery, recent projects, and confirm methods.
- Produces: `SaveCoordinator.save(session)` and external-change resolution.

- [ ] **Step 1: Write failing atomic-save tests**

```ts
it('leaves the original file intact when replacement fails', async () => {
  host.failNextReplace = true;
  await expect(save.save(session)).rejects.toThrow();
  expect(await host.readText(entry)).toBe(original);
});

it('recovers committed transactions after an interrupted session', async () => {
  await journal.append(projectId, transaction);
  expect(await journal.recover(projectId, originalFiles)).toEqual(editedFiles);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/core/persistence`

- [ ] **Step 3: Implement host-neutral persistence**

```ts
export interface HostPort {
  chooseProject(): Promise<ProjectRoot | null>;
  readText(path: ProjectPath): Promise<FileReadResult>;
  replaceTextAtomically(path: ProjectPath, expectedRevision: string, text: string): Promise<FileRevision>;
  watch(root: ProjectRoot, listener: FileChangeListener): Promise<Disposable>;
  readRecovery(projectId: string): Promise<string | null>;
  writeRecovery(projectId: string, journal: string): Promise<void>;
  clearRecovery(projectId: string): Promise<void>;
}
```

Use compare-before-replace revisions to detect external modifications. Browser
host uses File System Access APIs when available and an in-memory/demo fallback
otherwise. Recovery data never lives inside the opened project.

- [ ] **Step 4: Add external-change cases**

Test clean reload, dirty conflict, deleted file, same-content rewrite, watcher
debounce, recovery corruption, and successful-save journal cleanup.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/core/persistence src/core/host`

Commit: `feat: add atomic persistence and recovery`

---

### Task 8: Project Index And Unity-Style Path Resolution

**Files:**
- Create: `src/core/project/ProjectIndex.ts`
- Create: `src/core/project/PathResolver.ts`
- Create: `src/core/project/PathResolver.test.ts`
- Create: `fixtures/projects/resolution/Assets/UI/screen.uxml`
- Create: `fixtures/projects/resolution/Assets/UI/base.uss`
- Create: `fixtures/projects/resolution/Assets/UI/nested/theme.uss`
- Create: `fixtures/projects/resolution/Assets/Resources/UI/icon.png`
- Create: `fixtures/projects/resolution/Packages/com.example.ui/theme.uss`

**Interfaces:**
- Produces: `ProjectIndex.scan(host, root): Promise<ProjectIndex>`.
- Produces: `PathResolver.resolveImport`, `resolveAsset`, and `resolveResource`.
- Consumes: `HostPort` and adapter resolver hooks.

- [ ] **Step 1: Write failing resolution matrix tests**

```ts
it.each([
  ['project://database/Assets/UI/base.uss', 'Assets/UI/base.uss'],
  ['/Assets/UI/base.uss', 'Assets/UI/base.uss'],
  ['Packages/com.example.ui/theme.uss', 'Packages/com.example.ui/theme.uss'],
])('resolves %s to %s', (reference, expected) => {
  expect(resolver.resolveImport(reference, null)?.path).toBe(expected);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/core/project/PathResolver.test.ts`

- [ ] **Step 3: Implement normalized, traversal-safe resolution**

Index `.uxml`, `.uss`, images, and package files. Resolve relative imports
against their immediate parent, distinguish `url()` from `resource()`, reject
project-root escapes, and return ambiguity diagnostics rather than selecting an
arbitrary Resources match.

- [ ] **Step 4: Add realistic graph cases**

Cover import cycles, duplicate relative spellings from different parents,
percent-encoded paths, XML entities, missing files, case differences, duplicate
Resources names, and external package changes.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/core/project`

Commit: `feat: resolve project styles and assets`

---

### Task 9: Observable Editor Store And Workbench Layout

**Files:**
- Create: `src/core/store/EditorStore.ts`
- Create: `src/core/store/EditorStore.test.ts`
- Create: `src/features/workspace/Workbench.tsx`
- Create: `src/features/workspace/CommandBar.tsx`
- Create: `src/features/workspace/PaneResizer.tsx`
- Create: `src/features/workspace/Workbench.test.tsx`
- Create: `src/styles/tokens.css`
- Create: `src/styles/workbench.css`

**Interfaces:**
- Produces: `EditorStore.subscribe/getSnapshot/dispatch` for `useSyncExternalStore`.
- Produces: fixed regions `commandbar`, `left`, `canvas`, `right`, `bottom`.
- Consumes: session, host, selection, viewport, panes, and active tool state.

- [ ] **Step 1: Write failing store and workbench tests**

```tsx
it('keeps pane dimensions stable when diagnostics appear', async () => {
  render(<Workbench store={store} />);
  const before = screen.getByTestId('canvas-pane').getBoundingClientRect();
  act(() => store.setDiagnostics([diagnostic]));
  const after = screen.getByTestId('canvas-pane').getBoundingClientRect();
  expect(after.width).toBe(before.width);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/core/store src/features/workspace`

- [ ] **Step 3: Implement the dense workbench**

Use CSS grid tracks with pointer-resizable separators and persisted dimensions.
Use Lucide icons for file, undo/redo, zoom, state, and panel commands. Provide
accessible names and tooltips. Avoid decorative cards and nested panels.

- [ ] **Step 4: Add responsive workbench coverage**

Test 1920x1080, 1366x768, 1024x768, and a narrow 720px window. At narrow sizes,
collapse tool panes into tabs without covering the command bar or canvas.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/core/store src/features/workspace && npm run build`

Commit: `feat: build persistent editor workbench`

---

### Task 10: Hierarchy, Palette, And Structural Editing UI

**Files:**
- Create: `src/features/hierarchy/HierarchyPanel.tsx`
- Create: `src/features/hierarchy/HierarchyRow.tsx`
- Create: `src/features/hierarchy/HierarchyPanel.test.tsx`
- Create: `src/features/palette/PalettePanel.tsx`
- Create: `src/features/palette/controlCatalog.ts`
- Create: `src/features/palette/PalettePanel.test.tsx`

**Interfaces:**
- Consumes: structural UXML commands and adapter-supported control names.
- Produces: synchronized selection and drag/drop structural transactions.

- [ ] **Step 1: Write failing interaction tests**

```tsx
it('reparents an element through one undoable hierarchy drop', async () => {
  renderHierarchy();
  await drag(screen.getByRole('treeitem', { name: 'Play' }), screen.getByRole('treeitem', { name: 'Footer' }));
  expect(session.parentOf(play)).toEqual(footer);
  session.history.undo();
  expect(session.parentOf(play)).toEqual(originalParent);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/features/hierarchy src/features/palette`

- [ ] **Step 3: Implement accessible tree and searchable palette**

Use `role="tree"`/`treeitem`, roving tabindex, expand/collapse, multi-select,
visibility of unsupported tags, drag/drop insertion indicators, and keyboard
reorder/reparent commands. Palette creates known controls plus a generic
namespace-preserving element.

- [ ] **Step 4: Add validation cases**

Test duplicate names, illegal drops into leaf controls, root deletion, unknown
tags, selection after deletion, multi-node moves, and palette search.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/features/hierarchy src/features/palette`

Commit: `feat: add hierarchy and element palette`

---

### Task 11: Preview Canvas, Selection, Viewports, And Pseudo States

**Files:**
- Create: `src/features/canvas/PreviewCanvas.tsx`
- Create: `src/features/canvas/CanvasOverlay.tsx`
- Create: `src/features/canvas/ViewportModel.ts`
- Create: `src/features/canvas/ViewportModel.test.ts`
- Create: `src/features/canvas/PreviewCanvas.test.tsx`
- Create: `src/styles/canvas.css`

**Interfaces:**
- Consumes: `PreviewFrame.elements`, `PreviewFrame.boxes`, selection, assets,
  viewport size, zoom, pan, and explicit element pseudo states.
- Produces: canvas clicks mapped to element locators and stable overlays.

- [ ] **Step 1: Write failing coordinate tests**

```ts
it('round-trips panel and screen coordinates under pan and zoom', () => {
  const viewport = new ViewportModel({ zoom: 1.5, pan: { x: 40, y: -12 } });
  const point = { x: 240, y: 160 };
  expect(viewport.screenToPanel(viewport.panelToScreen(point))).toEqual(point);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/features/canvas`

- [ ] **Step 3: Implement rendering and overlays**

Dispose the old preview before each render. Render fixed panel dimensions,
scale only the outer canvas surface, and draw hover/selection/parent bounds in
an independent overlay so handles cannot change layout. Map clicks using the
adapter element map, including clicks on renderer-generated parts.

- [ ] **Step 4: Add viewport and state controls**

Support fit, 100 percent, wheel zoom around cursor, pan, presets, orientation,
custom dimensions, safe-area overlay, and per-element hover/active/focus/
disabled/checked/selected/inactive state toggles.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/features/canvas && npm run build`

Commit: `feat: add interactive preview canvas`

---

### Task 12: Direct Manipulation, Snapping, Alignment, And Clipboard

**Files:**
- Create: `src/features/canvas/ManipulationController.ts`
- Create: `src/features/canvas/ManipulationController.test.ts`
- Create: `src/core/commands/layoutCommands.ts`
- Create: `src/core/commands/layoutCommands.test.ts`
- Create: `src/core/commands/ClipboardService.ts`
- Create: `src/core/commands/ClipboardService.test.ts`

**Interfaces:**
- Produces: move/resize/nudge/align/distribute/order commands when semantics are unambiguous.
- Produces: versioned `application/x-uxml-editor-fragment+json` clipboard data plus UXML text.

- [ ] **Step 1: Write failing semantic guard tests**

```ts
it('refuses free movement for a flex-flow child and explains why', () => {
  const result = layoutCommands.move(session, flexChild, { x: 20, y: 10 });
  expect(result).toEqual({ ok: false, diagnostic: expect.objectContaining({ code: 'AMBIGUOUS_LAYOUT_WRITE' }) });
});

it('coalesces a pointer drag into one undo entry', () => {
  drag.start(node, start);
  drag.update(mid);
  drag.update(end);
  drag.finish();
  expect(session.history.undoDepth).toBe(1);
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/features/canvas/ManipulationController.test.ts src/core/commands/layoutCommands.test.ts`

- [ ] **Step 3: Implement guarded manipulation**

Permit direct position edits for absolute-positioned elements and direct size
edits where width/height have clear write targets. Route modifications through
USS target selection. Add 1px keyboard nudging, 10px modified nudging, snapping
to parent/sibling edges and centers, multi-selection alignment/distribution,
and explicit front/back source ordering.

- [ ] **Step 4: Implement clipboard and duplication**

Copy exact source fragments plus namespace/style metadata. Paste must generate
non-conflicting names deterministically and remain one undoable transaction.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/features/canvas src/core/commands/layoutCommands.test.ts src/core/commands/ClipboardService.test.ts`

Commit: `feat: add guarded direct manipulation`

---

### Task 13: Attribute And Style Inspector

**Files:**
- Create: `src/features/inspector/InspectorPanel.tsx`
- Create: `src/features/inspector/AttributeSection.tsx`
- Create: `src/features/inspector/LayoutSection.tsx`
- Create: `src/features/inspector/AppearanceSection.tsx`
- Create: `src/features/inspector/TypographySection.tsx`
- Create: `src/features/inspector/ClassesSection.tsx`
- Create: `src/features/inspector/StyleTargetMenu.tsx`
- Create: `src/features/inspector/propertyCatalog.ts`
- Create: `src/features/inspector/InspectorPanel.test.tsx`

**Interfaces:**
- Consumes: attribute/USS commands, computed values, origins, selected node, and active states.
- Produces: validated edits with an explicit write target.

- [ ] **Step 1: Write failing inspector tests**

```tsx
it('shows the computed value and winning source before editing', () => {
  renderInspector(button);
  expect(screen.getByLabelText('Width')).toHaveValue('180px');
  expect(screen.getByText('theme.uss · .primary')).toBeVisible();
});

it('requires a target choice when rule and inline destinations are both valid', async () => {
  await user.clear(screen.getByLabelText('Width'));
  await user.type(screen.getByLabelText('Width'), '240px');
  expect(await screen.findByRole('menu', { name: 'Write width to' })).toBeVisible();
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/features/inspector`

- [ ] **Step 3: Implement compact typed editors**

Use numeric+unit, enum menu, checkbox, color swatch, asset picker, box-model,
alignment, class token, and text controls. Group fields into compact sections.
Show inherited/default/built-in sources as read-only origins and never invent a
file location for them.

- [ ] **Step 4: Add multi-selection and validation**

Show mixed values, apply compatible changes as one transaction, reject invalid
units/enums before mutation, and keep unknown attributes in an advanced table.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/features/inspector && npm run build`

Commit: `feat: add provenance-aware inspector`

---

### Task 14: Diagnostics And Source Editing

**Files:**
- Create: `src/features/diagnostics/DiagnosticsPanel.tsx`
- Create: `src/features/diagnostics/DiagnosticsPanel.test.tsx`
- Create: `src/features/source/SourcePanel.tsx`
- Create: `src/features/source/SourcePanel.test.tsx`
- Create: `src/core/documents/SourceEditCoordinator.ts`
- Create: `src/core/documents/SourceEditCoordinator.test.ts`

**Interfaces:**
- Produces: grouped diagnostics linked to file/span/node.
- Produces: debounced source replacement transactions with parse feedback.
- Consumes: CodeMirror XML/CSS language packages.

- [ ] **Step 1: Write failing source synchronization tests**

```tsx
it('selects the canvas node when its diagnostic is activated', async () => {
  renderDiagnostics([unsupportedControl]);
  await user.click(screen.getByRole('button', { name: /unsupported FancyChart/i }));
  expect(store.selection.primary).toEqual(fancyChartLocator);
});

it('keeps malformed source editable and restores preview after correction', async () => {
  source.replace('<ui:UXML><ui:Button');
  expect(store.diagnostics).toContainEqual(expect.objectContaining({ kind: 'malformed' }));
  source.replace(validUxml);
  expect(store.preview.status).toBe('ready');
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/features/diagnostics src/features/source src/core/documents/SourceEditCoordinator.test.ts`

- [ ] **Step 3: Implement diagnostics and CodeMirror views**

Group by severity/file, preserve stable ordering, and link rows to source spans,
hierarchy nodes, and canvas bounds. Source edits update the authoritative
buffer after a debounce and become coalesced history entries. Parse failure
keeps the last good preview visibly stale while source remains editable.

- [ ] **Step 4: Add search and keyboard behavior**

Support file/diagnostic filtering, source find, next/previous diagnostic, and
focus transfer without trapping keyboard users in CodeMirror.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/features/diagnostics src/features/source src/core/documents/SourceEditCoordinator.test.ts`

Commit: `feat: connect diagnostics and source editing`

---

### Task 15: Desktop Host, Scoped Permissions, Menus, And Recent Projects

**Files:**
- Create: `src/core/host/TauriHost.ts`
- Create: `src/core/host/TauriHost.contract.test.ts`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/main.json`
- Create: `src-tauri/src/atomic_save.rs`
- Create: `src-tauri/src/watch.rs`

**Interfaces:**
- Implements: `HostPort` for user-selected project roots.
- Exposes: narrowly scoped Rust commands for atomic replacement and revision-aware watching.

- [ ] **Step 1: Write host contract tests against `MemoryHost` and Tauri command fixtures**

```ts
describeHostContract('memory', () => new MemoryHost());
describeHostContract('tauri command adapter', () => new TauriHost(fakeInvoke));
```

The same suite must cover read, atomic replace, conflict, watch, recovery, and
recent-project semantics.

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/core/host/TauriHost.contract.test.ts`

- [ ] **Step 3: Implement least-privilege native operations**

Project selection grants access only to the chosen directory for the current
session. Recovery and recent projects use app-data. Rust atomic save writes a
sibling temporary file, flushes it, compares the expected revision, replaces
the target, and removes temporary files on failure. Never expose arbitrary
shell execution or unrestricted filesystem permissions.

- [ ] **Step 4: Add native menus and close protection**

Wire platform file/edit/view menus to the same command registry as toolbar and
keyboard actions. On close with dirty documents, offer save/discard/cancel and
honor the result.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/core/host && cargo test --manifest-path src-tauri/Cargo.toml && npx tauri build --no-bundle`

Commit: `feat: integrate secure Tauri desktop host`

---

### Task 16: Accessibility, Command Registry, And Complete File Workflow

**Files:**
- Create: `src/core/store/CommandRegistry.ts`
- Create: `src/core/store/CommandRegistry.test.ts`
- Create: `src/features/workspace/FileWorkflow.ts`
- Create: `src/features/workspace/FileWorkflow.test.ts`
- Create: `src/features/workspace/KeyboardShortcuts.tsx`
- Create: `src/features/workspace/Accessibility.test.tsx`

**Interfaces:**
- Produces: one command definition for toolbar, menus, shortcuts, and command palette.
- Produces: new/open/save/save-as/save-all/close/recent/reload/external-change flows.

- [ ] **Step 1: Write failing end-to-end workflow unit tests**

```ts
it('opens, edits, saves, closes, and reopens the same bytes', async () => {
  await workflow.openProject(project);
  store.execute(setButtonText('Race'));
  await workflow.saveAll();
  await workflow.closeProject();
  await workflow.openProject(project);
  expect(store.document.buttonText('play')).toBe('Race');
});
```

- [ ] **Step 2: Observe failures**

Run: `npm test -- src/features/workspace src/core/store/CommandRegistry.test.ts`

- [ ] **Step 3: Implement unified commands and shortcuts**

Provide platform-standard file, undo/redo, cut/copy/paste, duplicate, delete,
save, zoom, search, diagnostics, and pane commands. Disable unavailable actions
without removing their stable toolbar dimensions.

- [ ] **Step 4: Add accessibility checks**

Test accessible names, focus order, hierarchy keyboard navigation, inspector
labels, icon tooltips, dialog focus return, and canvas escape behavior. Run an
automated axe scan in Playwright and manually inspect keyboard-only operation.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- src/features/workspace src/core/store && npm run build`

Commit: `feat: complete accessible project workflow`

---

### Task 17: Realistic Fixtures, Browser E2E, And Visual Regression

**Files:**
- Create: `fixtures/projects/menu/Assets/UI/Menu.uxml`
- Create: `fixtures/projects/menu/Assets/UI/Menu.uss`
- Create: `fixtures/projects/options/Assets/UI/Options.uxml`
- Create: `fixtures/projects/options/Assets/UI/Options.uss`
- Create: `fixtures/projects/nested-styles/Assets/UI/Nested.uxml`
- Create: `fixtures/projects/nested-styles/Assets/UI/base.uss`
- Create: `fixtures/projects/nested-styles/Assets/UI/components/buttons.uss`
- Create: `fixtures/projects/assets/Assets/UI/Assets.uxml`
- Create: `fixtures/projects/assets/Assets/UI/Assets.uss`
- Create: `fixtures/projects/assets/Assets/Textures/icon.png`
- Create: `fixtures/projects/assets/Packages/com.jethac.widgets/package.json`
- Create: `fixtures/projects/assets/Packages/com.jethac.widgets/Textures/package-icon.png`
- Create: `fixtures/projects/unsupported/Assets/UI/Unsupported.uxml`
- Create: `fixtures/projects/unsupported/Assets/UI/Unsupported.uss`
- Create: `fixtures/projects/malformed/Assets/UI/Malformed.uxml`
- Create: `fixtures/projects/malformed/Assets/UI/Malformed.uss`
- Create: `e2e/editor.spec.ts`
- Create: `e2e/visual.spec.ts`
- Create: `playwright.config.ts`
- Create: `tests/fixtures/fixtureAudit.test.ts`

**Interfaces:**
- Produces: deterministic project corpus and screenshot baselines.
- Exercises: every Definition of Done editing workflow in the browser host.

- [ ] **Step 1: Write fixture audit and E2E specs before fixture implementations**

```ts
test('menu fixture is edited visually and saves a localized diff', async ({ page }) => {
  await openFixture(page, 'menu');
  await page.getByRole('treeitem', { name: 'Play' }).click();
  await page.getByLabel('Text').fill('Start race');
  await page.getByRole('button', { name: 'Save all' }).click();
  await expect(page.getByTestId('saved-diff')).toContainText('Start race');
  await expect(page.getByTestId('saved-diff')).not.toContainText('whole-file rewrite');
});
```

- [ ] **Step 2: Observe failures**

Run: `npx playwright test e2e/editor.spec.ts`

- [ ] **Step 3: Build all required fixtures**

Include the two-button menu, responsive options fields, nested linked styles,
images and package paths, unknown controls/properties, malformed recovery,
CRLF, comments, unusual quotes, entities, and formatting.

- [ ] **Step 4: Capture and inspect visual baselines**

Capture workbench screenshots at 1920x1080, 1366x768, 1024x768, and 720x900.
Assert canvas pixels are nonblank and inspect for clipping, overlap, unstable
controls, unreadable text, and broken assets.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npx playwright test && npm run build`

Commit: `test: cover complete visual editing workflows`

---

### Task 18: CI, Licensing, Documentation, Packaging, And Release

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `scripts/check-licenses.mjs`
- Create: `scripts/check-goal.mjs`
- Create: `NOTICE`
- Create: `CONTRIBUTING.md`
- Create: `CHANGELOG.md`
- Create: `docs/architecture.md`
- Create: `docs/compatibility.md`
- Create: `docs/adr/0002-source-backed-editing.md`
- Create: `docs/adr/0003-style-write-targets.md`
- Create: `docs/adr/0004-recovery.md`
- Modify: `README.md`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: CI evidence, Windows installer/portable artifacts, checksums, SBOM,
  and release notes.
- Produces: a machine-readable goal audit that maps all 13 completion items to evidence.

- [ ] **Step 1: Write failing license and goal checks**

`scripts/check-licenses.mjs` must fail for unknown, GPL, AGPL, SSPL, or missing
dependency licenses and accept the explicitly recorded permissive allowlist.
`scripts/check-goal.mjs` must fail when any required artifact, test script,
compatibility section, release metadata field, or evidence file is absent.

Run: `node scripts/check-licenses.mjs && node scripts/check-goal.mjs`

Expected: FAIL until notices, docs, scripts, and packaging metadata exist.

- [ ] **Step 2: Implement CI and documentation**

CI runs clean install, typecheck, lint, unit/integration tests, Playwright,
browser build, Rust tests, Tauri no-bundle build, license check, goal check, and
artifact upload. Documentation must describe actual commands and measured
limits, not planned behavior.

- [ ] **Step 3: Configure Windows release artifacts**

Build an unsigned NSIS installer and a portable archive. Generate SHA-256
checksums and CycloneDX or SPDX SBOM. Document SmartScreen warnings. Do not
require private signing credentials.

- [ ] **Step 4: Perform the clean-clone release audit**

In a fresh directory run:

```powershell
npm ci
npm run typecheck
npm test
npx playwright install chromium
npx playwright test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npx tauri build
node scripts/check-licenses.mjs
node scripts/check-goal.mjs
```

Launch the packaged application and repeat open/edit/save/close/reopen against
the menu and options fixtures. Inspect all representative screenshots.

- [ ] **Step 5: Publish the initial release**

Tag the verified commit with the selected semantic version, push the tag, and
create a GitHub release containing installer, portable archive, checksums,
SBOM, compatibility summary, known fidelity limitations, and release notes.

- [ ] **Step 6: Commit and final audit**

Commit: `release: publish standalone UXML editor`

Audit every numbered Definition of Done item in `B:\usagi_dev\UXML_GOAL.md`
against repository files, test output, CI results, packaged runtime behavior,
screenshots, and GitHub release state. Keep the goal active if any evidence is
missing or indirect.

---

## Plan Self-Review

- Every repository, licensing, architecture, functional, persistence,
  diagnostics, accessibility, test, documentation, distribution, and release
  requirement in `UXML_GOAL.md` maps to at least one task above.
- Production behavior is introduced only after a named failing test.
- `uxml-preview` is isolated behind `UxmlPreviewPort`; no feature imports it directly.
- `HostPort` isolates native behavior; the editor remains browser-testable.
- Source patches, transactions, and replay provide one consistent editing path
  for hierarchy, canvas, inspector, and source views.
- No task depends on unspecified types or an unnamed implementation phase.
- The final task requires direct evidence for all completion criteria rather
  than treating a green narrow test as proof of the whole product.
