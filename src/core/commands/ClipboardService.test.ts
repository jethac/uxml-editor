import { describe, expect, it } from 'vitest';
import type { EditorElement } from '../adapter/types';
import { ClipboardService, UXML_FRAGMENT_MIME } from './ClipboardService';
import { resolveElementLocator } from '../documents/ElementLocator';
import { entryPath, locatorWithName, openSession } from './uxmlCommands.testUtils';

describe('ClipboardService', () => {
  it('copies exact source fragments with versioned MIME, plain UXML, namespaces, and styles', async () => {
    const exact = '<ui:VisualElement name="item"><ui:Label text="A &amp; B" /></ui:VisualElement>';
    const session = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:x="Example.Controls">',
      `  ${exact}`,
      '</ui:UXML>',
    ].join('\n'));
    const item = elementNamed(session.document.root, 'item');
    const service = new ClipboardService();

    const result = service.copy(session, [item]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.types).toEqual([UXML_FRAGMENT_MIME, 'text/plain']);
    expect(await (await result.item.getType('text/plain')).text()).toBe(exact);
    const payload = JSON.parse(await (await result.item.getType(UXML_FRAGMENT_MIME)).text());
    expect(payload).toEqual(expect.objectContaining({
      version: 1,
      sourcePath: entryPath,
      fragments: [expect.objectContaining({ source: exact })],
      stylesheets: [],
    }));
    expect(payload.fragments[0].namespaces).toEqual(expect.arrayContaining([
      { name: 'xmlns:ui', value: 'UnityEngine.UIElements' },
      { name: 'xmlns:x', value: 'Example.Controls' },
    ]));
  });

  it('pastes structurally, renames colliding authored names deterministically, and undoes once', async () => {
    const session = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:Label name="item" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n'));
    const item = elementNamed(session.document.root, 'item');
    const parent = locatorWithName(session, 'parent');
    const service = new ClipboardService();
    const copied = service.copy(session, [item]);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;

    const paste = await service.paste(session, parent, 1, copied.item);

    expect(paste.ok, JSON.stringify(paste)).toBe(true);
    if (!paste.ok) return;
    session.history.execute(paste.transaction);
    const changed = session.snapshot().files.get(entryPath)?.text ?? '';
    expect(changed).toContain('<ui:Label name="item-copy" />');
    expect(changed.match(/<ui:Label/g)).toHaveLength(2);
    expect(session.history.undoDepth).toBe(1);
    session.history.undo();
    expect(session.snapshot().files.get(entryPath)?.text).not.toContain('item-copy');
  });

  it('selects the generated pasted root and restores the previous selection through undo and redo', async () => {
    const session = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:Label name="item" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n'));
    const item = elementNamed(session.document.root, 'item');
    const parent = locatorWithName(session, 'parent');
    const service = new ClipboardService();
    const copied = service.copy(session, [item]);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    session.setSelection([parent]);

    const paste = await service.paste(session, parent, 1, copied.item);

    expect(paste.ok, JSON.stringify(paste)).toBe(true);
    if (!paste.ok) return;
    session.history.execute(paste.transaction);
    expect(session.selection.map((locator) => locator.authoredName)).toEqual(['item-copy']);
    session.history.undo();
    expect(session.selection).toEqual([parent]);
    session.history.redo();
    expect(session.selection.map((locator) => locator.authoredName)).toEqual(['item-copy']);
  });

  it('canonicalizes a stale named parent before selecting an unnamed pasted root', async () => {
    const source = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:Label name="before" />',
      '    <ui:Label />',
      '    <ui:Label name="after" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n');
    const session = openSession(source);
    const parent = locatorWithName(session, 'parent');
    const copied = new ClipboardService().copy(session, [session.document.root.children[0].children[1]]);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    session.setSelection([parent]);
    const staleParent = {
      ...parent,
      childPath: [99],
      ancestorTags: ['not-the-current-parent'],
    };

    const pasted = await new ClipboardService().paste(session, staleParent, 2, copied.item);

    expect(pasted.ok, JSON.stringify(pasted)).toBe(true);
    if (!pasted.ok) return;
    session.history.execute(pasted.transaction);
    const expectedPastedRoot = session.document.root.children[0].children[2];
    expect(resolveElementLocator(session.document.root, session.selection[0])).toBe(expectedPastedRoot.id);
    expect(session.selectedNodeIds).toEqual([expectedPastedRoot.id]);
    session.history.undo();
    expect(session.selection).toEqual([parent]);
    session.history.redo();
    expect(resolveElementLocator(session.document.root, session.selection[0])).toBe(session.document.root.children[0].children[2].id);

    const replayed = openSession(source);
    replayed.history.replay([pasted.transaction]);
    const replayedPastedRoot = replayed.document.root.children[0].children[2];
    expect(resolveElementLocator(replayed.document.root, replayed.selection[0])).toBe(replayedPastedRoot.id);
    expect(replayed.selectedNodeIds).toEqual([replayedPastedRoot.id]);
  });

  it('keeps multi-root nonterminal paste selection stable through nested renames, undo, redo, and replay', async () => {
    const source = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:VisualElement name="item"><ui:Label name="caption" /></ui:VisualElement>',
      '    <ui:Label name="item-copy" />',
      '    <ui:Label name="caption-copy" />',
      '    <ui:Label name="after" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n');
    const session = openSession(source);
    const parent = locatorWithName(session, 'parent');
    const copied = new ClipboardService().copy(session, [
      elementNamed(session.document.root, 'item'),
      elementNamed(session.document.root, 'item-copy'),
    ]);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    session.setSelection([parent]);
    const staleParent = { ...parent, childPath: [42], ancestorTags: ['stale'] };

    const pasted = await new ClipboardService().paste(session, staleParent, 1, copied.item);

    expect(pasted.ok, JSON.stringify(pasted)).toBe(true);
    if (!pasted.ok) return;
    session.history.execute(pasted.transaction);
    const expected = session.snapshot().files.get(entryPath)?.text;
    expect(expected).toContain('<ui:VisualElement name="item-copy-2"><ui:Label name="caption-copy-2" /></ui:VisualElement>');
    expect(expected).toContain('<ui:Label name="item-copy-copy" />');
    expect(session.selection.map((locator) => locator.authoredName)).toEqual(['item-copy-2', 'item-copy-copy']);
    expect(session.selectedNodeIds).toHaveLength(2);
    session.history.undo();
    expect(session.snapshot().files.get(entryPath)?.text).toBe(source);
    expect(session.selection).toEqual([parent]);
    session.history.redo();
    expect(session.snapshot().files.get(entryPath)?.text).toBe(expected);
    expect(session.selection.map((locator) => locator.authoredName)).toEqual(['item-copy-2', 'item-copy-copy']);

    const replayed = openSession(source);
    replayed.history.replay([pasted.transaction]);
    expect(replayed.snapshot().files.get(entryPath)?.text).toBe(expected);
    expect(replayed.selection.map((locator) => locator.authoredName)).toEqual(['item-copy-2', 'item-copy-copy']);
    expect(replayed.selectedNodeIds).toHaveLength(2);
  });

  it('returns a stable diagnostic for malformed structured clipboard data', async () => {
    const session = openSession('<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement name="parent" /></ui:UXML>');
    const service = new ClipboardService();
    const malformed = {
      types: [UXML_FRAGMENT_MIME],
      getType: async () => new Blob(['{"version":99}'], { type: UXML_FRAGMENT_MIME }),
    };

    const result = await service.paste(session, locatorWithName(session, 'parent'), 0, malformed);

    expect(result).toEqual({
      ok: false,
      diagnostic: expect.objectContaining({ code: 'INVALID_CLIPBOARD_FRAGMENT' }),
    });
  });

  it('pastes multiple exact fragments with deterministic nested-name suffixes in one transaction', async () => {
    const session = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:VisualElement name="item"><ui:Label name="caption" /></ui:VisualElement>',
      '    <ui:Label name="item-copy" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n'));
    const service = new ClipboardService();
    const first = elementNamed(session.document.root, 'item');
    const second = elementNamed(session.document.root, 'item-copy');
    const copied = service.copy(session, [first, second]);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;

    const paste = await service.paste(session, locatorWithName(session, 'parent'), 2, copied.item);

    expect(paste.ok).toBe(true);
    if (!paste.ok) return;
    session.history.execute(paste.transaction);
    const changed = session.snapshot().files.get(entryPath)?.text ?? '';
    expect(changed).toContain('name="item-copy-2"');
    expect(changed).toContain('name="caption-copy"');
    expect(changed).toContain('name="item-copy-copy"');
    expect(session.history.undoDepth).toBe(1);
  });

  it('materializes a missing inherited namespace binding when pasting across documents', async () => {
    const source = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:custom="Example.Controls">',
      '  <custom:Widget name="custom-item" />',
      '</ui:UXML>',
    ].join('\n'));
    const copied = new ClipboardService().copy(source, [elementNamed(source.document.root, 'custom-item')]);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    const destinationSource = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <!-- preserve exactly -->',
      '  <ui:VisualElement name="parent" />',
      '</ui:UXML>',
    ].join('\n');
    const destination = openSession(destinationSource);

    const result = await new ClipboardService().paste(
      destination,
      locatorWithName(destination, 'parent'),
      0,
      copied.item,
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    destination.history.execute(result.transaction);
    const changed = destination.snapshot().files.get(entryPath)?.text ?? '';
    expect(changed).toMatch(/<custom:Widget\b(?=[^>]*\bname="custom-item")(?=[^>]*\bxmlns:custom="Example\.Controls")[^>]*\/>/);
    expect(changed).toContain('  <!-- preserve exactly -->');
    expect(destination.history.undoDepth).toBe(1);
    destination.history.undo();
    expect(destination.snapshot().files.get(entryPath)?.text).toBe(destinationSource);
  });

  it('refuses an incompatible destination namespace binding without inserting a misbound QName', async () => {
    const source = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:custom="Example.Controls">',
      '  <custom:Widget name="custom-item" />',
      '</ui:UXML>',
    ].join('\n'));
    const copied = new ClipboardService().copy(source, [elementNamed(source.document.root, 'custom-item')]);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    const destinationSource = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:custom="Other.Controls">',
      '  <ui:VisualElement name="parent" />',
      '</ui:UXML>',
    ].join('\n');
    const destination = openSession(destinationSource);
    const before = {
      snapshot: destination.snapshot(),
      source: destination.snapshot().files.get(entryPath)?.text,
      selection: destination.selection,
      selectedNodeIds: destination.selectedNodeIds,
      diagnostics: destination.diagnostics,
      undoDepth: destination.history.undoDepth,
      canUndo: destination.history.canUndo,
      canRedo: destination.history.canRedo,
      replayLog: destination.history.replayLog,
    };

    const result = await new ClipboardService().paste(
      destination,
      locatorWithName(destination, 'parent'),
      0,
      copied.item,
    );

    expect(result).toEqual({
      ok: false,
      diagnostic: {
        code: 'INVALID_CLIPBOARD_FRAGMENT',
        message: 'Namespace binding conflict for xmlns:custom.',
      },
    });
    expect({
      snapshot: destination.snapshot(),
      source: destination.snapshot().files.get(entryPath)?.text,
      selection: destination.selection,
      selectedNodeIds: destination.selectedNodeIds,
      diagnostics: destination.diagnostics,
      undoDepth: destination.history.undoDepth,
      canUndo: destination.history.canUndo,
      canRedo: destination.history.canRedo,
      replayLog: destination.history.replayLog,
    }).toEqual({
      ...before,
      source: destinationSource,
    });
  });
});

function elementNamed(root: EditorElement, name: string): EditorElement {
  const match = walk(root).find((element) =>
    element.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name),
  );
  if (match === undefined) throw new Error(`Missing fixture element ${name}.`);
  return match;
}

function walk(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walk)];
}
