---
name: testing-uxml-editor-browser
description: How to run and manually test the UXML editor in a real browser (dev server, opening a project via the File System Access directory picker, byte-level source-fidelity oracles, and known save-path pitfalls).
---

# Manual browser testing of the UXML editor

## Running the app
- `npm run dev` serves the real app on http://localhost:1420 (`src/main.tsx` → BrowserHost + File System Access API).
- Use Chrome. The Playwright specs in `tests/e2e/` show how automated tests bypass the native picker
  (`MemoryHost`); for manual/visual testing prefer the real BrowserHost so you exercise real disk I/O.

## Opening a project (Chrome native directory picker on Linux)
1. Copy a fixture project to a scratch dir, e.g.
   `cp -r fixtures/projects/menu /tmp/uxml-proj` and keep a pristine copy at `/tmp/uxml-proj-orig`.
2. Click the toolbar **Open Project** button (`aria-label="Open Project"`).
3. In the GTK dialog press `Ctrl+L`, type the path (`/tmp/uxml-proj/`), clear any autocomplete text, `Enter`,
   then confirm Chrome's "Edit files" / "Save changes" permission prompt.
4. Select the **project root**, not the inner `Assets` folder. Selecting `Assets` fails with
   "Open Project failed — The selected project does not contain a UXML document."
5. The entry document is chosen automatically (`FileWorkflow.ts` `chooseEntryPath`). There is no document
   switcher in the UI; the Source panel's file `select` (`SourcePanel.tsx`) is the only way to view/edit
   other files (e.g. the `.uss`).

## Byte-level oracle (source fidelity)
Always verify on disk from the shell rather than trusting the UI:
- `md5sum /tmp/uxml-proj/Assets/UI/* /tmp/uxml-proj-orig/Assets/UI/*`
- `diff -u` for the changed-region check, and `cat -A` to confirm CRLF (`^M$`) survived.
Fixtures under `fixtures/projects/menu` deliberately contain CRLF, comments, mixed quoting
(`name = 'play-button'`), and entities (`&#x26;`, `&quot;`) — those are the things to assert unchanged.

## Known pitfalls / things that may be broken
- **Saving non-entry files (e.g. `.uss`) is a historically fragile path.** `FileWorkflow.save()` must route through
  `saveAllActive()` → `SaveCoordinator.saveAll()`; when it only saved the entry document, dirty `.uss` files stayed
  on disk untouched while the `.uxml` was written and the dialog reported an incomplete save. Any change in this
  area should be re-verified with a USS-only edit and a mixed UXML+USS edit, checking bytes on disk both times.
- The failure dialog should name the unsaved paths and the host reason, e.g.
  "The project could not be saved completely. Still unsaved: Assets/UI/Menu.uss, Assets/UI/Menu.uxml.
  Could not replace file: Assets/UI/Menu.uss". A bare generic message = regression.
- **Forcing a real host write failure:** `chmod 555 /tmp/uxml-proj/Assets/UI` blocks Chrome from creating its
  `.crswap` file, so `createWritable()` fails for real. Bytes must be preserved, no `.crswap` left behind, and the
  drafts must stay dirty; `chmod 755` and Save again should then persist them.
- A no-op save (nothing dirty) must leave md5s **and** mtimes untouched — check `stat -c '%n %Y'`, not just md5.
- Unsaved drafts can survive a page reload (recovery journal), so a reload does **not** always give a clean slate;
  undo back to a clean state or use a fresh scratch project directory when isolating a bug. If reopening fails with
  "Recovery journal base is stale.", clear the site's browser storage and reopen.
- After a reload the picker often reopens already inside the last-used directory — check the breadcrumb before
  clicking Open, since selecting the inner `Assets` folder fails.
- Diagnostics surfaces unsupported controls and malformed USS rules, but unknown USS *property names*
  (e.g. `-unity-bogus-property`) may not produce any diagnostic.
- The Source panel is a contenteditable code editor; `double_click` word selection can eat units
  (`24px` → typing `120` yields `120`), so re-check the text after typing.

## Devin Secrets Needed
None — all testing is local.
