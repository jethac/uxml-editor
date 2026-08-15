import { describe, expect, it } from 'vitest';
import type { EditorElement } from '../adapter/types';
import { ClipboardService, UXML_FRAGMENT_MIME } from './ClipboardService';
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
