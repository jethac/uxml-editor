# Progress

## Current Status

Tasks 1 through 7 are complete. The editor core now includes exact source
sessions and history, UXML/USS commands, browser-testable host contracts,
revision-aware persistence, deterministic watching, and bounded app-data
recovery. Task 7 does not add the Task 8 desktop/Tauri host implementation.

## Verified Evidence

- Focused TDD cycle: `npm test -- src/app/App.test.tsx` first failed because no
  accessible application named `UXML Editor` existed, then passed after the
  minimal command bar and hierarchy/canvas/inspector/diagnostics regions were
  implemented.
- Browser build: `npm run build` exited 0; `dist/` contains 193,650 bytes across
  three files.
- Browser Yoga probe: Edge returned HTTP 200 and rendered 4 mapped elements.
- Tauri Yoga probe: the launched debug executable used WebView2 151 and rendered
  the same 4 mapped elements.
- Desktop build: `npx tauri build --no-bundle` exited 0; the release executable
  is 8,689,152 bytes.
- Alternative spike: Electron 43.4.0 loaded the shell; its runtime executable
  alone is 225,533,440 bytes.
- `uxml-preview` is pinned exactly to 0.4.0. npm integrity is
  `sha512-CS26v3f85dQ5ZFbTGnoCyTtpyaD1/emDlg6/7+/G3JeGi82oghiGBxxmh5qSdJDQrzs53lKXqPhEvVc4CDQXSg==`;
  upstream tag `v0.4.0` resolves to
  `f358e98a805d4ae5a52fc04ff6989b3053354539` (published 2026-08-11).

## Toolchain Note

Node 25.2.1 is outside the declared engine range of `jsdom@30.0.1`, so npm emits
`EBADENGINE`. Vitest and the application build execute successfully, and the
exact requested pin remains in place. Use a supported Node 24 release in CI to
avoid relying on behavior outside jsdom's declared range.

## Task 1 Review Fix Round

- Red: `npm test -- src/config/foundation.test.ts` exited 1 while the focused
  engine assertion expected `>=24.15.0 <25` and the manifest temporarily
  contained `^24.15.0`; the assertion reported the exact mismatch. The
  assertion also retains checks for Vite port 1420 with `strictPort`, explicit
  production and development CSPs, and the non-toolbar static header.
- Green: after restoring the selected `>=24.15.0 <25` Node 24 LTS range in the
  manifest and lockfile, `npm test -- src/config/foundation.test.ts
  src/app/App.test.tsx` exited 0 with 2 test files and 5 tests passing.
- The production CSP allows only self-hosted content and Tauri IPC, Yoga's
  `'wasm-unsafe-eval'`, and preview inline styles. `devCsp` adds only
  `ws://localhost:1420` for Vite HMR; no remote source is permitted.

## Task 2 Adapter Characterization

- Red: `npm test -- src/core/adapter/UxmlPreviewAdapter.test.ts` exited 1
  before implementation because `./UxmlPreviewAdapter` did not exist. The
  Vitest import-analysis error identified the missing module at the test import.
- Green: the same focused command exited 0 with 1 test file and 7 tests after
  the editor-owned adapter was added. The suite uses a fixed 640 by 480 panel
  and a fixed 8-pixels-per-character, 16-pixel-high text measurement for
  repeatable Yoga rendering.
- The adapter owns the opaque parsed model in module-private `WeakMap`s. Its
  public contract exposes only editor node IDs, source spans, diagnostics,
  render frames, and style explanation candidates/origins.
- `parseProject` resolves exact input stylesheet buffers before consulting the
  host resolver. It records the returned canonical paths in parsed-sheet order;
  imported stylesheet buffers remain authoritative during no-op serialization
  because upstream `serialize` returns only one USS source.
- A shared promise loads Yoga once. A later render through the same adapter
  disposes the previous upstream result, and editor frame disposal is
  idempotent.
- The dependency characterization asserts `uxml-preview@0.4.0`, lock integrity
  `sha512-CS26v3f85dQ5ZFbTGnoCyTtpyaD1/emDlg6/7+/G3JeGi82oghiGBxxmh5qSdJDQrzs53lKXqPhEvVc4CDQXSg==`,
  and upstream tag commit `f358e98a805d4ae5a52fc04ff6989b3053354539`.
  `THIRD-PARTY-NOTICES.md` also carries Apache-2.0 attribution for
  `uxml-preview` and the MIT Meta notice for bundled `yoga-layout@3.2.1`
  (integrity
  `sha512-0LPOt3AxKqMdFBZA3HBAt/t/8vIKq7VaQYbuA8WxCgung+p9TVyKRYdpvCb80HcdTN2NkbIKbhNwKUfm3tQywQ==`).
- The adapter test uses Node filesystem APIs to scan the TypeScript import
  boundary. `@types/node@24.13.3` is therefore a pinned development-only
  declaration dependency and `tsconfig.json` includes the `node` type library;
  the browser runtime dependency graph is unchanged.
- Final verification: `npm test` exited 0 with 3 test files and 12 tests
  passing. `npm run build` exited 0 after `tsc --noEmit`; Vite emitted the
  browser bundle. The final import scan found no `uxml-preview` reference
  outside `src/core/adapter`.

## Next Action

Task 4 can pair exact `SourceBuffer` values with parsed documents and build
transactions/history on the deterministic patch engine. `DocumentSession` must
remain the sole source of truth; rendered and component state stay derived and
replaceable.

## Task 3 Source Patch Engine

- Red: `npm test -- src/core/commands/SourcePatch.test.ts` exited 1 because
  `./SourcePatch` did not exist; Vite import analysis identified the missing
  module at the test import. This established the test-first contract before
  either production module existed.
- Green: the focused command exited 0 with 1 test file and 17 tests after the
  immutable source-patch engine and `SourceBuffer` were added.
- SourcePatch offsets are JavaScript UTF-16 code-unit indices, matching pinned
  upstream string spans. Validation rejects non-integer, negative, reversed,
  out-of-range, overlap, ambiguous same-start, and surrogate-splitting spans;
  `applyPatches` and `invertPatches` throw the owned
  `SourcePatchValidationError` for those invalid sets.
- Validation normalizes a frozen copy in ascending source order, while apply
  runs from highest offset to lowest. Adjacent disjoint edits and insertion at
  either source boundary are valid; insertion immediately after a replacement
  is valid, while any same-start pairing is rejected as ambiguous.
- Inverse patches are addressed to the transformed output. Adjacent source
  changes that collapse to one output boundary are coalesced so undo remains a
  valid deterministic patch set. Exhaustive small-source loops cover these
  round-trip invariants alongside CRLF, entities, quotes, unusual whitespace,
  emoji, insertions, deletions, replacements, and no-op sets.
- `SourceBuffer` is a frozen path-plus-exact-text value object. Its `apply`
  method returns a new buffer, leaving the original untouched; it observes
  `none`, LF, CRLF, CR, or mixed newline style without making encoding promises.

## Task 3 Fix Round 1

- Commit: `6f623d9` (`fix: harden source patch validation`); no push or amend.
- Red: `npm test -- src/core/commands/SourcePatch.test.ts` exited 1 with 11
  expected failures. The prior validator accepted low/high surrogate insertions
  that made inverse offsets split a transformed pair, re-read getter-backed
  patch fields through validation/spread, threw for null and throwing entries,
  accepted missing/non-string replacements, and did not classify bare CR.
- Green: validation now snapshots and freezes only `start`, `end`, and
  `replacement` after reading each field exactly once. It rejects non-objects
  and throwing access as `invalid-patch`, and missing/non-string replacements
  as `invalid-replacement`. It internally validates the generated inverse
  against transformed output before reporting a forward set as valid, without
  public validation/inversion recursion.
- The patch suite covers both low/high cross-boundary cases, adjacent inverse
  groups, getter-backed snapshots, malformed runtime input, CR-only text, and
  CR mixes. The exhaustive loop now asserts inverse validation before the
  exact restoration assertion. `SourceBuffer` separately observes CRLF, lone
  LF, and lone CR; more than one observed style is `mixed`.
- Verification: focused Task 3 tests passed 29 tests; `npm test` passed 4
  files and 46 tests; `npm run build` passed `tsc --noEmit` and Vite bundling;
  `git diff --check` and the staged diff check exited 0 before the fix commit.

## Task 3 Fix Round 2

- Commit: `363938e` (`fix: scale source patch validation`); no push or amend.
- Red: the supplied `a\\uD800` repro reported generated inverse patch index 1
  instead of caller patch index 0. The caller-order permutation test also
  demonstrated that provenance must follow the low-surrogate insertion. The
  deterministic 1,200,000-code-unit / 6,000-patch round trip exceeded Vitest's
  normal five-second test timeout under the former repeated full-string
  construction.
- Green: validation snapshots and sorts once, then proves inverse surrogate
  safety directly at each contiguous forward-patch group. It uses source
  boundary code units and the first/last nonempty replacement code units, or
  the unchanged source boundaries for a deleting group. Validation reports the
  causal caller patch index. It no longer builds transformed output or
  normalizes an inverse patch set.
- Inversion emits one patch per contiguous source group with transformed
  offsets from a cumulative delta, replacement length equal to the group output
  length, and the original source slice as replacement. Application constructs
  a right-to-left chunk array and joins once, so it does not rebuild the whole
  document for every patch. Existing exhaustive accepted cases still validate
  their inverse and restore the exact source.
- Benchmark: the isolated deterministic large regression completed in 27ms of
  Vitest test execution on this workspace, with no timing assertion in the
  test itself.

## Task 2 Fix Round 1

- Red: `npm test -- src/core/adapter/UxmlPreviewAdapter.test.ts` first exited 1
  because the prior expectation treated a nested relative import as a direct
  input-map lookup. A second focused red run caught the import-boundary scan's
  overly broad multiline regex; it did not recognize the adapter's multiline
  static import after self-scan false positives were removed.
- Green: the focused command exited 0 with 1 test file and 11 tests. Nested
  relative imports now always use their parent resolver context; direct and
  root-fixed input-map sources retain exact canonical buffers for fresh
  serialization maps. Tests cover two same-named nested imports resolving to
  separate paths, root-fixed/duplicate resolution, unresolved provenance,
  render supersession, computed style explanations, and unconditional reverse
  lookup assertions.
- Browser-only test inputs use Vite `?raw` fixture imports and
  `import.meta.glob` raw module sources. The statement-bounded scan covers
  side-effect, static `from`, dynamic, and re-export imports; `@types/node` is
  absent from both manifest dependency sections and the lockfile, and
  `tsconfig.json` no longer enables Node globals.
- Final verification: `npm test` exited 0 with 3 test files and 16 tests;
  `npm run build` exited 0 after `tsc --noEmit` and Vite bundling. The final
  production source scan found `uxml-preview` only in
  `src/core/adapter/UxmlPreviewAdapter.ts`.

## Task 2 Fix Round 2

- Red: the isolated supersession command exited 1 because its gated
  `loadLayoutEngine` mock resolved without invoking the real Yoga loader, so
  the latest render rejected. The import-boundary red run also exited 1 because
  the regex did not recognize a semicolon-free multiline static import.
- Green: the supersession mock now waits for its gate and calls the real loader;
  the first request rejects with `RenderSupersededError`, the latest frame is
  live, and its disposal remains idempotent. The source guard uses
  `@babel/parser@8.0.4` as an exact MIT development-only dependency and Vite
  raw-globs every requested TS/JS extension. Its structured AST detects static,
  re-export, literal dynamic, import-attribute, and TypeScript external-module
  imports while ignoring comments, strings, and templates.
- Conversion of diagnostics plus inline/rule style origins now omits `source`
  when no editor span can be mapped. Focused assertions verify the field is
  absent rather than present with `undefined`.

## Task 2 Fix Round 3

- Commit: `6d8bec1` (`fix: catch additional preview import forms`); no push.
- Red: the focused boundary test exited 1 because the AST walker did not
  recognize `TSImportType` source literals or CommonJS `require` calls.
- Green: the walker now detects `type T = import('uxml-preview').T` and
  `require('uxml-preview')`, while ignoring `require(variable)`, unrelated
  package literals, and comment/string/template lookalikes. Existing import
  forms remain covered.
- Verification: the focused boundary test passed 1 test; the full adapter
  file passed 12 tests; `npm test` passed 3 files and 17 tests; and
  `npm run build` passed `tsc --noEmit` and Vite bundling.

## Task 4 Document Sessions And Command History

- Red: `npm test -- src/core/documents/DocumentSession.test.ts
  src/core/commands/CommandHistory.test.ts` exited 1 before production modules
  existed. Vite import analysis reported the missing `DocumentSession` and
  `ElementLocator` modules from the new focused suites.
- Green: the focused command exited 0 with 2 files and 21 tests. It covers
  exact multi-file undo/redo, replay into an equivalent session, redo
  invalidation, explicit-key coalescing and barriers, caller mutation,
  invalid transactions, warning-only parses, and pre/post selection restoration
  across undo and redo.
- `DocumentSession` is now the atomic authority over immutable `SourceBuffer`
  values and its adapter-parsed document. It validates every affected patch set
  before applying candidates, computes inverse patches from original bytes,
  reparses the candidate entry plus exact available USS buffers, then publishes
  files, parsed state, diagnostics, and locator selection together. Missing
  files, invalid patches, and parse failures publish nothing.
- Element locators retain a unique authored `name`, structural child path,
  qualified tag, ancestor signature, and authored attribute hints. Resolution
  uses only globally unique names; duplicate names fall through to structural
  resolution and genuinely ambiguous candidates remain unresolved. The adapter
  exposes frozen editor-owned authored attribute values and source spans.
- Transaction and replay snapshots clone/freeze patches, locators, and
  read-only map views. Coalesced history stores forward steps in order and
  inverse steps in reverse order; undo/redo forms a coalescing barrier. A
  session-owned commit sequence checkpoints files, parsed document, locators,
  and resolved node IDs so a later reparse failure rolls back every earlier
  coalesced undo/redo step before history touches either stack.
- Second red/green: a failure injected into the second inverse/forward parse of
  a coalesced entry first left the session at the intermediate `Step` source.
  After `commitSequence` was introduced, the focused suite passed while
  confirming exact rollback and unchanged undo/redo availability in both
  directions.

## Task 4 Review Fix Round 1

- Replay red: a two-transaction replay whose second parse failed left the
  first transaction's USS bytes published (`red` became `blue`) and had already
  mutated history. Green: replay now snapshots every caller transaction before
  mutation, uses the session's atomic commit sequence, records normal history
  only after all commits succeed, and publishes `replayLog` last. The regression
  restores source, selection, undo/redo availability, replay log, and the
  observable coalescing barrier.
- Immutability red: three mutation attempts succeeded against snapshot files,
  parsed stylesheets, and session document internals. Green: a shared
  runtime-immutable map backs source snapshots and parsed stylesheet views;
  editor-owned source, element, diagnostic, and origin structures are
  copied/frozen while the adapter-owned parsed document identity remains the
  WeakMap key. Upstream opaque models remain private and unfrozen.
- Locator red: name rename/removal and unnamed attribute edit/removal produced
  four unresolved selections. Green: direct child-path resolution now checks
  qualified tag and ancestor structure only; authored attribute hints remain
  fallback disambiguators, and indistinguishable fallback candidates still
  resolve to null.
- Import red: entry-relative, nested-relative, root-fixed, project-fixed, and
  Windows-style references did not resolve. Green: the session builds a
  deterministic normalized USS lookup, anchors relative importer paths to the
  entry, resolves dot segments, and leaves project-root escapes, drive paths,
  remote URLs, ambiguous aliases, and missing files unresolved.
- Error-code red: malformed transaction metadata and selection locators both
  surfaced as `invalid-patch`. Green: they now report `invalid-transaction` and
  `invalid-selection` respectively without changing the transaction contract.

## Task 4 Review Fix Round 2

- Deep-immutability red: a shallow-frozen third-party adapter document was
  accepted because normalization checked only the top-level object; its nested
  stylesheet map and diagnostic array remained mutable. The focused run had
  one expected failure while the genuine deep-frozen idempotence case passed.
  Green: frozen inputs now undergo a complete editor-owned structure check.
  Verified deep-frozen documents retain their adapter identity; malformed
  frozen documents are rejected through the session's deterministic
  `parse-failed` error. No upstream opaque model is traversed or frozen.
- Same-tag locator red: inserting `Button text="New"` at the old structural
  path of selected `Button text="Keep"` moved selection to the new sibling.
  Green: resolution now prefers a direct candidate only when its full old
  hints still match, then a unique structurally eligible hinted candidate,
  then a structurally safe direct fallback for ordinary attribute changes.
  Missing-path ambiguous fallback remains unresolved, and all 25
  `DocumentSession` tests preserve the round-1 locator behavior.

## Task 5 UXML Structural And Attribute Commands

- Added typed, normalized transactions for `setAttribute`, `removeAttribute`,
  `insertElement`, `removeElement`, `duplicateElement`, `moveElement`,
  `wrapElements`, and `renameElement`. Commands snapshot caller locators and
  emit deterministic source patches consumed directly by `DocumentSession`
  and `CommandHistory`.
- The adapter boundary now exposes frozen editor-owned open-tag, inner, and
  optional close-tag spans. Commands never import `uxml-preview`, serialize an
  upstream model, or mutate upstream dirty state. Existing attribute values are
  patched inside their authored quotes; structural changes splice exact source
  and synthesize only operation-owned XML whitespace and indentation.
- Preservation coverage includes declarations, namespace prefixes, comments,
  unsupported children, recoverable malformed text, self-closing and paired
  elements, quote styles, CRLF, and mixed indentation. Unsafe locators, names,
  values, indices, roots, hierarchy changes, selections, source spans, and
  namespace changes fail with explicit `UxmlCommandError` codes.
- Namespace comparisons decode predefined and numeric XML character references
  without rewriting authored declaration bytes. Insertions require every QName
  prefix to be locally bound; moves preserve inherited namespace semantics;
  namespace declaration removal rejects dependent subtree QNames until a nested
  override makes the subtree independent. Malformed or unknown references are
  rejected as ambiguous source.
- Compatibility limit: the command API currently accepts the parser-compatible
  ASCII QName subset (`[A-Za-z_][A-Za-z0-9_.-]*`, with at most one namespace
  colon). XML-valid Unicode names are rejected with `UxmlCommandError` because
  pinned `uxml-preview@0.4.0` demonstrably does not round-trip them reliably.
- Recovered closing spans must contain the exact matching QName before any
  structural range can be removed, copied, moved, wrapped, or renamed. For an
  unterminated element with no close span, the safe range includes the complete
  recovered inner span. Multi-element selections validate every member.
- Verification: the command suite passed 48 tests; the touched adapter,
  session, and history suites passed 50 tests; `npm test` passed 7 files and
  135 tests; `npm run build` passed `tsc --noEmit` and Vite bundling with 16
  modules; and `git diff --check` exited 0 with only line-ending notices.

## Task 5 Review Fix Round 1

- Paired destination safety red: insert and move both planned child insertion
  into an element whose recovered close span was the ancestor `</ui:UXML>`.
  Green: `planDestinationInsertion` is now the single insert/move choke point;
  every paired destination requires an exact matching closing QName/span before
  any insertion or trivia offset is returned.
- Namespace move red: unbound and reserved moved QNames compared as equal when
  both source and destination resolution returned null. Green: every moved
  element, including nested descendants, requires non-null source and
  destination namespace resolution before URI comparison.
- Duplicate declaration red: repeated default or prefixed namespace declarations
  on one element silently overwrote each other in scope construction. Green:
  per-element prefix tracking rejects same-URI and different-URI duplicates as
  ambiguous for insert, rename, wrap, namespaced attribute, and move safety.
- Attribute lexing red: JavaScript whitespace admitted NBSP/form feed around
  `=`, and a greedy body admitted an interior matching quote. Green: the exact
  span lexer accepts only XML whitespace around `=`, requires the first matching
  quote to terminate the span, and continues to allow opposite quotes and
  entity references inside values.
- `uxmlCommands.ts` retains the eight public command functions and delegates to
  acyclic modules for command errors, tree traversal, exact source-span safety,
  namespace scope, and destination/trivia planning. The former 1,165-line test
  file is split into attribute, insertion/removal, move/wrap, and
  namespace/recovery suites with shared deterministic fixtures. All 38 prior
  declarations plus four new regressions remain, totaling 52 Vitest cases.
- Verification: the four command suites passed 52 tests; touched adapter,
  session, and history suites passed 50 tests; `npm test` passed 10 files and
  139 tests; `npm run build` passed `tsc --noEmit` and Vite bundling with 16
  modules; and `git diff --check` exited 0 with only line-ending notices.

## Task 6 USS Commands And Provenance-Aware Targets

- `styleTargetsFor` now turns cascade explanations into frozen, deterministic
  write choices: winning and losing authored declarations, a base-state inline
  override, and one new-rule destination per directly linked local sheet.
  Built-in/default origins never acquire fake files, while inherited rule and
  inline values retain their actual authored origin.
- Rule targets retain exact sheet, item, declaration, selector, rule, property,
  value, state, and source identities. Target IDs use canonical tuples, and
  command planning deep-snapshots getter-backed caller objects before validating
  the current session's exact source snapshot and standalone parse metadata.
- The adapter owns independent USS and inline declaration parsing. Imported
  files are parsed as their own buffers through an editor-owned immutable
  contract; `uxml-preview` remains imported only by `UxmlPreviewAdapter.ts`.
- `setDeclaration` patches only the parser-owned value, `removeDeclaration`
  removes one selected declaration plus its exact whitespace/semicolon
  terminator, `insertRule` appends with inferred indentation/newline/final-
  newline conventions, and `setInlineStyle` edits or inserts inside the quoted
  attribute value. A missing inline attribute delegates to Task 5
  `setAttribute` rather than replacing an open tag.
- Preservation coverage includes relative and same-named imports, multiple
  linked sheets, CRLF, comments, XML quote/entity spelling, custom properties,
  shorthands, duplicate properties, unsupported selectors, unknown at-rules,
  balanced malformed recovery regions, and untouched non-target files.
- Pseudo-state requests are canonical and exact. Unsupported, duplicate, or
  malformed state input rejects; inline targets are never offered for a state
  they cannot represent. Stale parsed nodes, invalid properties, forged IDs,
  partial adapters, stale source snapshots, and unsafe append boundaries reject
  with owned error codes before mutation.
- Focused red/green cycles covered adapter metadata, provenance ordering,
  inherited and pseudo-state origins, imported writes, exact removal, local
  formatting, inline preservation, stale identity, parser-valid values,
  malformed boundaries, caller mutation, and source-span trivia. Transactions
  are deterministic across execute, undo, redo, and replay.

## Task 6 Review Fix Round 1

- Every target now carries the requested node ID plus a frozen locator and a
  path-sorted immutable snapshot of every exact `DocumentSession` source.
  Command planning rejects any file change, resolves the requested locator to
  the same current node, recomputes `styleTargetsFor`, and requires exact
  current-target membership before standalone source validation.
- Target IDs are the complete versioned canonical identity serialization, not
  a 32-bit structural hash. The ID remains deterministic but is explicitly not
  an authorization token; current-target membership is the provenance proof.
  Runtime validation rejects malformed nullable provenance, unsafe numeric
  indices, and negative zero before membership checks.
- Rule and inline targets distinguish the requested property from the authored
  declaration property. Longhands produced by supported aggregate shorthands
  are explicit insertion targets with no fake declaration index; writes append
  a local longhand override and removal rejects because no authored longhand
  exists. Exact shorthand requests still patch only the shorthand value.
- Nonempty pseudo-state requests require one unique parser-safe authored node
  name and use only per-node `states`; the global `activeStates` fallback was
  removed. Unnamed and duplicate-name nodes reject with `ambiguous-state`.
- Inline insertion tokenizes only an optional terminator, CSS whitespace, and
  complete block comments at the declaration tail. It inserts before trailing
  comments with local LF/CRLF indentation, preserves the exact comment and
  closing-trivia bytes, and rejects unterminated comments or nontrivia tails.
- Red runs reproduced missing full-session provenance, accepted recomputed
  forgeries, shorthand targets being discarded, global pseudo activation,
  comments receiving declarations after them, malformed tails being accepted,
  inconsistent nullable fields, and the `-0` canonicalization edge. Focused
  Task 6 tests now pass 30 cases; adapter tests pass 15; the full suite passes
  170 tests; and the TypeScript/Vite build passes.

## Task 6 Review Fix Round 2

- The explicit editor-owned aggregate shorthand table now exactly matches every
  expansion in pinned `uxml-preview@0.4.0`: margin, padding, border width,
  border color, border radius, and flex. Flex contributes `flex-grow`,
  `flex-shrink`, and `flex-basis`; a real-adapter characterization test covers
  every shorthand/longhand relation and guards the table's exact key set.
- Flex longhand requests now retain winning and losing authored `flex` origins
  as local override targets, while exact `flex` requests retain exact authored
  declaration targets. `setDeclaration` inserts only the requested longhand and
  leaves the authored shorthand bytes unchanged.
- Inline declaration-tail tokenization records an exact nullable semicolon
  offset. CSS whitespace before a terminator is preserved byte-for-byte and
  insertion occurs after the actual semicolon; without one, the command adds a
  terminator at the parser-owned content boundary without consuming trailing
  whitespace or comments.
- Regression coverage includes spaces, tabs, form feed, LF, CRLF, immediate and
  trailing comments, no-semicolon tails, exact patch bytes, undo/redo, duplicate
  semicolons, and nontrivia rejection. Focused Task 6 plus adapter verification
  passes 54 tests; the full suite passes 13 files and 179 tests; and the
  TypeScript/Vite build passes with 16 transformed modules.

## Task 7 Host Boundary, Persistence, And Recovery

- `HostPort` owns frozen branded roots, scoped paths, exact text/revision reads,
  compare-before-replace writes, watching/disposal, app-data recovery, recent
  projects, dialogs, time, and deterministic scheduling. It imports no Tauri or
  network API. Path normalization rejects absolute, scheme, NUL, root-only, and
  escaping paths.
- `MemoryHost` is the production deterministic conformance host: exact text,
  monotonic revisions, atomic staged replacement, before/during failure
  injection, external writes/deletes, deterministic watcher delivery and
  disposal, controllable time, app-data, recent-project ordering/deduplication,
  and queued dialog outcomes.
- `BrowserHost` requests `{ mode: 'readwrite' }`, verifies read/write permission,
  owns cancellation/denial errors, and rejects paths outside granted roots. A
  structured-clone handle registry persists stable distinct project identities
  through IndexedDB; tests inject a deterministic registry. Browser globals are
  feature-detected at runtime, app-data is enabled only with durable identity,
  and the explicit fallback is a no-network demo `MemoryHost`.
- `SaveCoordinator` preflights exact revisions, rechecks `DocumentSession`
  generation and source after every asynchronous boundary, and never publishes
  stale local state as clean. Save-all is canonical and stops on first failure;
  partial outcomes expose frozen written/pending paths and retain a pre-write
  checkpoint. External changes distinguish clean reload, dirty conflict,
  deletion, same-content rewrite, converged text, and reload/overwrite/cancel.
  Reloads are typed history transactions with coherent undo/redo. Watch bursts
  are deterministic and exact-session scoped.
- Recovery cleanup is stateful: only confirmed fully clean saves clear the
  journal. Cleanup failure remains pending and is retried by a no-op or explicit
  API without rewriting files. Local edits racing cleanup recreate or refresh
  recovery before publication.
- `RecoveryJournal` validates version, exact object fields, canonical safe paths,
  every patch, locator, sequence, checkpoint, and after-snapshot before replay.
  Entry sequence is independent of transaction ID, so edit/undo/redo duplicates
  replay in exact order. Replay is atomic through `DocumentSession.history`,
  including selection and generation rollback. Mixed partial-save disk states
  replay only missing file patches.
- Journal limits default to 128 entries and 4 MiB of deterministic UTF-8 JSON.
  Crossing a limit compacts to one validated full-state transaction with the
  effective selection and undo/redo state; an irreducibly oversized record is
  rejected before app-data replacement.

## Task 7 TDD And Verification

- Original red/green cycles covered missing host modules, path escape, stale and
  failed replacement, watcher timing/disposal, recovery/recent/dialog storage,
  browser fallback/FSA scoping, save/no-op/save-all outcomes, external decisions,
  corruption/schema/patch/locator validation, stale bases, replay rollback, and
  cleanup failure. The initial focused implementation reached 58 passing tests.
- Resumed review reds reproduced missing browser read/write mode, project ID
  collision, stale local reads, history corruption after reload, duplicate undo
  IDs, mixed-disk `stale-base`, unknown watcher rejection, lost cleanup retry,
  false converged conflicts, and unbounded journals. Additional reds covered
  checkpoint/replacement/cleanup generation races and explicit partial paths.
- Final focused command `npm test -- src/core/host src/core/persistence` passed 4
  files and 80 tests. `npx tsc --noEmit` passed. Full `npm test` passed 17 files
  and 259 tests. `npm run build` passed TypeScript and Vite; Vite transformed 16
  modules and emitted the browser bundle successfully.
