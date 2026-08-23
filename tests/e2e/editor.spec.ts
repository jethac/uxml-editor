import { expect, test, type Locator, type Page } from '@playwright/test';

const MENU = 'menu';
const OPTIONS = 'options';
const UNSUPPORTED = 'unsupported';
const BLANK = 'blank';
const COLLISION = 'collision';
const MENU_UXML = 'Assets/UI/Menu.uxml';
const MENU_USS = 'Assets/UI/Menu.uss';
const OPTIONS_UXML = 'Assets/UI/Options.uxml';
const UNSUPPORTED_UXML = 'Assets/UI/Unsupported.uxml';
const UNSUPPORTED_USS = 'Assets/UI/Unsupported.uss';
const NEW_PROJECT_UXML = 'Assets/Main.uxml';
const NEW_PROJECT_SOURCE = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n</ui:UXML>\n';
const RECOVERED_MENU_UXML_REVISION = 'memory:v1:26';
const MENU_USS_BASELINE = [
  '/* Task 17A menu stylesheet: preserve spacing and CRLF. */',
  '.menu-root {',
  '  padding-left: 24px;',
  '  padding-top: 16px;',
  '}',
  '',
  '.menu-button.primary {',
  '  background-color: #18794e;',
  '  color: #ffffff;',
  '}',
  '',
  '.menu-button {',
  '  min-width: 180px;',
  '}',
  '',
].join('\r\n');
const MENU_BASELINE = menuSource([
  '    <ui:Label name="menu-title" text="Main Menu" />',
  "    <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '    <!-- Task 17A menu: keep this comment byte-for-byte. -->',
  '    <!-- keep-between-buttons -->',
  "    <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
]);
const MENU_AFTER_KNOWN_INSERT = menuSource([
  '    <ui:Label name="menu-title" text="Main Menu" />',
  "    <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '    <!-- Task 17A menu: keep this comment byte-for-byte. -->',
  '    <!-- keep-between-buttons -->',
  "    <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
  '    <ui:Button />',
]);
const MENU_AFTER_GENERIC_INSERT = menuSource([
  '    <ui:Label name="menu-title" text="Main Menu" />',
  "    <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '    <!-- Task 17A menu: keep this comment byte-for-byte. -->',
  '    <!-- keep-between-buttons -->',
  "    <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
  '    <ui:Button />',
  '    <ui:VisualElement />',
]);
const MENU_AFTER_RENAME = MENU_AFTER_GENERIC_INSERT.replace('<ui:VisualElement />', '<ui:ScrollView />');
const MENU_AFTER_REORDER = menuSource([
  '    <ui:Label name="menu-title" text="Main Menu" />',
  '    <ui:ScrollView />',
  "    <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '    <!-- Task 17A menu: keep this comment byte-for-byte. -->',
  '    <!-- keep-between-buttons -->',
  '    ',
  "    <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
  '    ',
  '    <ui:Button />',
  '    ',
]);
const MENU_AFTER_KEYBOARD_REPARENT = menuSource([
  '    <ui:Label name="menu-title" text="Main Menu" />',
  '    <ui:ScrollView >',
  "      <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '    </ui:ScrollView>',
  '    ',
  '    <!-- Task 17A menu: keep this comment byte-for-byte. -->',
  '    <!-- keep-between-buttons -->',
  '    ',
  "    <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
  '    ',
  '    <ui:Button />',
  '    ',
]);
const MENU_AFTER_POINTER_REPARENT = menuSource([
  '    <ui:Label name="menu-title" text="Main Menu" />',
  '    <ui:ScrollView >',
  "      <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
  "      <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '    </ui:ScrollView>',
  '    ',
  '    <!-- Task 17A menu: keep this comment byte-for-byte. -->',
  '    <!-- keep-between-buttons -->',
  '    ',
  '    ',
  '    ',
  '    <ui:Button />',
  '    ',
]);
const MENU_AFTER_WRAP = menuSource([
  '    <ui:Label name="menu-title" text="Main Menu" />',
  '    <ui:ScrollView >',
  '      <ui:VisualElement>',
  "        <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
  "      <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '      </ui:VisualElement>',
  '    </ui:ScrollView>',
  '    ',
  '    <!-- Task 17A menu: keep this comment byte-for-byte. -->',
  '    <!-- keep-between-buttons -->',
  '    ',
  '    ',
  '    ',
  '    <ui:Button />',
  '    ',
]);
const MENU_AFTER_DUPLICATE = menuSource([
  '    <ui:Label name="menu-title" text="Main Menu" />',
  '    <ui:ScrollView >',
  '      <ui:VisualElement>',
  "        <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
  "      <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '      </ui:VisualElement>',
  '      <ui:VisualElement>',
  "        <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
  "      <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '      </ui:VisualElement>',
  '    </ui:ScrollView>',
  '    ',
  '    <!-- Task 17A menu: keep this comment byte-for-byte. -->',
  '    <!-- keep-between-buttons -->',
  '    ',
  '    ',
  '    ',
  '    <ui:Button />',
  '    ',
]);
const MENU_AFTER_DELETE = MENU_AFTER_WRAP;
const MENU_AFTER_SOURCE_EDIT = MENU_AFTER_DELETE.replace('Main Menu', 'Edited Menu');
const MENU_AFTER_POST_SOURCE_VISUAL = MENU_AFTER_SOURCE_EDIT.replace(
  '    <ui:Button />\r\n    \r\n  </ui:VisualElement>',
  '    <ui:Button />\r\n    \r\n    \r\n    \r\n    <ui:Button />\r\n    \r\n  </ui:VisualElement>',
);
const UNSUPPORTED_AFTER_GENERIC_CREATE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:acme="Acme.Widgets">',
  '  <Style src="Unsupported.uss" />',
  '  <acme:UnknownPanel name="unknown-panel" class="unknown-panel" mystery-mode="orbital">',
  '    <ui:Label name="preserved-label" class="unsupported-child" text="Preserved child" />',
  '    <ui:Button name="preserved-button" text="Still editable" />',
  '    <acme:Widget />',
  '  </acme:UnknownPanel>',
  '</ui:UXML>',
  '',
].join('\n');
const UNSUPPORTED_USS_BASELINE = [
  '.unknown-panel:focus-visible > .unsupported-child {',
  '  -unity-unsupported-glow: 7px;',
  '  color: #b91c1c;',
  '}',
  '',
  '.unknown-panel:visited {',
  '  opacity: 0.4;',
  '}',
  '',
].join('\n');
const MENU_AFTER_PASTE_PLAY = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<ui:UXML xmlns:ui='UnityEngine.UIElements'>",
  '  <Style src = "Menu.uss" />',
  '  <ui:VisualElement name="menu-root" class="menu-root">',
  '    <ui:Label name="menu-title" text="Main Menu" />',
  "    <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '    <!-- Task 17A menu: keep this comment byte-for-byte. -->',
  '    <!-- keep-between-buttons -->',
  "    <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />",
  "    <ui:Button name = 'play-button-copy' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />",
  '  </ui:VisualElement>',
  '</ui:UXML>',
  '',
].join('\r\n');

test('opens, closes, and reopens the menu project through the production editor', async ({ page }) => {
  await openEditor(page);
  const baseline = await project(page, MENU);

  await page.getByRole('button', { name: 'Open Project' }).click();
  await settled(page);

  await expectOpenProject(page, 'Menu Fixture');
  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  await expect(hierarchy.getByRole('treeitem', { name: 'menu-root' })).toBeVisible();
  await expect(hierarchy.getByRole('treeitem', { name: 'menu-title' })).toBeVisible();
  await expect(hierarchy.getByRole('treeitem', { name: 'play-button' })).toBeVisible();
  await expect(hierarchy.getByRole('treeitem', { name: 'quit-button' })).toBeVisible();
  await expect(page.getByTestId('canvas-renderer')).toContainText('Main Menu');

  await runPaletteCommand(page, 'Close Project');
  await expectClosedProject(page);
  await runPaletteCommand(page, 'Reopen Project');
  await expectOpenProject(page, 'Menu Fixture');
  expect(await project(page, MENU)).toEqual(baseline);
});

test('clean Save and Save All preserve every menu byte and revision', async ({ page }) => {
  await openMenu(page);
  const before = await project(page, MENU);

  await page.getByRole('button', { name: 'Save' }).click();
  await settled(page);
  await runPaletteCommand(page, 'Save All');

  const after = await project(page, MENU);
  expect(Object.keys(after.files).sort()).toEqual([MENU_USS, MENU_UXML].sort());
  expect(after).toEqual(before);
});

test('copies and pastes a selected subtree through visible controls, selecting the generated node', async ({ page }) => {
  await openMenu(page);
  const before = await project(page, MENU);

  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const play = hierarchy.getByRole('treeitem', { name: 'play-button' });
  await play.focus();
  await page.keyboard.press('Enter');
  await expect(play).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Copy selection' }).click();
  const menuRoot = hierarchy.getByRole('treeitem', { name: 'menu-root' });
  await menuRoot.focus();
  await page.keyboard.press('Enter');
  await expect(menuRoot).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Paste' }).click();

  const pasted = hierarchy.getByRole('treeitem', { name: 'play-button-copy' });
  await expect(pasted).toBeVisible();
  await expect(pasted).toHaveAttribute('aria-selected', 'true');
  await expect(menuRoot).toHaveAttribute('aria-selected', 'false');

  await showSource(page, MENU_UXML);
  expect(await visibleSourceText(page, MENU_UXML)).toBe(normalizeVisibleSource(MENU_AFTER_PASTE_PLAY));
  await runPaletteCommand(page, 'Undo');
  await expectVisibleSource(page, MENU_UXML, MENU_BASELINE);
  await expect(menuRoot).toHaveAttribute('aria-selected', 'true');
  await runPaletteCommand(page, 'Redo');
  expect(await visibleSourceText(page, MENU_UXML)).toBe(normalizeVisibleSource(MENU_AFTER_PASTE_PLAY));
  await expect(pasted).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Save' }).click();
  await settled(page);
  const after = await project(page, MENU);
  expect(after.files[MENU_UXML]?.text).toBe(MENU_AFTER_PASTE_PLAY);
  expect(after.files[MENU_UXML]?.revision).not.toBe(before.files[MENU_UXML]?.revision);
  await runPaletteCommand(page, 'Close Project');
  await expectClosedProject(page);
  await runPaletteCommand(page, 'Reopen Project');
  await expectOpenProject(page, 'Menu Fixture');
  expect(await project(page, MENU)).toEqual(after);
});

test('rejects an unavailable production clipboard read without mutating source bytes', async ({ page }) => {
  await openMenu(page);
  const before = await project(page, MENU);
  const sourceBefore = await visibleSourceTextAfterSourceOpen(page, MENU_UXML);

  await page.getByRole('button', { name: 'Paste' }).click();

  await expect(page.locator('.canvas-interaction-status')).toContainText(/clipboard/i);
  expect(await visibleSourceText(page, MENU_UXML)).toBe(sourceBefore);
  expect(await project(page, MENU)).toEqual(before);
});

test('authors structure through palette, hierarchy, canvas, source, and pointer controls', async ({ page }) => {
  await openMenu(page);
  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const menuRoot = hierarchy.getByRole('treeitem', { name: 'menu-root' });
  await menuRoot.focus();
  await page.keyboard.press('Enter');

  await page.getByRole('searchbox', { name: 'Search elements' }).fill('button');
  await page.getByRole('button', { name: 'Add Button' }).click();
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_KNOWN_INSERT);
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has unsaved changes.');
  await expectStructuralSelection(page, hierarchy.getByRole('treeitem', { name: 'ui:Button' }), 'ui:Button');
  await expect(hierarchy.getByRole('treeitem', { name: 'ui:Button' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Generic qualified name' }).fill('ui:VisualElement');
  await page.getByRole('button', { name: 'Add generic element' }).click();
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_GENERIC_INSERT);
  const generic = hierarchy.getByRole('treeitem', { name: 'ui:VisualElement' });
  await expect(generic).toHaveAttribute('aria-selected', 'true');
  await expectStructuralSelection(page, generic, 'ui:VisualElement');

  await page.getByRole('button', { name: 'Rename selected' }).click();
  await page.getByRole('textbox', { name: 'Qualified element name' }).fill('ui:ScrollView');
  await page.getByRole('button', { name: 'Apply rename' }).click();
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_RENAME);
  const scrollView = hierarchy.getByRole('treeitem', { name: 'ui:ScrollView' });
  await expectStructuralSelection(page, scrollView, 'ui:ScrollView');
  await page.getByRole('button', { name: 'Move selected up' }).click();
  await page.getByRole('button', { name: 'Move selected up' }).click();
  await page.getByRole('button', { name: 'Move selected up' }).click();
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_REORDER);
  await expectStructuralSelection(page, scrollView, 'ui:ScrollView');

  const play = hierarchy.getByRole('treeitem', { name: 'play-button' });
  await play.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Alt+ArrowRight');
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_KEYBOARD_REPARENT);
  await expect(play).toHaveAttribute('aria-level', '4');
  await expectStructuralSelection(page, play, 'ui:Button');

  const quit = hierarchy.getByRole('treeitem', { name: 'quit-button' });
  await quit.dragTo(scrollView);
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_POINTER_REPARENT);
  await expect(quit).toHaveAttribute('aria-level', '4');
  await expectStructuralSelection(page, quit, 'ui:Button');
  await play.dragTo(quit);
  await expect(page.getByRole('alert')).toContainText('Button cannot contain children');
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_POINTER_REPARENT);

  await play.focus();
  await page.keyboard.press('Enter');
  await quit.focus();
  await page.keyboard.press('Control+Enter');
  await expect(play).toHaveAttribute('aria-selected', 'true');
  await expect(quit).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Wrap selected' }).click();
  await page.getByRole('textbox', { name: 'Wrapper element name' }).fill('ui:VisualElement');
  await page.getByRole('button', { name: 'Apply wrap' }).click();
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_WRAP);
  const wrapper = hierarchy.getByRole('treeitem', { name: 'ui:VisualElement' });
  await expect(wrapper).toHaveAttribute('aria-selected', 'true');
  await expectStructuralSelection(page, wrapper, 'ui:VisualElement');
  await page.getByRole('button', { name: 'Duplicate selected' }).click();
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_DUPLICATE);
  await expect(hierarchy.getByRole('treeitem', { name: 'ui:VisualElement' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove selected' }).click();
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_DELETE);
  await expect(hierarchy.getByRole('treeitem', { name: 'ui:VisualElement' })).toHaveCount(1);
  await expectStructuralSelection(page, scrollView, 'ui:ScrollView');
  await runPaletteCommand(page, 'Undo');
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_DUPLICATE);
  await expect(hierarchy.getByRole('treeitem', { name: 'ui:VisualElement' })).toHaveCount(2);
  await expectStructuralSelection(page, hierarchy.locator('[role="treeitem"][aria-selected="true"]'), 'ui:VisualElement');
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has unsaved changes.');
  await runPaletteCommand(page, 'Redo');
  await expectVisibleSource(page, MENU_UXML, MENU_AFTER_DELETE);
  await expect(hierarchy.getByRole('treeitem', { name: 'ui:VisualElement' })).toHaveCount(1);
  await expectStructuralSelection(page, scrollView, 'ui:ScrollView');
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has unsaved changes.');

  await hierarchy.getByRole('treeitem', { name: 'menu-title' }).focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('canvas-renderer').getByText('Main Menu', { exact: true }).click();
  await expect(hierarchy.getByRole('treeitem', { name: 'menu-title' })).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('canvas-renderer').getByText('Play & Go', { exact: true }).click({ modifiers: ['Shift'] });
  await expect(hierarchy.getByRole('treeitem', { name: 'menu-title' })).toHaveAttribute('aria-selected', 'true');
  await expect(play).toHaveAttribute('aria-selected', 'true');

  await replaceVisibleText(page, MENU_UXML, 'Main Menu', 'Edited Menu');
  await expect(page.getByTestId('canvas-renderer')).toContainText('Edited Menu');
  await expectSourceHistoryState(page, hierarchy, MENU_AFTER_SOURCE_EDIT);
  await runPaletteCommand(page, 'Undo');
  await expect(page.getByTestId('canvas-renderer')).toContainText('Main Menu');
  await expectSourceHistoryState(page, hierarchy, MENU_AFTER_DELETE);
  await runPaletteCommand(page, 'Redo');
  await expectSourceHistoryState(page, hierarchy, MENU_AFTER_SOURCE_EDIT);

  await menuRoot.focus();
  await page.keyboard.press('Enter');
  await expectStructuralSelection(page, menuRoot, 'ui:VisualElement');
  await page.getByRole('button', { name: 'Add Button' }).click();
  await expectMountedVisibleSource(page, MENU_UXML, MENU_AFTER_POST_SOURCE_VISUAL);
  await expect(hierarchy.getByRole('treeitem', { name: 'ui:Button' })).toHaveCount(2);
  await expectStructuralSelection(page, hierarchy.locator('[role="treeitem"][aria-selected="true"]'), 'ui:Button');
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has unsaved changes.');
  await runPaletteCommand(page, 'Undo');
  await expectMountedVisibleSource(page, MENU_UXML, MENU_AFTER_SOURCE_EDIT);
  await expect(hierarchy.getByRole('treeitem', { name: 'ui:Button' })).toHaveCount(1);
  await expectStructuralSelection(page, menuRoot, 'ui:VisualElement');
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has unsaved changes.');
  await runPaletteCommand(page, 'Redo');
  await expectMountedVisibleSource(page, MENU_UXML, MENU_AFTER_POST_SOURCE_VISUAL);
  await expect(hierarchy.getByRole('treeitem', { name: 'ui:Button' })).toHaveCount(2);
  await expectStructuralSelection(page, hierarchy.locator('[role="treeitem"][aria-selected="true"]'), 'ui:Button');
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has unsaved changes.');
  const finalExpectedSource = MENU_AFTER_POST_SOURCE_VISUAL;
  await page.getByRole('button', { name: 'Save' }).click();
  await settled(page);
  const persisted = await project(page, MENU);
  expect(persisted.files[MENU_UXML]?.text).toBe(finalExpectedSource);
  expectOnlyCrLf(persisted.files[MENU_UXML]!.text);
  expect(persisted.files[MENU_USS]?.text).toBe(MENU_USS_BASELINE);
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has no unsaved changes.');
  await runPaletteCommand(page, 'Close Project');
  await runPaletteCommand(page, 'Reopen Project');
  await showSource(page, MENU_UXML);
  await expectVisibleSource(page, MENU_UXML, finalExpectedSource);
});

test('preserves an authored non-UI namespace through generic palette creation and reopen', async ({ page }) => {
  await openEditor(page);
  await resetEditor(page, UNSUPPORTED);
  await page.getByRole('button', { name: 'Open Project' }).click();
  await settled(page);
  await expectOpenProject(page, 'Unsupported Fixture');
  const before = await project(page, UNSUPPORTED);
  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const unknownPanel = hierarchy.getByRole('treeitem', { name: 'unknown-panel' });
  await unknownPanel.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Generic qualified name' }).fill('acme:Widget');
  await page.getByRole('button', { name: 'Add generic element' }).click();

  const widget = hierarchy.getByRole('treeitem', { name: 'acme:Widget' });
  await expectVisibleSource(page, UNSUPPORTED_UXML, UNSUPPORTED_AFTER_GENERIC_CREATE);
  await expectStructuralSelection(page, widget, 'acme:Widget');
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has unsaved changes.');
  expect(before.files[UNSUPPORTED_USS]?.text).toBe(UNSUPPORTED_USS_BASELINE);
  await page.getByRole('button', { name: 'Save' }).click();
  await settled(page);
  const saved = await project(page, UNSUPPORTED);
  expect(saved.files[UNSUPPORTED_UXML]?.text).toBe(UNSUPPORTED_AFTER_GENERIC_CREATE);
  expect(saved.files[UNSUPPORTED_UXML]?.revision).not.toBe(before.files[UNSUPPORTED_UXML]?.revision);
  expect(saved.files[UNSUPPORTED_USS]).toEqual(before.files[UNSUPPORTED_USS]);
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has no unsaved changes.');
  await runPaletteCommand(page, 'Close Project');
  await expectClosedProject(page);
  await runPaletteCommand(page, 'Reopen Project');
  await expectOpenProject(page, 'Unsupported Fixture');
  await expectVisibleSource(page, UNSUPPORTED_UXML, UNSUPPORTED_AFTER_GENERIC_CREATE);
  const reopened = await project(page, UNSUPPORTED);
  expect(reopened).toEqual(saved);
  expect(reopened.files[UNSUPPORTED_UXML]).toEqual({
    text: UNSUPPORTED_AFTER_GENERIC_CREATE,
    revision: saved.files[UNSUPPORTED_UXML]?.revision,
  });
  expect(reopened.files[UNSUPPORTED_USS]).toEqual({
    text: UNSUPPORTED_USS_BASELINE,
    revision: saved.files[UNSUPPORTED_USS]?.revision,
  });
  await page.getByRole('combobox', { name: 'Source file' }).selectOption(UNSUPPORTED_USS);
  await expect(sourceEditor(page, UNSUPPORTED_USS)).toBeVisible();
  expect(await visibleSourceText(page, UNSUPPORTED_USS)).toBe(normalizeVisibleSource(UNSUPPORTED_USS_BASELINE));
});

test('creates, saves, closes, and reopens an unsaved project with exact bytes', async ({ page }) => {
  await openEditor(page);
  const blankBefore = await project(page, BLANK);

  await page.keyboard.press('Control+N');
  await settled(page);
  await expect(page.getByLabel('Project status')).toContainText('Untitled Project');
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  await expectPaletteCommand(page, 'Save All', false);
  await expectPaletteCommand(page, 'Reload Project', false);

  await selectProject(page, BLANK);
  await page.getByRole('button', { name: 'Save' }).click();
  await settled(page);

  await expectOpenProject(page, 'Blank Destination');
  await expectPaletteCommand(page, 'Save All', true);
  await expectPaletteCommand(page, 'Reload Project', true);
  const blankAfter = await project(page, BLANK);
  expect(blankBefore.files).toEqual({});
  expect(blankAfter.files).toEqual({
    [NEW_PROJECT_UXML]: {
      text: NEW_PROJECT_SOURCE,
      revision: blankAfter.files[NEW_PROJECT_UXML]?.revision,
    },
  });
  expect(blankAfter.files[NEW_PROJECT_UXML]?.revision).toMatch(/^memory:v1:\d+$/);

  await runPaletteCommand(page, 'Close Project');
  await expectClosedProject(page);
  await runPaletteCommand(page, 'Reopen Project');
  await expectOpenProject(page, 'Blank Destination');
  expect(await project(page, BLANK)).toEqual(blankAfter);
});

test('Save As collision cancellation is exact and confirmation safely replaces the destination', async ({ page }) => {
  await openMenu(page);
  const source = await project(page, MENU);
  const collisionBefore = await project(page, COLLISION);

  await selectProject(page, COLLISION);
  await queueConfirmation(page, false);
  await runPaletteCommand(page, 'Save As');

  expect(await project(page, COLLISION)).toEqual(collisionBefore);
  let observations = await hostObservations(page);
  expect(observations.confirmations).toEqual([overwriteConfirmation(2)]);
  await expectOpenProject(page, 'Menu Fixture');

  await selectProject(page, COLLISION);
  await queueConfirmation(page, true);
  await runPaletteCommand(page, 'Save As');

  const collisionAfter = await project(page, COLLISION);
  expect(collisionAfter.files[MENU_UXML]?.text).toBe(source.files[MENU_UXML]?.text);
  expect(collisionAfter.files[MENU_USS]?.text).toBe(source.files[MENU_USS]?.text);
  expect(collisionAfter.files[MENU_UXML]?.revision).not.toBe(collisionBefore.files[MENU_UXML]?.revision);
  expect(collisionAfter.files[MENU_USS]?.revision).not.toBe(collisionBefore.files[MENU_USS]?.revision);
  expect(await project(page, MENU)).toEqual(source);
  observations = await hostObservations(page);
  expect(observations.confirmations).toEqual([overwriteConfirmation(2), overwriteConfirmation(2)]);
  await expectOpenProject(page, 'Collision Destination');
});

test('Open Recent requires the selected project identity and preserves state on mismatch', async ({ page }) => {
  await openMenu(page);
  await runPaletteCommand(page, 'Close Project');

  await selectProject(page, MENU);
  await runPaletteCommand(page, 'Open Recent Project');
  await expectOpenProject(page, 'Menu Fixture');
  const beforeMismatch = await hostObservations(page);
  expect(beforeMismatch.recent).toEqual([{
    root: { id: 'fixture:menu', name: 'Menu Fixture' },
    lastOpenedAt: 1_723_689_600_000,
  }]);

  await selectProject(page, OPTIONS);
  await runPaletteCommand(page, 'Open Recent Project');

  await expectOpenProject(page, 'Menu Fixture');
  const afterMismatch = await hostObservations(page);
  expect(afterMismatch.messages).toEqual([{
    kind: 'warning',
    title: 'Different project selected',
    message: 'Select Menu Fixture to open this recent project.',
  }]);
  expect(afterMismatch.recent).toEqual(beforeMismatch.recent);
});

test('Reload Project is a deterministic no-op after the watch applies a clean external change', async ({ page }) => {
  await openMenu(page);
  const before = await project(page, MENU);
  const original = before.files[MENU_UXML]!;
  const changedText = original.text.replace('text="Main Menu"', 'text="Reloaded Menu"');
  expect(changedText).not.toBe(original.text);

  await showSource(page, MENU_UXML);
  await expect(sourceEditor(page, MENU_UXML)).toContainText('Main Menu');
  await externalWrite(page, MENU, MENU_UXML, changedText);
  const afterExternalWrite = await project(page, MENU);
  expect(afterExternalWrite.files[MENU_UXML]).toEqual({
    text: changedText,
    revision: afterExternalWrite.files[MENU_UXML]?.revision,
  });
  expect(afterExternalWrite.files[MENU_UXML]?.revision).not.toBe(original.revision);
  await expect(sourceEditor(page, MENU_UXML)).toContainText('Main Menu');

  await advanceTime(page, 50);
  await expect(sourceEditor(page, MENU_UXML)).toContainText('Reloaded Menu');
  const afterWatch = await project(page, MENU);

  await runPaletteCommand(page, 'Reload Project');
  expect(await project(page, MENU)).toEqual(afterWatch);
  await expect(sourceEditor(page, MENU_UXML)).toContainText('Reloaded Menu');
  await runPaletteCommand(page, 'Close Project');
  await expectClosedProject(page);
});

test('a second reset awaits both real workflow teardowns and retires prior callbacks', async ({ page }) => {
  await openMenu(page);
  const menuSource = (await project(page, MENU)).files[MENU_UXML]!.text;
  await showSource(page, MENU_UXML);
  await sourceEditor(page, MENU_UXML).fill(menuSource.replace('Main Menu', 'Retired Menu'));

  await resetEditor(page, OPTIONS);
  expect(await runtimeState(page)).toMatchObject({
    activeRuntime: 2,
    completedTeardowns: [1],
    lateHostOperations: 0,
  });
  await page.getByRole('button', { name: 'Open Project' }).click();
  await settled(page);
  await expectOpenProject(page, 'Options Fixture');
  const optionsSource = (await project(page, OPTIONS)).files[OPTIONS_UXML]!.text;
  await showSource(page, OPTIONS_UXML);
  await sourceEditor(page, OPTIONS_UXML).fill(optionsSource.replace('Runner', 'Retired Runner'));

  await resetEditor(page, MENU);
  await drainSourceCallbacks(page);
  const state = await runtimeState(page);
  expect(state).toMatchObject({
    activeRuntime: 3,
    completedTeardowns: [1, 2],
    lateHostOperations: 0,
  });
  expect(state.sourceSchedulers).toHaveLength(3);
  for (const scheduler of state.sourceSchedulers.slice(0, 2)) {
    expect(scheduler.scheduled).toBeGreaterThan(0);
    expect(scheduler.cancelled).toBe(scheduler.scheduled);
    expect(scheduler.executed).toBe(0);
    expect(scheduler.pending).toBe(0);
  }
  await page.getByRole('button', { name: 'Open Project' }).click();
  await settled(page);
  await expectOpenProject(page, 'Menu Fixture');
  expect(await project(page, MENU)).toEqual(await baseline(page, MENU));
});

test('a replacement failure preserves bytes and surfaces a recoverable dirty edit', async ({ page }) => {
  await openMenu(page);
  const before = await project(page, MENU);
  const original = before.files[MENU_UXML]!;
  const changedText = original.text.replace('text="Main Menu"', 'text="Save Recovery"');
  expect(changedText).not.toBe(original.text);

  await showSource(page, MENU_UXML);
  await replaceVisibleText(page, MENU_UXML, 'Main Menu', 'Save Recovery');
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await expect.poll(async () => (
    await hostObservations(page)
  ).recovery['fixture:menu']).not.toBeNull();
  expect(await project(page, MENU)).toEqual(before);
  const storedRecovery = (await hostObservations(page)).recovery['fixture:menu'];
  expect(storedRecovery).not.toBeNull();
  const recoveryJournal = JSON.parse(storedRecovery!) as {
    readonly version: number;
    readonly projectId: string;
    readonly entryPath: string;
    readonly records: readonly Readonly<{
      readonly transaction: Readonly<{
        readonly patches: readonly Readonly<{
          readonly path: string;
          readonly patches: readonly Readonly<{ start: number; end: number; replacement: string }>[];
        }>[];
      }>;
      readonly after: readonly Readonly<{ path: string; text: string }>[];
    }>[];
  };
  expect(recoveryJournal).toMatchObject({
    version: 1,
    projectId: 'fixture:menu',
    entryPath: MENU_UXML,
  });
  expect(recoveryJournal.records).toHaveLength(1);
  expect(recoveryJournal.records[0]?.transaction.patches).toEqual([{
    path: MENU_UXML,
    patches: [{ start: 0, end: original.text.length, replacement: changedText }],
  }]);
  expect(recoveryJournal.records[0]?.after).toEqual([
    { path: MENU_USS, text: before.files[MENU_USS]!.text },
    { path: MENU_UXML, text: changedText },
  ]);

  await injectReplacementFailure(page, 'Task 17A2a replacement failed.');
  await page.getByRole('button', { name: 'Save' }).click();
  const error = page.getByRole('alertdialog', { name: 'Command failed' });
  await expect(error).toContainText('Save failed');
  await expect(error).toContainText('The project could not be saved completely.');
  await settled(page);
  expect(await project(page, MENU)).toEqual(before);
  expect((await hostObservations(page)).messages).toEqual([]);

  await error.getByRole('button', { name: 'Dismiss' }).click();
  await restartEditor(page);
  await page.getByRole('button', { name: 'Open Project' }).click();
  await settled(page);
  await expectOpenProject(page, 'Menu Fixture');
  expect(await project(page, MENU)).toEqual(before);
  await showSource(page, MENU_UXML);
  expect(await visibleSourceText(page, MENU_UXML)).toBe(normalizeVisibleSource(changedText));

  await page.getByRole('button', { name: 'Save' }).click();
  await settled(page);
  const recovered = await project(page, MENU);
  expect(recovered.files[MENU_UXML]).toEqual({
    text: changedText,
    revision: recovered.files[MENU_UXML]?.revision,
  });
  expectOnlyCrLf(recovered.files[MENU_UXML]!.text);
  expect(recovered.files[MENU_UXML]!.revision).toBe(RECOVERED_MENU_UXML_REVISION);
  expect(recovered.files[MENU_USS]).toEqual(before.files[MENU_USS]);
  expect((await hostObservations(page)).recovery['fixture:menu']).toBeNull();
});

type ProjectKey = 'menu' | 'options' | 'unsupported' | 'blank' | 'collision';

interface FileSnapshot {
  readonly text: string;
  readonly revision: string;
}

interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly files: Readonly<Record<string, FileSnapshot>>;
}

interface HostObservations {
  readonly recovery: Readonly<Record<string, string | null>>;
  readonly recent: readonly Readonly<{
    root: Readonly<{ id: string; name: string }>;
    lastOpenedAt: number;
  }>[];
  readonly confirmations: readonly Readonly<{
    kind: string;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
  }>[];
  readonly messages: readonly Readonly<{
    kind: string;
    title: string;
    message: string;
  }>[];
}

interface EditorFixtureBridge {
  reset(source?: Exclude<ProjectKey, 'blank' | 'collision'>): Promise<void>;
  restart(): Promise<void>;
  settled(): Promise<void>;
  drainSourceCallbacks(): Promise<void>;
  selectProject(key: ProjectKey): void;
  queueConfirmation(confirmed: boolean): void;
  injectReplacementFailure(message: string): void;
  externalWrite(key: ProjectKey, path: string, text: string): Promise<void>;
  advanceTime(milliseconds: number): Promise<void>;
  project(key: ProjectKey): Promise<ProjectSnapshot>;
  baseline(key: ProjectKey): ProjectSnapshot;
  observations(): Promise<HostObservations>;
  runtimeState(): Readonly<{
    activeRuntime: number;
    completedTeardowns: readonly number[];
    lateHostOperations: number;
    sourceSchedulers: readonly Readonly<{
      runtime: number;
      scheduled: number;
      cancelled: number;
      executed: number;
      pending: number;
    }>[];
  }>;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/tests/e2e/fixtures/editor.html');
  await expect(page.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
  await settled(page);
}

async function openMenu(page: Page): Promise<void> {
  await openEditor(page);
  await page.getByRole('button', { name: 'Open Project' }).click();
  await settled(page);
  await expectOpenProject(page, 'Menu Fixture');
}

async function expectOpenProject(page: Page, name: string): Promise<void> {
  await expect(page.getByLabel('Project status')).toContainText(name);
  await expect(page.getByRole('tree', { name: 'Document hierarchy' })).toBeVisible();
  await expect(page.getByLabel('Canvas editing area')).toBeVisible();
}

async function expectClosedProject(page: Page): Promise<void> {
  await expect(page.getByLabel('Project status')).toContainText('No project open');
  await expect(page.getByText('No document', { exact: true }).first()).toBeVisible();
}

async function runPaletteCommand(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Command Palette' }).click();
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette.getByRole('searchbox', { name: 'Search commands' }).fill(label);
  await palette.getByRole('option', { name: new RegExp(`^${escapeRegex(label)}\\b`) }).click();
  await settled(page);
}

async function expectPaletteCommand(page: Page, label: string, enabled: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Command Palette' }).click();
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette.getByRole('searchbox', { name: 'Search commands' }).fill(label);
  const option = palette.getByRole('option', { name: new RegExp(`^${escapeRegex(label)}\\b`) });
  if (enabled) await expect(option).toBeEnabled();
  else await expect(option).toBeDisabled();
  await page.keyboard.press('Escape');
}

async function showSource(page: Page, path: string): Promise<void> {
  await page.getByRole('tab', { name: 'Source' }).click();
  await expect(sourceEditor(page, path)).toBeVisible();
}

function sourceEditor(page: Page, path: string): Locator {
  return page.getByRole('textbox', { name: `${path} source` });
}

async function visibleSourceText(page: Page, path: string): Promise<string> {
  return (await sourceEditor(page, path).locator('.cm-line').allTextContents()).join('\n');
}

async function visibleSourceTextAfterSourceOpen(page: Page, path: string): Promise<string> {
  await showSource(page, path);
  return visibleSourceText(page, path);
}

async function expectVisibleSource(page: Page, path: string, expected: string): Promise<void> {
  await showSource(page, path);
  expect(await visibleSourceText(page, path)).toBe(normalizeVisibleSource(expected));
}

async function expectMountedVisibleSource(page: Page, path: string, expected: string): Promise<void> {
  await expect(sourceEditor(page, path)).toBeVisible();
  expect(await visibleSourceText(page, path)).toBe(normalizeVisibleSource(expected));
}

async function expectStructuralSelection(page: Page, row: Locator, inspectorName: string): Promise<void> {
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Inspector selection context')).toContainText(inspectorName);
  await expect(page.getByTestId('selected-bounds')).toBeVisible();
}

async function expectSourceHistoryState(page: Page, hierarchy: Locator, expectedSource: string): Promise<void> {
  const uxmlRoot = hierarchy.getByRole('treeitem', { name: 'ui:UXML' });
  const menuRoot = hierarchy.getByRole('treeitem', { name: 'menu-root' });
  const title = hierarchy.getByRole('treeitem', { name: 'menu-title' });
  const scrollView = hierarchy.getByRole('treeitem', { name: 'ui:ScrollView' });
  const wrapper = hierarchy.getByRole('treeitem', { name: 'ui:VisualElement' });
  const play = hierarchy.getByRole('treeitem', { name: 'play-button' });
  const quit = hierarchy.getByRole('treeitem', { name: 'quit-button' });
  const unnamedButton = hierarchy.getByRole('treeitem', { name: 'ui:Button' });

  await expectMountedVisibleSource(page, MENU_UXML, expectedSource);
  await expect(hierarchy.getByRole('treeitem')).toHaveCount(9);
  await expect(uxmlRoot).toHaveAttribute('aria-level', '1');
  await expect(menuRoot).toHaveAttribute('aria-level', '2');
  await expect(title).toHaveAttribute('aria-level', '3');
  await expect(scrollView).toHaveAttribute('aria-level', '3');
  await expect(wrapper).toHaveAttribute('aria-level', '4');
  await expect(quit).toHaveAttribute('aria-level', '5');
  await expect(play).toHaveAttribute('aria-level', '5');
  await expect(unnamedButton).toHaveAttribute('aria-level', '3');
  await expect(title).toHaveAttribute('aria-selected', 'true');
  await expect(play).toHaveAttribute('aria-selected', 'true');
  await expect(menuRoot).toHaveAttribute('aria-selected', 'false');
  await expect(scrollView).toHaveAttribute('aria-selected', 'false');
  await expect(quit).toHaveAttribute('aria-selected', 'false');
  await expect(unnamedButton).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByLabel('Inspector selection context')).toContainText('2 elements');
  await expect(page.getByTestId('selected-bounds')).toBeVisible();
  await expect(page.getByLabel('Project status')).toHaveAttribute('aria-description', 'Project has unsaved changes.');
}

async function replaceVisibleText(page: Page, path: string, search: string, replacement: string): Promise<void> {
  const editor = sourceEditor(page, path);
  await editor.click();
  await page.getByRole('button', { name: 'Find in source' }).click();
  const find = page.getByRole('textbox', { name: 'Find' });
  await find.fill(search);
  await page.getByRole('textbox', { name: 'Replace' }).fill(replacement);
  await page.getByRole('button', { name: 'replace all', exact: true }).click();
  await page.getByRole('button', { name: 'close', exact: true }).click();
  await expect(editor).toContainText(replacement);
  await drainSourceCallbacks(page);
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.settled());
}

async function drainSourceCallbacks(page: Page): Promise<void> {
  await page.evaluate(() => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.drainSourceCallbacks());
}

async function resetEditor(page: Page, source: Exclude<ProjectKey, 'blank' | 'collision'>): Promise<void> {
  await page.evaluate((value) => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.reset(value), source);
  await expect(page.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
}

async function restartEditor(page: Page): Promise<void> {
  await page.evaluate(() => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.restart());
  await expect(page.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
}

async function selectProject(page: Page, key: ProjectKey): Promise<void> {
  await page.evaluate((value) => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.selectProject(value), key);
}

async function queueConfirmation(page: Page, confirmed: boolean): Promise<void> {
  await page.evaluate((value) => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.queueConfirmation(value), confirmed);
}

async function injectReplacementFailure(page: Page, message: string): Promise<void> {
  await page.evaluate((value) => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.injectReplacementFailure(value), message);
}

async function externalWrite(page: Page, key: ProjectKey, path: string, text: string): Promise<void> {
  await page.evaluate(
    (input) => (window as typeof window & {
      __task17a2a: EditorFixtureBridge;
    }).__task17a2a.externalWrite(input.key, input.path, input.text),
    { key, path, text },
  );
}

async function advanceTime(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((value) => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.advanceTime(value), milliseconds);
  await settled(page);
}

async function project(page: Page, key: ProjectKey): Promise<ProjectSnapshot> {
  return page.evaluate((value) => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.project(value), key);
}

async function baseline(page: Page, key: ProjectKey): Promise<ProjectSnapshot> {
  return page.evaluate((value) => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.baseline(value), key);
}

async function hostObservations(page: Page): Promise<HostObservations> {
  return page.evaluate(() => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.observations());
}

async function runtimeState(page: Page) {
  return page.evaluate(() => (window as typeof window & {
    __task17a2a: EditorFixtureBridge;
  }).__task17a2a.runtimeState());
}

function overwriteConfirmation(count: number) {
  return {
    kind: 'overwrite',
    title: 'Replace project files',
    message: `Replace ${count} existing project files?`,
    confirmLabel: 'Replace',
    cancelLabel: 'Cancel',
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectOnlyCrLf(value: string): void {
  expect(value.endsWith('\r\n')).toBe(true);
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\n') expect(value[index - 1], `lone LF at ${index}`).toBe('\r');
    if (value[index] === '\r') expect(value[index + 1], `lone CR at ${index}`).toBe('\n');
  }
}

function menuSource(children: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<ui:UXML xmlns:ui='UnityEngine.UIElements'>",
    '  <Style src = "Menu.uss" />',
    '  <ui:VisualElement name="menu-root" class="menu-root">',
    ...children,
    '  </ui:VisualElement>',
    '</ui:UXML>',
    '',
  ].join('\r\n');
}

function normalizeVisibleSource(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}
