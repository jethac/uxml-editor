import { expect, test, type Locator, type Page } from '@playwright/test';

const MENU = 'menu';
const OPTIONS = 'options';
const ASSETS = 'assets';
const NESTED_STYLES = 'nested-styles';
const UNSUPPORTED = 'unsupported';
const BLANK = 'blank';
const COLLISION = 'collision';
const MENU_UXML = 'Assets/UI/Menu.uxml';
const MENU_USS = 'Assets/UI/Menu.uss';
const OPTIONS_UXML = 'Assets/UI/Options.uxml';
const ASSETS_UXML = 'Assets/UI/Assets.uxml';
const ASSETS_USS = 'Assets/UI/Assets.uss';
const NESTED_UXML = 'Assets/UI/Nested.uxml';
const NESTED_BASE_USS = 'Assets/UI/base.uss';
const NESTED_BUTTONS_USS = 'Assets/UI/components/buttons.uss';
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
const MENU_CANVAS_BASELINE = MENU_BASELINE
  .replace(
    'text="Play &amp; Go" tooltip=\'Press &quot;Enter&quot;\'',
    'text="Play &amp; Go" style="position: absolute; left: 40px; top: 30px; width: 160px; height: 40px;" tooltip=\'Press &quot;Enter&quot;\'',
  )
  .replace(
    "text='Quit &#x26; Save' />",
    "text='Quit &#x26; Save' style=\"position: absolute; left: 225px; top: 30px; width: 160px; height: 40px;\" />",
  );
const MENU_CANVAS_AFTER_SNAP_MOVE = MENU_CANVAS_BASELINE.replace(
  'left: 40px; top: 30px;',
  'left: 45px; top: 30px;',
);
const MENU_CANVAS_AFTER_RESIZE = MENU_CANVAS_AFTER_SNAP_MOVE.replace(
  'width: 160px; height: 40px;',
  'width: 192px; height: 48px;',
);
const MENU_NUDGE_BASELINE = MENU_BASELINE
  .replace(
    'text="Main Menu" />',
    'text="Main Menu" style="position: absolute; left: 40px; top: 20px; width: 80px; height: 20px;" />',
  )
  .replace(
    'text="Play &amp; Go" tooltip=\'Press &quot;Enter&quot;\'',
    'text="Play &amp; Go" style="position: absolute; left: 160px; top: 60px; width: 160px; height: 40px;" tooltip=\'Press &quot;Enter&quot;\'',
  )
  .replace(
    "text='Quit &#x26; Save' />",
    "text='Quit &#x26; Save' style=\"position: absolute; left: 340px; top: 120px; width: 160px; height: 40px;\" />",
  );
const MENU_NUDGE_AFTER_NORMAL = MENU_NUDGE_BASELINE.replace(
  'left: 160px; top: 60px;',
  'left: 161px; top: 60px;',
);
const MENU_NUDGE_AFTER_ACCELERATED = MENU_NUDGE_AFTER_NORMAL.replace(
  'left: 161px; top: 60px;',
  'left: 161px; top: 70px;',
);
const MENU_NUDGE_AFTER_DISTRIBUTE = MENU_NUDGE_AFTER_ACCELERATED.replace(
  'left: 161px; top: 70px;',
  'left: 138.5px; top: 70px;',
);
const MENU_USS_AFTER_INSPECTOR_COLOR = MENU_USS_BASELINE.replace('#18794e', '#2563eb');
const MENU_USS_AFTER_INSPECTOR_NEW_RULE = `${MENU_USS_AFTER_INSPECTOR_COLOR}\r\n#play-button {\r\n  opacity: 0.8;\r\n}\r\n`;
const MENU_UXML_AFTER_INSPECTOR_INLINE = MENU_BASELINE.replace(
  "tooltip='Press &quot;Enter&quot;'",
  "tooltip='Press &quot;Enter&quot;' style='width: 240px;'",
);
const MENU_UXML_AFTER_INSPECTOR_BOX_ALIGNMENT = MENU_UXML_AFTER_INSPECTOR_INLINE.replace(
  "style='width: 240px;'",
  "style='width: 240px; margin-left: 12px; align-items: center;'",
);
const ASSETS_UXML_BASELINE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
  '  <Style src="Assets.uss" />',
  '  <ui:VisualElement name="asset-root" class="asset-root">',
  '    <ui:Image name="project-image" image="project://database/Assets/Textures/icon.png" />',
  '    <ui:Image name="relative-image" image="../Textures/icon.png" />',
  '    <ui:Image name="package-image" image="Packages/com.jethac.widgets/Textures/package-icon.png" />',
  '  </ui:VisualElement>',
  '</ui:UXML>',
  '',
].join('\n');
const ASSETS_USS_BASELINE = [
  '.asset-root {',
  '  background-image: url("project://database/Assets/Textures/icon.png");',
  '}',
  '',
  '.asset-root > #relative-image {',
  '  background-image: url("../Textures/icon.png");',
  '}',
  '',
  '.asset-root > #package-image {',
  '  background-image: url("Packages/com.jethac.widgets/Textures/package-icon.png");',
  '}',
  '',
].join('\n');
const ASSETS_UXML_AFTER_ATTRIBUTES = ASSETS_UXML_BASELINE.replace(
  'image="project://database/Assets/Textures/icon.png" />',
  'image="project://database/Assets/Textures/replacement.png" src="Assets/Textures/icon.png" text="Icon preview" focusable="true" picking-mode="Ignore" />',
);
const ASSETS_UXML_AFTER_CLASS_ADD = ASSETS_UXML_AFTER_ATTRIBUTES.replace(
  'picking-mode="Ignore" />',
  'picking-mode="Ignore" class="asset-preview one" />',
);
const ASSETS_UXML_AFTER_CLASS_RENAME = ASSETS_UXML_AFTER_CLASS_ADD.replace(
  'class="asset-preview one"',
  'class="asset-preview main"',
);
const ASSETS_UXML_AFTER_CLASS_REORDER = ASSETS_UXML_AFTER_CLASS_RENAME.replace(
  'class="asset-preview main"',
  'class="main asset-preview"',
);
const ASSETS_UXML_AFTER_CLASS_REMOVE = ASSETS_UXML_AFTER_CLASS_REORDER.replace(
  'class="main asset-preview"',
  'class="main"',
);
const ASSETS_UXML_AFTER_MULTI_CLASS = ASSETS_UXML_AFTER_CLASS_REMOVE
  .replace('class="main"', 'class="shared-icon"')
  .replace('image="../Textures/icon.png" />', 'image="../Textures/icon.png" class="shared-icon" />');
const NESTED_UXML_BASELINE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
  '  <Style src="base.uss" />',
  '  <ui:VisualElement name="nested-root" class="nested-shell">',
  '    <ui:Button name="nested-action" class="nested-action" text="Nested action" />',
  '  </ui:VisualElement>',
  '</ui:UXML>',
  '',
].join('\n');
const NESTED_BASE_USS_BASELINE = [
  '@import url("./components/buttons.uss");',
  '',
  '.nested-shell {',
  '  padding: 20px;',
  '  background-color: #e7eef6;',
  '}',
  '',
  '.nested-action {',
  '  color: #16324f;',
  '  padding-left: 12px;',
  '}',
  '',
].join('\n');
const NESTED_BASE_USS_AFTER_ADD = NESTED_BASE_USS_BASELINE.replace(
  '  background-color: #e7eef6;\n}',
  '  background-color: #e7eef6;\n  margin-left: 8px;\n}',
);
const NESTED_BASE_USS_AFTER_REMOVE = NESTED_BASE_USS_AFTER_ADD.replace('  padding: 20px;\n', '');
const NESTED_BASE_USS_AFTER_REORDER = NESTED_BASE_USS_AFTER_REMOVE.replace(
  '  background-color: #e7eef6;\n  margin-left: 8px;',
  '  margin-left: 8px;\n  background-color: #e7eef6;',
);
const NESTED_BUTTONS_USS_BASELINE = [
  '.nested-action {',
  '  width: 160px;',
  '  color: #fef3c7;',
  '  background-color: #245f9e;',
  '}',
  '',
].join('\n');
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

test('refuses a canvas resize for a selection without absolute authored layout', async ({ page }) => {
  await openMenu(page);
  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const play = hierarchy.getByRole('treeitem', { name: 'play-button' });
  await play.focus();
  await page.keyboard.press('Enter');
  await expectStructuralSelection(page, play, 'ui:Button');
  await expectVisibleSource(page, MENU_UXML, MENU_BASELINE);

  const resize = page.getByRole('button', { name: 'Resize selection' });
  await expect(resize).toBeVisible();
  const handle = await resize.boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 12, handle!.y + handle!.height / 2 + 8);
  await page.mouse.up();

  await expect(page.locator('.canvas-interaction-status')).toContainText('Free movement requires computed position to be exactly absolute.');
  await expectVisibleSource(page, MENU_UXML, MENU_BASELINE);
  expect(await project(page, MENU)).toEqual(await baseline(page, MENU));
});

test('authors one snapped pointer move and one pointer resize as individually undoable canvas transactions', async ({ page }) => {
  await openMenu(page);
  const before = await project(page, MENU);
  await showSource(page, MENU_UXML);
  await replaceVisibleText(
    page,
    MENU_UXML,
    'tooltip=\'Press &quot;Enter&quot;\'',
    'style="position: absolute; left: 40px; top: 30px; width: 160px; height: 40px;" tooltip=\'Press &quot;Enter&quot;\'',
  );
  await replaceVisibleText(
    page,
    MENU_UXML,
    "text='Quit &#x26; Save' />",
    "text='Quit &#x26; Save' style=\"position: absolute; left: 225px; top: 30px; width: 160px; height: 40px;\" />",
  );
  await expectVisibleSource(page, MENU_UXML, MENU_CANVAS_BASELINE);

  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const play = hierarchy.getByRole('treeitem', { name: 'play-button' });
  await play.focus();
  await page.keyboard.press('Enter');
  await expectStructuralSelection(page, play, 'ui:Button');
  const target = page.getByTestId('canvas-renderer').getByText('Play & Go', { exact: true });
  await expect(target).toBeVisible();
  const targetBox = await target.boundingBox();
  expect(targetBox).not.toBeNull();

  await page.mouse.move(targetBox!.x + 20, targetBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + 22, targetBox!.y + 20);
  await expect(page.locator('.canvas-snap-guide')).toHaveCount(2);
  await page.mouse.up();
  await expectVisibleSource(page, MENU_UXML, MENU_CANVAS_AFTER_SNAP_MOVE);
  await runPaletteCommand(page, 'Undo');
  await expectVisibleSource(page, MENU_UXML, MENU_CANVAS_BASELINE);
  await runPaletteCommand(page, 'Redo');
  await expectVisibleSource(page, MENU_UXML, MENU_CANVAS_AFTER_SNAP_MOVE);

  const resize = page.getByRole('button', { name: 'Resize selection' });
  await expect(resize).toBeVisible();
  const resizeBox = await resize.boundingBox();
  expect(resizeBox).not.toBeNull();
  await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox!.x + resizeBox!.width / 2 + 12, resizeBox!.y + resizeBox!.height / 2 + 8);
  await page.mouse.up();
  await expectVisibleSource(page, MENU_UXML, MENU_CANVAS_AFTER_RESIZE);
  await runPaletteCommand(page, 'Undo');
  await expectVisibleSource(page, MENU_UXML, MENU_CANVAS_AFTER_SNAP_MOVE);
  await runPaletteCommand(page, 'Redo');
  await expectVisibleSource(page, MENU_UXML, MENU_CANVAS_AFTER_RESIZE);
  await expectStructuralSelection(page, play, 'ui:Button');
  await page.getByRole('button', { name: 'Save' }).click();
  await settled(page);
  const saved = await project(page, MENU);
  expect(saved.files[MENU_UXML]?.text).toBe(MENU_CANVAS_AFTER_RESIZE);
  expect(saved.files[MENU_UXML]?.revision).not.toBe(before.files[MENU_UXML]?.revision);
  expect(saved.files[MENU_USS]?.text).toBe(MENU_USS_BASELINE);
  await runPaletteCommand(page, 'Close Project');
  await expectClosedProject(page);
  await runPaletteCommand(page, 'Reopen Project');
  await expectOpenProject(page, 'Menu Fixture');
  expect(await project(page, MENU)).toEqual(saved);
  await expectVisibleSource(page, MENU_UXML, MENU_CANVAS_AFTER_RESIZE);
});

test('nudges with normal and accelerated steps, then distributes a real three-element canvas selection', async ({ page }) => {
  await openMenu(page);
  await showSource(page, MENU_UXML);
  await replaceVisibleText(
    page,
    MENU_UXML,
    'text="Main Menu" />',
    'text="Main Menu" style="position: absolute; left: 40px; top: 20px; width: 80px; height: 20px;" />',
  );
  await replaceVisibleText(
    page,
    MENU_UXML,
    'tooltip=\'Press &quot;Enter&quot;\'',
    'style="position: absolute; left: 160px; top: 60px; width: 160px; height: 40px;" tooltip=\'Press &quot;Enter&quot;\'',
  );
  await replaceVisibleText(
    page,
    MENU_UXML,
    "text='Quit &#x26; Save' />",
    "text='Quit &#x26; Save' style=\"position: absolute; left: 340px; top: 120px; width: 160px; height: 40px;\" />",
  );
  await expectVisibleSource(page, MENU_UXML, MENU_NUDGE_BASELINE);

  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const title = hierarchy.getByRole('treeitem', { name: 'menu-title' });
  const play = hierarchy.getByRole('treeitem', { name: 'play-button' });
  const quit = hierarchy.getByRole('treeitem', { name: 'quit-button' });
  await play.focus();
  await page.keyboard.press('Enter');
  await expectStructuralSelection(page, play, 'ui:Button');
  const canvas = page.getByLabel('Canvas editing area');
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await expectVisibleSource(page, MENU_UXML, MENU_NUDGE_AFTER_NORMAL);
  await canvas.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expectVisibleSource(page, MENU_UXML, MENU_NUDGE_AFTER_ACCELERATED);
  await runPaletteCommand(page, 'Undo');
  await expectVisibleSource(page, MENU_UXML, MENU_NUDGE_AFTER_NORMAL);
  await runPaletteCommand(page, 'Redo');
  await expectVisibleSource(page, MENU_UXML, MENU_NUDGE_AFTER_ACCELERATED);

  await title.focus();
  await page.keyboard.press('Enter');
  await play.focus();
  await page.keyboard.press('Control+Enter');
  await quit.focus();
  await page.keyboard.press('Control+Enter');
  await expect(title).toHaveAttribute('aria-selected', 'true');
  await expect(play).toHaveAttribute('aria-selected', 'true');
  await expect(quit).toHaveAttribute('aria-selected', 'true');
  const distribute = page.getByRole('button', { name: 'Distribute horizontally' });
  await expect(distribute).toBeEnabled();
  await distribute.click();
  await expectVisibleSource(page, MENU_UXML, MENU_NUDGE_AFTER_DISTRIBUTE);
  await runPaletteCommand(page, 'Undo');
  await expectVisibleSource(page, MENU_UXML, MENU_NUDGE_AFTER_ACCELERATED);
  await runPaletteCommand(page, 'Redo');
  await expectVisibleSource(page, MENU_UXML, MENU_NUDGE_AFTER_DISTRIBUTE);
  await expect(page.getByLabel('Inspector selection context')).toContainText('3 elements');
});

test('changes canvas viewport and pseudo-state controls without mutating authored bytes', async ({ page }) => {
  await openMenu(page);
  const before = await project(page, MENU);
  const canvas = page.getByLabel('Canvas editing area');
  const transform = page.getByTestId('canvas-transform');

  await page.getByRole('button', { name: 'Pan tool' }).click();
  await expect(page.getByRole('button', { name: 'Pan tool' })).toHaveAttribute('aria-pressed', 'true');
  const field = await canvas.boundingBox();
  expect(field).not.toBeNull();
  await page.mouse.move(field!.x + 20, field!.y + 20);
  await page.mouse.down();
  await page.mouse.move(field!.x + 45, field!.y + 32);
  await page.mouse.up();
  await expect(transform).toHaveAttribute('style', /translate\(25px, 12px\) scale\(1\)/);

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByLabel('Canvas zoom')).toHaveText('110%');
  await expect(transform).toHaveAttribute('style', /scale\(1\.1\)/);
  await page.getByRole('button', { name: 'Fit canvas' }).click();
  await expect(page.getByLabel('Canvas zoom')).not.toHaveText('110%');
  await page.getByRole('button', { name: 'Actual size' }).click();
  await expect(page.getByLabel('Canvas zoom')).toHaveText('100%');

  const preset = page.getByRole('combobox', { name: 'Device preset' });
  await preset.selectOption('mobile');
  await expect(preset).toHaveValue('mobile');
  await expect(page.getByRole('spinbutton', { name: 'Canvas width' })).toHaveValue('390');
  await expect(page.getByRole('spinbutton', { name: 'Canvas height' })).toHaveValue('844');
  await page.getByRole('button', { name: 'Swap orientation' }).click();
  await expect(preset).toHaveValue('custom');
  await expect(page.getByRole('spinbutton', { name: 'Canvas width' })).toHaveValue('844');
  await expect(page.getByRole('spinbutton', { name: 'Canvas height' })).toHaveValue('390');
  const width = page.getByRole('spinbutton', { name: 'Canvas width' });
  const height = page.getByRole('spinbutton', { name: 'Canvas height' });
  await width.fill('512');
  await width.blur();
  await height.fill('320');
  await height.blur();
  await expect(preset).toHaveValue('custom');
  await expect(width).toHaveValue('512');
  await expect(height).toHaveValue('320');

  const safeArea = page.getByRole('checkbox', { name: 'Show safe area' });
  await safeArea.check();
  await expect(page.getByTestId('safe-area')).toBeVisible();
  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const play = hierarchy.getByRole('treeitem', { name: 'play-button' });
  await play.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Inspector selection context')).toContainText('Base state');
  const hover = page.getByRole('checkbox', { name: 'Hover' });
  await hover.check();
  await expect(hover).toBeChecked();
  await expect(page.getByLabel('Inspector selection context')).toContainText('Hover');
  expect(await project(page, MENU)).toEqual(before);
});

test('authors inspector values through existing-rule, inline, and new-rule destinations with exact source history', async ({ page }) => {
  await openMenu(page);
  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const play = hierarchy.getByRole('treeitem', { name: 'play-button' });
  await play.focus();
  await page.keyboard.press('Enter');
  await expectStructuralSelection(page, play, 'ui:Button');

  const background = page.getByRole('textbox', { name: 'Background color' });
  await expect(background).toHaveValue('#18794e');
  await expect(background).toHaveAccessibleDescription('Menu.uss · .menu-button.primary');
  await background.fill('#2563eb');
  await background.press('Enter');
  const colorMenu = page.getByRole('menu', { name: 'Write background-color to' });
  await expect(colorMenu).toBeVisible();
  await colorMenu.getByRole('menuitem', { name: 'Menu.uss · .menu-button.primary' }).click();
  await showSource(page, MENU_UXML);
  await page.getByRole('combobox', { name: 'Source file' }).selectOption(MENU_USS);
  await expectVisibleSource(page, MENU_USS, MENU_USS_AFTER_INSPECTOR_COLOR);

  const width = page.getByRole('textbox', { name: 'Width', exact: true });
  await width.fill('240px');
  await width.press('Enter');
  await page.getByRole('menu', { name: 'Write width to' }).getByRole('menuitem', { name: 'Inline style' }).click();
  await page.getByRole('combobox', { name: 'Source file' }).selectOption(MENU_UXML);
  await expectVisibleSource(page, MENU_UXML, MENU_UXML_AFTER_INSPECTOR_INLINE);
  await width.fill('12pt');
  await width.press('Enter');
  await expect(width).toHaveAttribute('aria-invalid', 'true');
  await expectVisibleSource(page, MENU_UXML, MENU_UXML_AFTER_INSPECTOR_INLINE);
  await runPaletteCommand(page, 'Undo');
  await expectVisibleSource(page, MENU_UXML, MENU_BASELINE);
  await runPaletteCommand(page, 'Redo');
  await expectVisibleSource(page, MENU_UXML, MENU_UXML_AFTER_INSPECTOR_INLINE);

  const marginLeft = page.getByRole('textbox', { name: 'Margin left' });
  await marginLeft.fill('12px');
  await marginLeft.press('Enter');
  await page.getByRole('menu', { name: 'Write margin-left to' }).getByRole('menuitem', { name: 'Inline style' }).click();
  const alignItems = page.getByRole('combobox', { name: 'Align items' });
  await alignItems.selectOption('center');
  await page.getByRole('menu', { name: 'Write align-items to' }).getByRole('menuitem', { name: 'Inline style' }).click();
  await expectVisibleSource(page, MENU_UXML, MENU_UXML_AFTER_INSPECTOR_BOX_ALIGNMENT);

  const opacity = page.getByRole('textbox', { name: 'Opacity' });
  await opacity.fill('0.8');
  await opacity.press('Enter');
  await page.getByRole('menu', { name: 'Write opacity to' }).getByRole('menuitem', { name: 'New rule: Menu.uss · #play-button' }).click();
  await page.getByRole('combobox', { name: 'Source file' }).selectOption(MENU_USS);
  await expectVisibleSource(page, MENU_USS, MENU_USS_AFTER_INSPECTOR_NEW_RULE);
  await runPaletteCommand(page, 'Undo');
  await expectVisibleSource(page, MENU_USS, MENU_USS_AFTER_INSPECTOR_COLOR);
  await runPaletteCommand(page, 'Redo');
  await expectVisibleSource(page, MENU_USS, MENU_USS_AFTER_INSPECTOR_NEW_RULE);
  await expectStructuralSelection(page, play, 'ui:Button');
});

test('authors typed inspector attributes and class tokens, then persists an explicit mixed multi-edit', async ({ page }) => {
  await openEditor(page);
  await selectProject(page, ASSETS);
  await page.getByRole('button', { name: 'Open Project' }).click();
  await settled(page);
  await expectOpenProject(page, 'Assets Fixture');
  const before = await project(page, ASSETS);
  const hierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const projectImage = hierarchy.getByRole('treeitem', { name: 'project-image' });
  await projectImage.focus();
  await page.keyboard.press('Enter');
  await expectStructuralSelection(page, projectImage, 'ui:Image');

  const assetSource = page.getByRole('textbox', { name: 'Asset source' });
  await assetSource.fill('../invalid.png');
  await assetSource.press('Enter');
  await expect(assetSource).toHaveAttribute('aria-invalid', 'true');
  await showSource(page, ASSETS_UXML);
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_BASELINE);
  await page.getByRole('button', { name: 'Available asset source values' }).click();
  await page.getByRole('combobox', { name: 'Asset source project asset' }).selectOption('Assets/Textures/icon.png');
  await page.getByRole('button', { name: 'Use asset source asset' }).click();

  const text = page.getByRole('textbox', { name: 'Text' });
  await text.fill('Icon preview');
  await text.press('Enter');
  await page.getByRole('checkbox', { name: 'Focusable' }).check();
  await page.getByRole('combobox', { name: 'Picking mode' }).selectOption('Ignore');
  const image = page.getByRole('textbox', { name: 'image value' });
  await image.fill('project://database/Assets/Textures/replacement.png');
  await image.press('Enter');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_ATTRIBUTES);

  const classes = page.getByRole('textbox', { name: 'Classes' });
  await classes.fill('asset-preview asset-preview');
  await classes.press('Enter');
  await expect(classes).toHaveAttribute('aria-invalid', 'true');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_ATTRIBUTES);
  await classes.fill('asset-preview one');
  await classes.press('Enter');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_CLASS_ADD);
  await classes.fill('asset-preview main');
  await classes.press('Enter');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_CLASS_RENAME);
  await classes.fill('main asset-preview');
  await classes.press('Enter');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_CLASS_REORDER);
  await classes.fill('main');
  await classes.press('Enter');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_CLASS_REMOVE);

  const relativeImage = hierarchy.getByRole('treeitem', { name: 'relative-image' });
  await relativeImage.focus();
  await page.keyboard.press('Control+Enter');
  await expect(page.getByLabel('Inspector selection context')).toContainText('2 elements');
  await expect(classes).toHaveAttribute('placeholder', 'Mixed');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_CLASS_REMOVE);
  await classes.fill('shared-icon');
  await classes.press('Enter');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_MULTI_CLASS);
  await runPaletteCommand(page, 'Undo');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_CLASS_REMOVE);
  await runPaletteCommand(page, 'Redo');
  await expectVisibleSource(page, ASSETS_UXML, ASSETS_UXML_AFTER_MULTI_CLASS);

  await page.getByRole('button', { name: 'Save' }).click();
  await settled(page);
  const saved = await project(page, ASSETS);
  expect(saved.files[ASSETS_UXML]?.text).toBe(ASSETS_UXML_AFTER_MULTI_CLASS);
  expect(saved.files[ASSETS_USS]?.text).toBe(ASSETS_USS_BASELINE);
  expect(saved.files[ASSETS_USS]).toEqual(before.files[ASSETS_USS]);
  await runPaletteCommand(page, 'Close Project');
  await expectClosedProject(page);
  await runPaletteCommand(page, 'Reopen Project');
  await expectOpenProject(page, 'Assets Fixture');
  expect(await project(page, ASSETS)).toEqual(saved);
  const reopenedHierarchy = page.getByRole('tree', { name: 'Document hierarchy' });
  const reopenedProjectImage = reopenedHierarchy.getByRole('treeitem', { name: 'project-image' });
  await reopenedProjectImage.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Asset source' })).toHaveValue('Assets/Textures/icon.png');
  await expect(page.getByRole('textbox', { name: 'Text' })).toHaveValue('Icon preview');
  await expect(page.getByRole('checkbox', { name: 'Focusable' })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Picking mode' })).toHaveValue('Ignore');
  await expect(page.getByRole('textbox', { name: 'image value' })).toHaveValue('project://database/Assets/Textures/replacement.png');
  await expect(page.getByRole('textbox', { name: 'Classes' })).toHaveValue('shared-icon');
});

test('adds, removes, and reorders USS declarations through the visible source editor without disturbing imports', async ({ page }) => {
  await openEditor(page);
  await selectProject(page, NESTED_STYLES);
  await page.getByRole('button', { name: 'Open Project' }).click();
  await settled(page);
  await expectOpenProject(page, 'Nested Styles Fixture');
  await showSource(page, NESTED_UXML);
  await expectVisibleSource(page, NESTED_UXML, NESTED_UXML_BASELINE);
  await page.getByRole('combobox', { name: 'Source file' }).selectOption(NESTED_BASE_USS);
  await sourceEditor(page, NESTED_BASE_USS).fill(NESTED_BASE_USS_AFTER_ADD);
  await drainSourceCallbacks(page);
  await expectVisibleSource(page, NESTED_BASE_USS, NESTED_BASE_USS_AFTER_ADD);
  await sourceEditor(page, NESTED_BASE_USS).fill(NESTED_BASE_USS_AFTER_REMOVE);
  await drainSourceCallbacks(page);
  await expectVisibleSource(page, NESTED_BASE_USS, NESTED_BASE_USS_AFTER_REMOVE);
  await sourceEditor(page, NESTED_BASE_USS).fill(NESTED_BASE_USS_AFTER_REORDER);
  await drainSourceCallbacks(page);
  await expectVisibleSource(page, NESTED_BASE_USS, NESTED_BASE_USS_AFTER_REORDER);
  await page.getByRole('combobox', { name: 'Source file' }).selectOption(NESTED_BUTTONS_USS);
  await expectVisibleSource(page, NESTED_BUTTONS_USS, NESTED_BUTTONS_USS_BASELINE);
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

type ProjectKey = 'menu' | 'options' | 'assets' | 'nested-styles' | 'unsupported' | 'blank' | 'collision';

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
  const style = hierarchy.getByRole('treeitem', { name: 'Style' });
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
  await expect(style).toHaveAttribute('aria-level', '2');
  await expect(menuRoot).toHaveAttribute('aria-level', '2');
  await expect(title).toHaveAttribute('aria-level', '3');
  await expect(scrollView).toHaveAttribute('aria-level', '3');
  await expect(wrapper).toHaveAttribute('aria-level', '4');
  await expect(quit).toHaveAttribute('aria-level', '5');
  await expect(play).toHaveAttribute('aria-level', '5');
  await expect(unnamedButton).toHaveAttribute('aria-level', '3');
  await expect(title).toHaveAttribute('aria-selected', 'true');
  await expect(play).toHaveAttribute('aria-selected', 'true');
  await expect(uxmlRoot).toHaveAttribute('aria-selected', 'false');
  await expect(style).toHaveAttribute('aria-selected', 'false');
  await expect(menuRoot).toHaveAttribute('aria-selected', 'false');
  await expect(scrollView).toHaveAttribute('aria-selected', 'false');
  await expect(wrapper).toHaveAttribute('aria-selected', 'false');
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
