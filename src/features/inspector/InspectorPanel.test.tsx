import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { describe, expect, it } from 'vitest';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import type { EditorElement } from '../../core/adapter/types';
import { DocumentSession } from '../../core/documents/DocumentSession';
import { EditorStore } from '../../core/store/EditorStore';
import { setAttribute } from '../../core/commands/uxmlCommands';
import { composeAttributeEdit } from './inspectorTransactions';
import { InspectorPanel } from './InspectorPanel';
import { PreviewCanvas } from '../canvas/PreviewCanvas';
import { Workbench } from '../workspace/Workbench';

const ENTRY_PATH = 'Assets/UI/screen.uxml';
const SHEET_PATH = 'Assets/UI/theme.uss';
const UXML = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="theme.uss" />
  <!-- unrelated marker -->
  <ui:Button name="primary" class="primary action" text="Save" focusable="true" custom-mode="legacy" />
  <ui:Button name="secondary" class="secondary" text="Cancel" focusable="false" />
</ui:UXML>
`;
const USS = `.primary { width: 180px; position: absolute; margin-left: 4px; padding-top: 6px; align-items: center; background-color: #123456; background-image: url("Assets/UI/icon.png"); opacity: 0.5; color: #010203; font-size: 16px; -unity-font-style: bold; }
.primary:hover { width: 200px; }
.secondary { width: 220px; }
`;

describe('InspectorPanel', () => {
  it('shows the computed value and winning source before editing', () => {
    renderInspector(['primary']);

    expect(screen.getByLabelText('Width')).toHaveValue('180px');
    expect(screen.getByLabelText('Width')).toHaveAccessibleDescription('theme.uss · .primary');
  });

  it('requires a target choice when rule and inline destinations are both valid', async () => {
    const user = userEvent.setup();
    renderInspector(['primary']);

    await user.clear(screen.getByLabelText('Width'));
    await user.type(screen.getByLabelText('Width'), '240px');

    expect(screen.queryByRole('menu', { name: 'Write width to' })).not.toBeInTheDocument();
    await pressEnter();
    expect(await screen.findByRole('menu', { name: 'Write width to' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Write width to' })).not.toBeInTheDocument();
  });

  it('rejects an unsupported numeric unit before mutating source', async () => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary']);
    const before = session.snapshot().files.get(SHEET_PATH)?.text;

    await user.clear(screen.getByLabelText('Width'));
    await user.type(screen.getByLabelText('Width'), '12pt');
    await user.tab();

    expect(screen.getByLabelText('Width')).toHaveAttribute('aria-invalid', 'true');
    expect(session.snapshot().files.get(SHEET_PATH)?.text).toBe(before);
    expect(session.history.undoDepth).toBe(0);
  });

  it('shows mixed values explicitly for a multi-selection', () => {
    renderInspector(['primary', 'secondary']);

    expect(screen.getByLabelText('Width')).toHaveValue('');
    expect(screen.getByLabelText('Width')).toHaveAccessibleDescription('Mixed');
  });

  it('commits a chosen inline target as one source-backed undo entry', async () => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary']);

    await user.clear(screen.getByLabelText('Width'));
    await user.type(screen.getByLabelText('Width'), '240px');
    await pressEnter();
    await user.click(await screen.findByRole('menuitem', { name: 'Inline style' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toContain('style="width: 240px;"');
    expect(session.snapshot().files.get(SHEET_PATH)?.text).toBe(USS);
    expect(session.history.undoDepth).toBe(1);
  });

  it('refuses a stale target chosen from an open write menu without another mutation', async () => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary']);

    await user.clear(screen.getByLabelText('Width'));
    await user.type(screen.getByLabelText('Width'), '240px');
    await pressEnter();
    const locator = session.locatorFor(nodeByName(session.document.root, 'secondary').id)!;
    session.history.execute(setAttribute(session, locator, 'tooltip', 'changed elsewhere'));
    const before = session.snapshot().files.get(SHEET_PATH)?.text;

    await user.click(await screen.findByRole('menuitem', { name: 'theme.uss · .primary' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(session.snapshot().files.get(SHEET_PATH)?.text).toBe(before);
    expect(session.history.undoDepth).toBe(1);
  });

  it('refuses an attribute draft after an unsynchronized session generation change', () => {
    const { session } = renderInspector(['primary']);
    const text = screen.getByLabelText('Text');
    fireEvent.change(text, { target: { value: 'Stale attribute draft' } });
    const secondary = session.locatorFor(nodeByName(session.document.root, 'secondary').id)!;
    session.history.execute(setAttribute(session, secondary, 'tooltip', 'external generation'));
    const afterExternal = session.snapshot().files.get(ENTRY_PATH)!.text;

    fireEvent.blur(text);

    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(afterExternal);
    expect(session.history.undoDepth).toBe(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses a class draft after an unsynchronized session generation change', async () => {
    const { session } = renderInspector(['primary']);
    const classes = screen.getByRole('textbox', { name: 'Classes' });
    fireEvent.change(classes, { target: { value: 'stale-class' } });
    classes.focus();
    const secondary = session.locatorFor(nodeByName(session.document.root, 'secondary').id)!;
    session.history.execute(setAttribute(session, secondary, 'tooltip', 'external generation'));
    const afterExternal = session.snapshot().files.get(ENTRY_PATH)!.text;

    await pressEnter();

    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(afterExternal);
    expect(session.history.undoDepth).toBe(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('suppresses a stale unavailable-target diagnostic after an unsynchronized generation change', async () => {
    const noStyleUxml = UXML.replace('  <Style src="theme.uss" />\n', '');
    const rendered = renderInspector(['primary'], new Map([[ENTRY_PATH, noStyleUxml]]));
    const primary = rendered.session.locatorFor(nodeByName(rendered.session.document.root, 'primary').id)!;
    act(() => rendered.store.dispatch({ type: 'active-states/toggle', locator: primary, state: 'hover' }));
    const width = screen.getByLabelText('Width');
    fireEvent.change(width, { target: { value: '12px' } });
    width.focus();
    const secondary = rendered.session.locatorFor(nodeByName(rendered.session.document.root, 'secondary').id)!;
    rendered.session.history.execute(setAttribute(rendered.session, secondary, 'tooltip', 'external generation'));
    const afterExternal = rendered.session.snapshot().files.get(ENTRY_PATH)!.text;

    await pressEnter();

    expect(rendered.session.snapshot().files.get(ENTRY_PATH)?.text).toBe(afterExternal);
    expect(rendered.session.history.undoDepth).toBe(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cancels a pending target choice when selection changes to an equal-valued element', async () => {
    const user = userEvent.setup();
    const equalUss = `.primary { width: 180px; }
.secondary { width: 180px; }
`;
    const { session, store } = renderInspector(['primary'], new Map([[ENTRY_PATH, UXML], [SHEET_PATH, equalUss]]));
    const beforeUxml = session.snapshot().files.get(ENTRY_PATH)!.text;
    const beforeUss = session.snapshot().files.get(SHEET_PATH)!.text;
    const width = screen.getByLabelText('Width');
    await user.clear(width);
    await user.type(width, '240px');
    await pressEnter();
    const staleChoice = await screen.findByRole('menuitem', { name: 'Inline style' });

    const secondary = nodeByName(session.document.root, 'secondary').id;
    act(() => store.dispatch({ type: 'selection/set', selection: [secondary] }));
    fireEvent.click(staleChoice);

    expect(screen.queryByRole('menu', { name: 'Write width to' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(beforeUxml);
    expect(session.snapshot().files.get(SHEET_PATH)?.text).toBe(beforeUss);
    expect(session.history.undoDepth).toBe(0);
  });

  it('cancels a pending target choice when active pseudo-state context changes', async () => {
    const user = userEvent.setup();
    const { session, store } = renderInspector(['primary']);
    const beforeUxml = session.snapshot().files.get(ENTRY_PATH)!.text;
    const beforeUss = session.snapshot().files.get(SHEET_PATH)!.text;
    const width = screen.getByLabelText('Width');
    await user.clear(width);
    await user.type(width, '240px');
    await pressEnter();
    const staleChoice = await screen.findByRole('menuitem', { name: 'Inline style' });
    const primary = session.locatorFor(nodeByName(session.document.root, 'primary').id)!;

    act(() => store.dispatch({ type: 'active-states/toggle', locator: primary, state: 'hover' }));
    fireEvent.click(staleChoice);

    expect(screen.queryByRole('menu', { name: 'Write width to' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(beforeUxml);
    expect(session.snapshot().files.get(SHEET_PATH)?.text).toBe(beforeUss);
    expect(session.history.undoDepth).toBe(0);
  });

  it('cancels a pending target choice when context changes to an identical replacement authority', async () => {
    const user = userEvent.setup();
    const { session, store } = renderInspector(['primary']);
    const width = screen.getByLabelText('Width');
    await user.clear(width);
    await user.type(width, '240px');
    await pressEnter();
    const staleChoice = await screen.findByRole('menuitem', { name: 'Inline style' });
    const replacement = DocumentSession.open(
      new Map([[ENTRY_PATH, UXML], [SHEET_PATH, USS]]),
      ENTRY_PATH,
      new UxmlPreviewAdapter(),
    );
    replacement.setSelection([replacement.locatorFor(nodeByName(replacement.document.root, 'primary').id)!]);

    act(() => store.dispatch({ type: 'context/set', session: replacement, host: null }));
    fireEvent.click(staleChoice);

    expect(screen.queryByRole('menu', { name: 'Write width to' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(UXML);
    expect(replacement.snapshot().files.get(ENTRY_PATH)?.text).toBe(UXML);
    expect(session.history.undoDepth).toBe(0);
    expect(replacement.history.undoDepth).toBe(0);
  });

  it('does not focus the same-id field after a stale selection callback', async () => {
    const user = userEvent.setup();
    const equalUss = `.primary { width: 180px; }
.secondary { width: 180px; }
`;
    const { session, store } = renderInspector(['primary'], new Map([[ENTRY_PATH, UXML], [SHEET_PATH, equalUss]]));
    const origin = screen.getByLabelText('Width');
    await user.clear(origin);
    await user.type(origin, '240px');
    await pressEnter();
    const staleChoice = await screen.findByRole('menuitem', { name: 'Inline style' });
    const secondary = nodeByName(session.document.root, 'secondary').id;

    act(() => {
      store.dispatch({ type: 'selection/set', selection: [secondary] });
      fireEvent.click(staleChoice);
    });
    await Promise.resolve();
    const replacementField = screen.getByLabelText('Width');
    expect(replacementField).toBe(origin);

    expect(replacementField).not.toHaveFocus();
    expect(session.history.undoDepth).toBe(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not focus the same-id field after a stale replacement-session callback', async () => {
    const user = userEvent.setup();
    const rendered = renderInspector(['primary']);
    const origin = screen.getByLabelText('Width');
    await user.clear(origin);
    await user.type(origin, '240px');
    await pressEnter();
    const staleChoice = await screen.findByRole('menuitem', { name: 'Inline style' });
    const replacement = DocumentSession.open(
      new Map([[ENTRY_PATH, UXML], [SHEET_PATH, USS]]),
      ENTRY_PATH,
      new UxmlPreviewAdapter(),
    );
    replacement.setSelection([replacement.locatorFor(nodeByName(replacement.document.root, 'primary').id)!]);

    act(() => {
      rendered.store.dispatch({ type: 'context/set', session: replacement, host: null });
      fireEvent.click(staleChoice);
    });
    await Promise.resolve();
    const replacementField = screen.getByLabelText('Width');
    expect(replacementField).toBe(origin);

    expect(replacementField).not.toHaveFocus();
    expect(rendered.session.history.undoDepth).toBe(0);
    expect(replacement.history.undoDepth).toBe(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('resets equal-valued text-like drafts when selection identity changes', () => {
    const equalUxml = UXML
      .replace('class="secondary" text="Cancel" focusable="false"', 'class="primary action" text="Save" focusable="false" custom-mode="legacy"');
    const equalUss = `.primary { width: 180px; }
`;
    const { session, store } = renderInspector(['primary'], new Map([[ENTRY_PATH, equalUxml], [SHEET_PATH, equalUss]]));
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '240p' } });
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Draft text' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Classes' }), { target: { value: 'draft-class' } });
    fireEvent.change(screen.getByLabelText('custom-mode value'), { target: { value: 'draft-mode' } });

    const secondary = nodeByName(session.document.root, 'secondary').id;
    act(() => store.dispatch({ type: 'selection/set', selection: [secondary] }));

    expect(screen.getByLabelText('Width')).toHaveValue('180px');
    expect(screen.getByLabelText('Text')).toHaveValue('Save');
    expect(screen.getByRole('textbox', { name: 'Classes' })).toHaveValue('primary action');
    expect(screen.getByLabelText('custom-mode value')).toHaveValue('legacy');
  });

  it('resets equal-valued drafts when pseudo-state, generation, or session identity changes', () => {
    const sameStateUss = USS.replace('.primary:hover { width: 200px; }', '.primary:hover { width: 180px; }');
    const rendered = renderInspector(['primary'], new Map([[ENTRY_PATH, UXML], [SHEET_PATH, sameStateUss]]));
    const primary = rendered.session.locatorFor(nodeByName(rendered.session.document.root, 'primary').id)!;
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '240p' } });
    act(() => rendered.store.dispatch({ type: 'active-states/toggle', locator: primary, state: 'hover' }));
    expect(screen.getByLabelText('Width')).toHaveValue('180px');

    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Generation draft' } });
    act(() => {
      rendered.session.history.execute(setAttribute(rendered.session, primary, 'tooltip', 'generation change'));
      rendered.store.dispatch({ type: 'session/sync' });
    });
    expect(screen.getByLabelText('Text')).toHaveValue('Save');

    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Session draft' } });
    const replacement = DocumentSession.open(
      new Map([[ENTRY_PATH, UXML], [SHEET_PATH, sameStateUss]]),
      ENTRY_PATH,
      new UxmlPreviewAdapter(),
    );
    replacement.setSelection([replacement.locatorFor(nodeByName(replacement.document.root, 'primary').id)!]);
    act(() => rendered.store.dispatch({ type: 'context/set', session: replacement, host: null }));
    expect(screen.getByLabelText('Text')).toHaveValue('Save');
  });

  it('shares locator-backed pseudo state with the canvas and clears it on session replacement', async () => {
    const { session, store } = renderInspector(['primary'], undefined, true);

    fireEvent.click(screen.getByLabelText('Hover'));

    expect(await screen.findByLabelText('Width')).toHaveValue('200px');
    expect(screen.getByText('theme.uss · .primary:hover')).toBeVisible();
    expect(store.getSnapshot().activeStates).toHaveLength(1);

    const primary = session.locatorFor(nodeByName(session.document.root, 'primary').id)!;
    act(() => {
      session.history.execute(setAttribute(session, primary, 'tooltip', 'ordinary commit'));
      store.dispatch({ type: 'session/sync' });
    });
    expect(store.getSnapshot().activeStates).toHaveLength(1);
    expect(screen.getByLabelText('Width')).toHaveValue('200px');

    const replacement = DocumentSession.open(
      new Map([[ENTRY_PATH, UXML], [SHEET_PATH, USS]]),
      ENTRY_PATH,
      new UxmlPreviewAdapter(),
    );
    store.dispatch({ type: 'context/set', session: replacement, host: null });

    expect(store.getSnapshot().activeStates).toHaveLength(0);
  });

  it('shares the strict same-name tag replacement policy with canvas state resolution', () => {
    const { session, store } = renderInspector(['primary'], undefined, true);
    fireEvent.click(screen.getByLabelText('Hover'));
    expect(screen.getByLabelText('Width')).toHaveValue('200px');
    const start = UXML.indexOf('ui:Button');

    act(() => {
      session.history.execute({
        id: 'replace-inspector-state-tag',
        label: 'Replace inspector state tag',
        patchesByFile: new Map([[ENTRY_PATH, [{ start, end: start + 'ui:Button'.length, replacement: 'ui:Label' }]]]),
      });
      store.dispatch({ type: 'session/sync' });
    });

    expect(store.getSnapshot().activeStates).toEqual([]);
    expect(screen.getByText('Base state')).toBeVisible();
    expect(screen.getByLabelText('Width')).toHaveValue('180px');
  });

  it('exposes typed controls for layout, appearance, typography, assets, attributes, classes, and text', () => {
    renderInspector(['primary']);

    expect(screen.getByLabelText('Position')).toHaveValue('absolute');
    expect(screen.getByLabelText('Margin left')).toHaveValue('4px');
    expect(screen.getByLabelText('Padding top')).toHaveValue('6px');
    expect(screen.getByLabelText('Align items')).toHaveValue('center');
    expect(screen.getByLabelText('Background color')).toHaveValue('#123456');
    expect(screen.getByLabelText('Background color swatch')).toHaveStyle({ backgroundColor: '#123456' });
    expect(screen.getByLabelText('Background image')).toHaveValue('url("Assets/UI/icon.png")');
    expect(screen.getByRole('button', { name: 'Available background image values' }).querySelector('svg')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Available asset source values' })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByLabelText('Opacity')).toHaveValue('0.5');
    expect(screen.getByLabelText('Font size')).toHaveValue('16px');
    expect(screen.getByLabelText('Font style')).toHaveValue('bold');
    expect(screen.getByLabelText('Focusable')).toBeChecked();
    expect(screen.getByLabelText('Text')).toHaveValue('Save');
    expect(screen.getByRole('textbox', { name: 'Classes' })).toHaveValue('primary action');
    expect(screen.getByRole('region', { name: 'Layout' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Appearance' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Typography' })).toBeVisible();
  });

  it('writes authored rules and new rules only after the explicit target choice', async () => {
    const user = userEvent.setup();
    const authored = renderInspector(['primary']);
    await user.clear(screen.getByLabelText('Width'));
    await user.type(screen.getByLabelText('Width'), '260px');
    await pressEnter();
    await user.click(await screen.findByRole('menuitem', { name: 'theme.uss · .primary' }));
    expect(authored.session.snapshot().files.get(SHEET_PATH)?.text).toContain('.primary { width: 260px;');
    expect(authored.session.history.undoDepth).toBe(1);
    authored.view.unmount();

    const added = renderInspector(['primary']);
    await user.type(screen.getByLabelText('Height'), '48px');
    await pressEnter();
    await user.click(await screen.findByRole('menuitem', { name: 'New rule: theme.uss · #primary' }));
    expect(added.session.snapshot().files.get(SHEET_PATH)?.text).toContain('#primary {\n  height: 48px;\n}');
    expect(added.session.history.undoDepth).toBe(1);
  });

  it('uses shortest unique path suffixes for same-basename authored destinations', async () => {
    const user = userEvent.setup();
    const uxml = UXML.replace(
      '  <Style src="theme.uss" />',
      '  <Style src="../A/theme.uss" />\n  <Style src="../B/theme.uss" />',
    );
    renderInspector(['primary'], new Map([
      [ENTRY_PATH, uxml],
      ['Assets/A/theme.uss', '.primary { width: 120px; }\n'],
      ['Assets/B/theme.uss', '.primary { width: 180px; }\n'],
    ]));
    const width = screen.getByLabelText('Width');
    await user.clear(width);
    await user.type(width, '250px');
    await pressEnter();

    const menu = await screen.findByRole('menu', { name: 'Write width to' });
    expect(within(menu).getByRole('menuitem', { name: 'A/theme.uss · .primary' })).toBeVisible();
    expect(within(menu).getByRole('menuitem', { name: 'B/theme.uss · .primary' })).toBeVisible();
  });

  it('describes every selector represented by a multi-selection new-rule choice', async () => {
    const user = userEvent.setup();
    renderInspector(['primary', 'secondary']);
    const height = screen.getByLabelText('Height');
    await user.type(height, '48px');
    await pressEnter();

    expect(await screen.findByRole('menuitem', { name: 'New rules: theme.uss · 2 selectors' })).toBeVisible();
  });

  it('disambiguates repeated authored selectors in the write-target menu', async () => {
    const user = userEvent.setup();
    const repeatedRules = `.primary { width: 120px; }
.primary { width: 180px; }
`;
    renderInspector(['primary'], new Map([[ENTRY_PATH, UXML], [SHEET_PATH, repeatedRules]]));

    await user.clear(screen.getByLabelText('Width'));
    await user.type(screen.getByLabelText('Width'), '250px');
    await pressEnter();

    const menu = await screen.findByRole('menu', { name: 'Write width to' });
    expect(within(menu).getByRole('menuitem', { name: 'theme.uss · .primary · line 1' })).toBeVisible();
    expect(within(menu).getByRole('menuitem', { name: 'theme.uss · .primary · line 2' })).toBeVisible();
  });

  it('commits directly when exactly one safe inline destination exists', async () => {
    const user = userEvent.setup();
    const duplicateNames = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:Button name="duplicate" />
  <ui:Button name="duplicate" />
</ui:UXML>
`;
    const { session } = renderInspector(['duplicate'], new Map([[ENTRY_PATH, duplicateNames]]));

    await user.type(screen.getByLabelText('Height'), '40px');
    await pressEnter();

    expect(screen.queryByRole('menu', { name: 'Write height to' })).not.toBeInTheDocument();
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toContain('style="height: 40px;"');
    expect(session.history.undoDepth).toBe(1);
  });

  it('describes inherited, default, and built-in origins without invented paths', () => {
    const inheritedUxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:VisualElement name="parent" style="color: #123456">
    <ui:Button name="child" />
  </ui:VisualElement>
</ui:UXML>
`;
    renderInspector(['child'], new Map([[ENTRY_PATH, inheritedUxml]]));

    expect(screen.getByLabelText('Color')).toHaveValue('#123456');
    expect(screen.getByLabelText('Color')).toHaveAccessibleDescription('Inherited · screen.uxml · inline on parent');
    expect(screen.getByLabelText('Height')).toHaveAccessibleDescription('Default');
    expect(screen.getByLabelText('Margin left')).toHaveValue('3px');
    expect(screen.getByLabelText('Margin left')).toHaveAccessibleDescription('Built-in · .unity-button');
  });

  it('applies one compatible multi-selection style edit as one undoable transaction', async () => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary', 'secondary']);
    const before = session.snapshot().files.get(ENTRY_PATH)?.text;

    await user.type(screen.getByLabelText('Width'), '300px');
    await pressEnter();
    await user.click(await screen.findByRole('menuitem', { name: 'Inline style' }));

    expect(session.snapshot().files.get(ENTRY_PATH)?.text.match(/style="width: 300px;"/g)).toHaveLength(2);
    expect(session.history.undoDepth).toBe(1);
    session.history.undo();
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before);
  });

  it('treats present and absent unknown attributes as mixed and edits every selected element atomically', () => {
    const { session } = renderInspector(['primary', 'secondary']);
    const before = session.snapshot().files.get(ENTRY_PATH)!.text;
    const value = screen.getByLabelText('custom-mode value');
    expect(value).toHaveValue('');
    expect(value).toHaveAttribute('placeholder', 'Mixed');

    fireEvent.change(value, { target: { value: 'modern' } });
    fireEvent.blur(value);

    const expected = before
      .replace('custom-mode="legacy"', 'custom-mode="modern"')
      .replace('text="Cancel" focusable="false"', 'text="Cancel" focusable="false" custom-mode="modern"');
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(expected);
    expect(session.history.undoDepth).toBe(1);
    session.history.undo();
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before);
  });

  it('removes a mixed unknown attribute only from selected elements that author it', async () => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary', 'secondary']);
    const before = session.snapshot().files.get(ENTRY_PATH)!.text;

    await user.click(screen.getByRole('button', { name: 'Remove custom-mode' }));

    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before.replace(' custom-mode="legacy"', ''));
    expect(session.history.undoDepth).toBe(1);
  });

  it.each([
    ['Width', 'width', '240px'],
    ['Opacity', 'opacity', '0.75'],
    ['Background color', 'background-color', '#abcdef'],
    ['Background image', 'background-image', 'url("Assets/UI/new.png")'],
    ['Overflow position', '-unity-text-overflow-position', 'end'],
  ])('commits %s only on Enter and creates one history entry', async (label, property, requested) => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary']);
    const input = screen.getByLabelText(label);
    await user.clear(input);
    await user.type(input, requested);

    expect(screen.queryByRole('menu', { name: `Write ${property} to` })).not.toBeInTheDocument();
    expect(session.history.undoDepth).toBe(0);
    await pressEnter();
    const menu = await screen.findByRole('menu', { name: `Write ${property} to` });
    await user.click(within(menu).getByRole('menuitem', { name: 'Inline style' }));

    expect(session.history.undoDepth).toBe(1);
    expect(input).toHaveFocus();
  });

  it('does not commit a valid short hex prefix while a longer color is being typed', async () => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary']);
    const color = screen.getByLabelText('Color');
    await user.clear(color);
    await user.type(color, '#123');
    expect(screen.queryByRole('menu', { name: 'Write color to' })).not.toBeInTheDocument();
    expect(session.history.undoDepth).toBe(0);
    await user.type(color, '456');
    expect(screen.queryByRole('menu', { name: 'Write color to' })).not.toBeInTheDocument();
    await pressEnter();
    expect(await screen.findByRole('menu', { name: 'Write color to' })).toBeVisible();
  });

  it('commits a complete text-like style draft on blur and focuses the target menu', async () => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary']);
    const width = screen.getByLabelText('Width');
    await user.clear(width);
    await user.type(width, '245px');
    expect(screen.queryByRole('menu', { name: 'Write width to' })).not.toBeInTheDocument();
    await user.tab();

    const menu = await screen.findByRole('menu', { name: 'Write width to' });
    expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus();
    expect(session.history.undoDepth).toBe(0);
  });

  it.each(['#1234567', 'rgb(256, 0, 0)', 'rgba(0, 0, 0, 1.1)'])(
    'rejects invalid color %s without mutation',
    async (requested) => {
      const user = userEvent.setup();
      const { session } = renderInspector(['primary']);
      const before = session.snapshot().files.get(SHEET_PATH)!.text;
      const color = screen.getByLabelText('Background color');
      await user.clear(color);
      await user.type(color, requested);
      await pressEnter();

      expect(color).toHaveAttribute('aria-invalid', 'true');
      expect(screen.queryByRole('menu', { name: 'Write background-color to' })).not.toBeInTheDocument();
      expect(session.snapshot().files.get(SHEET_PATH)?.text).toBe(before);
      expect(session.history.undoDepth).toBe(0);
    },
  );

  it('edits and removes unknown authored attributes without changing unrelated source', async () => {
    const user = userEvent.setup();
    const edited = renderInspector(['primary']);
    const before = edited.session.snapshot().files.get(ENTRY_PATH)!.text;
    const value = screen.getByLabelText('custom-mode value');
    await user.clear(value);
    await user.type(value, 'modern');
    await user.tab();

    expect(edited.session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before.replace('custom-mode="legacy"', 'custom-mode="modern"'));
    expect(edited.session.snapshot().files.get(SHEET_PATH)?.text).toBe(USS);
    expect(edited.session.history.undoDepth).toBe(1);
    edited.view.unmount();

    const removed = renderInspector(['primary']);
    await user.click(screen.getByRole('button', { name: 'Remove custom-mode' }));
    expect(removed.session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before.replace(' custom-mode="legacy"', ''));
    expect(removed.session.snapshot().files.get(ENTRY_PATH)?.text).toContain('<!-- unrelated marker -->');
    expect(removed.session.history.undoDepth).toBe(1);
  });

  it('writes explicit checkbox values and rejects unsafe asset paths before mutation', async () => {
    const user = userEvent.setup();
    const checkbox = renderInspector(['primary']);
    await user.click(screen.getByLabelText('Focusable'));
    expect(checkbox.session.snapshot().files.get(ENTRY_PATH)?.text).toContain('focusable="false"');
    expect(checkbox.session.history.undoDepth).toBe(1);
    checkbox.view.unmount();

    const asset = renderInspector(['primary']);
    const before = asset.session.snapshot().files.get(ENTRY_PATH)!.text;
    const source = screen.getByLabelText('Asset source');
    await user.type(source, '../outside.asset');
    await user.tab();
    expect(source).toHaveAttribute('aria-invalid', 'true');
    expect(asset.session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before);
    expect(asset.session.history.undoDepth).toBe(0);
  });

  it('chooses catalog assets for style values in explicit path and resource modes', async () => {
    const user = userEvent.setup();
    const assets = ['Assets/UI/Logo.png', 'Assets/Resources/Icons/Save.png'];
    const pathEdit = renderInspector(['primary'], undefined, false, assets);
    await user.click(screen.getByRole('button', { name: 'Available background image values' }));
    const pathPicker = await screen.findByRole('combobox', { name: 'Background image project asset' });
    expect(within(pathPicker).getByRole('option', { name: 'Assets/UI/Logo.png' })).toBeInTheDocument();
    expect(within(pathPicker).getByRole('option', { name: 'Assets/Resources/Icons/Save.png' })).toBeInTheDocument();
    await user.selectOptions(pathPicker, 'Assets/UI/Logo.png');
    await user.click(screen.getByRole('button', { name: 'Use background image asset' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Inline style' }));
    expect(pathEdit.session.snapshot().files.get(ENTRY_PATH)?.text).toContain('background-image: url(&quot;Assets/UI/Logo.png&quot;);');
    expect(pathEdit.session.history.undoDepth).toBe(1);
    pathEdit.view.unmount();

    const resourceEdit = renderInspector(['primary'], undefined, false, assets);
    await user.click(screen.getByRole('button', { name: 'Available background image values' }));
    await user.click(screen.getByRole('radio', { name: 'Resource' }));
    const resourcePicker = screen.getByRole('combobox', { name: 'Background image project asset' });
    expect(within(resourcePicker).queryByRole('option', { name: 'Assets/UI/Logo.png' })).not.toBeInTheDocument();
    await user.selectOptions(resourcePicker, 'Assets/Resources/Icons/Save.png');
    await user.click(screen.getByRole('button', { name: 'Use background image asset' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Inline style' }));
    expect(resourceEdit.session.snapshot().files.get(ENTRY_PATH)?.text).toContain('background-image: resource(&quot;Icons/Save&quot;);');
    expect(resourceEdit.session.history.undoDepth).toBe(1);
  });

  it('formats catalog choices as path or resource attribute src values', async () => {
    const user = userEvent.setup();
    const assets = ['Assets/UI/Logo.png', 'Assets/Resources/Icons/Save.png'];
    const pathEdit = renderInspector(['primary'], undefined, false, assets);
    await user.click(screen.getByRole('button', { name: 'Available asset source values' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Asset source project asset' }), 'Assets/UI/Logo.png');
    await user.click(screen.getByRole('button', { name: 'Use asset source asset' }));
    expect(pathEdit.session.snapshot().files.get(ENTRY_PATH)?.text).toContain('src="Assets/UI/Logo.png"');
    expect(pathEdit.session.history.undoDepth).toBe(1);
    pathEdit.view.unmount();

    const resourceEdit = renderInspector(['primary'], undefined, false, assets);
    await user.click(screen.getByRole('button', { name: 'Available asset source values' }));
    await user.click(screen.getByRole('radio', { name: 'Resource' }));
    await user.click(screen.getByRole('button', { name: 'Use asset source asset' }));
    expect(resourceEdit.session.snapshot().files.get(ENTRY_PATH)?.text).toContain('src="resource://Icons/Save"');
    expect(resourceEdit.session.history.undoDepth).toBe(1);
  });

  it('closes an open asset picker and refuses its stale callback when the catalog is cleared', async () => {
    const user = userEvent.setup();
    const assets = ['Assets/UI/Logo.png', 'Assets/Resources/Icons/Save.png'];
    const rendered = renderInspector(['primary'], undefined, false, assets);
    const before = rendered.session.snapshot().files.get(ENTRY_PATH)!.text;
    const source = screen.getByLabelText('Asset source');
    await user.click(screen.getByRole('button', { name: 'Available asset source values' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Asset source project asset' }), 'Assets/UI/Logo.png');
    const staleUse = screen.getByRole('button', { name: 'Use asset source asset' });

    act(() => {
      rendered.store.dispatch({ type: 'project-assets/set', paths: [] });
      fireEvent.click(staleUse);
    });
    expect(screen.queryByRole('dialog', { name: 'Choose asset source asset' })).not.toBeInTheDocument();
    fireEvent.blur(source);

    expect(rendered.session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before);
    expect(rendered.session.history.undoDepth).toBe(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closes a pending asset target and refuses stale commit, diagnostic, and focus after catalog replacement', async () => {
    const user = userEvent.setup();
    const assets = ['Assets/UI/Logo.png', 'Assets/Resources/Icons/Save.png'];
    const rendered = renderInspector(['primary'], undefined, false, assets);
    const beforeUxml = rendered.session.snapshot().files.get(ENTRY_PATH)!.text;
    const beforeUss = rendered.session.snapshot().files.get(SHEET_PATH)!.text;
    const origin = screen.getByLabelText('Background image');
    await user.click(screen.getByRole('button', { name: 'Available background image values' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Background image project asset' }), 'Assets/UI/Logo.png');
    await user.click(screen.getByRole('button', { name: 'Use background image asset' }));
    const staleChoice = await screen.findByRole('menuitem', { name: 'Inline style' });

    act(() => {
      rendered.store.dispatch({ type: 'project-assets/set', paths: ['Assets/UI/Replacement.png'] });
      fireEvent.click(staleChoice);
    });
    await Promise.resolve();
    expect(screen.queryByRole('menu', { name: 'Write background-image to' })).not.toBeInTheDocument();

    expect(origin).not.toHaveFocus();
    expect(screen.getByLabelText('Background image')).toHaveValue('url("Assets/UI/icon.png")');
    expect(rendered.session.snapshot().files.get(ENTRY_PATH)?.text).toBe(beforeUxml);
    expect(rendered.session.snapshot().files.get(SHEET_PATH)?.text).toBe(beforeUss);
    expect(rendered.session.history.undoDepth).toBe(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rejects malformed class tokens and missing namespaces before any mutation', async () => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary', 'secondary']);
    const before = session.snapshot().files.get(ENTRY_PATH)!.text;
    const classes = screen.getByRole('textbox', { name: 'Classes' });
    await user.clear(classes);
    await user.type(classes, 'valid bad/token');
    await user.tab();

    expect(classes).toHaveAttribute('aria-invalid', 'true');
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before);
    const locators = ['primary', 'secondary'].map((name) => session.locatorFor(nodeByName(session.document.root, name).id)!);
    expect(() => composeAttributeEdit(session, locators, 'missing:value', 'unsafe')).toThrow(/namespace|prefix/i);
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before);
    expect(session.history.undoDepth).toBe(0);
  });

  it('rejects a stale multi-attribute locator atomically', () => {
    const { session } = renderInspector(['primary', 'secondary']);
    const primary = session.locatorFor(nodeByName(session.document.root, 'primary').id)!;
    const secondary = session.locatorFor(nodeByName(session.document.root, 'secondary').id)!;
    const staleSecondary = {
      ...secondary,
      authoredName: 'removed-secondary',
      childPath: Object.freeze([99]),
      attributeHints: Object.freeze([]),
    };
    const before = session.snapshot().files.get(ENTRY_PATH)!.text;

    expect(() => composeAttributeEdit(session, [primary, staleSecondary], 'tooltip', 'atomic')).toThrow(/resolve|stale/i);
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(before);
    expect(session.history.undoDepth).toBe(0);
  });

  it('supports keyboard navigation and focus return in the accessible target menu', async () => {
    const user = userEvent.setup();
    renderInspector(['primary']);
    const width = screen.getByLabelText('Width');
    await user.clear(width);
    await user.type(width, '250px');
    await pressEnter();
    const menu = await screen.findByRole('menu', { name: 'Write width to' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(within(menu).getByRole('menuitem', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Write width to' })).not.toBeInTheDocument();
    expect(width).toHaveFocus();
  });

  it('offers pointer cancellation and restores field focus after cancel or successful choice', async () => {
    const user = userEvent.setup();
    const { session } = renderInspector(['primary']);
    const width = screen.getByLabelText('Width');
    await user.clear(width);
    await user.type(width, '250px');
    await pressEnter();
    const cancel = await screen.findByRole('menuitem', { name: 'Cancel' });
    await user.click(cancel);
    expect(screen.queryByRole('menu', { name: 'Write width to' })).not.toBeInTheDocument();
    expect(width).toHaveFocus();
    expect(session.history.undoDepth).toBe(0);

    await pressEnter();
    await user.click(await screen.findByRole('menuitem', { name: 'Inline style' }));
    expect(width).toHaveFocus();
    expect(session.history.undoDepth).toBe(1);
  });

  it('renders the inspector in the compact Workbench tool pane', () => {
    const { store } = createInspector(['primary'], undefined, { width: 720, height: 768 });
    store.dispatch({ type: 'panel/set', panel: 'inspector' });
    render(<Workbench store={store} />);

    expect(screen.getByTestId('right-pane')).toBeVisible();
    expect(screen.getByLabelText('Width')).toHaveValue('180px');
  });
});

function renderInspector(
  names: readonly string[],
  files?: ReadonlyMap<string, string>,
  withCanvas = false,
  projectAssets: readonly string[] = [],
) {
  const created = createInspector(names, files, undefined, projectAssets);
  const view = render(withCanvas ? <CanvasInspectorHarness store={created.store} /> : <InspectorHarness store={created.store} />);
  return { ...created, view };
}

function createInspector(
  names: readonly string[],
  files: ReadonlyMap<string, string> = new Map([[ENTRY_PATH, UXML], [SHEET_PATH, USS]]),
  viewport: Readonly<{ width: number; height: number }> | undefined = { width: 1366, height: 768 },
  projectAssets: readonly string[] = [],
) {
  const session = DocumentSession.open(
    files,
    ENTRY_PATH,
    new UxmlPreviewAdapter(),
  );
  const selection = names.map((name) => nodeByName(session.document.root, name).id);
  session.setSelection(selection.map((nodeId) => session.locatorFor(nodeId)!));
  const store = new EditorStore({ session, viewport, projectAssets });
  return { session, store };
}

function InspectorHarness({ store }: { readonly store: EditorStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <InspectorPanel store={store} snapshot={snapshot} />;
}

function CanvasInspectorHarness({ store }: { readonly store: EditorStore }) {
  return (
    <>
      <PreviewCanvas store={store} />
      <InspectorHarness store={store} />
    </>
  );
}

async function pressEnter() {
  if (!(document.activeElement instanceof HTMLElement)) throw new Error('Expected an active inspector control.');
  const activeElement = document.activeElement;
  await act(async () => {
    activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

function nodeByName(root: EditorElement, name: string): EditorElement {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name)) return current;
    pending.push(...current.children);
  }
  throw new Error(`Missing node ${name}.`);
}
