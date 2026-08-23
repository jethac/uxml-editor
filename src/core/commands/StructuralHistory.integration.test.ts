import { describe, expect, it } from 'vitest';
import type { EditorElement } from '../adapter/types';
import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../documents/DocumentSession';
import { ClipboardService } from './ClipboardService';
import type { EditorTransaction } from './EditorTransaction';
import { insertElement, setAttribute } from './uxmlCommands';

const entryPath = 'Assets/UI/Menu.uxml';
const source = [
  '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
  '  <ui:VisualElement name="menu-root">',
  '    <ui:Button name="play-button" text="Play" />',
  '  </ui:VisualElement>',
  '</ui:UXML>',
].join('\r\n');

describe('structural history production integration', () => {
  it('deterministically replays palette, source, and clipboard transactions into an equivalent session', async () => {
    const authored = openSession();
    const transactions: EditorTransaction[] = [];
    const parent = locatorByName(authored, 'menu-root');
    const inserted = insertElement(authored, parent, 1, '<ui:Label name="status" text="Ready" />');
    authored.history.execute(inserted);
    transactions.push(inserted);

    const sourceEdit = setAttribute(authored, locatorByName(authored, 'play-button'), 'text', 'Start');
    authored.history.execute(sourceEdit);
    transactions.push(sourceEdit);

    const play = elementByName(authored.document.root, 'play-button');
    const copied = new ClipboardService().copy(authored, [play]);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    const paste = await new ClipboardService().paste(authored, locatorByName(authored, 'menu-root'), 2, copied.item);
    expect(paste.ok, JSON.stringify(paste)).toBe(true);
    if (!paste.ok) return;
    authored.history.execute(paste.transaction);
    transactions.push(paste.transaction);

    const replayed = openSession();
    replayed.history.replay(transactions);

    expect(replayed.snapshot()).toEqual(authored.snapshot());
    expect(replayed.selection.map((locator) => locator.authoredName)).toEqual(['play-button-copy']);
    expect(replayed.snapshot().files.get(entryPath)?.text).toContain('text="Start"');
  });
});

function openSession(): DocumentSession {
  return DocumentSession.open(new Map([[entryPath, source]]), entryPath, new UxmlPreviewAdapter());
}

function locatorByName(session: DocumentSession, name: string) {
  const element = elementByName(session.document.root, name);
  const locator = session.locatorFor(element.id);
  if (locator === null) throw new Error(`Missing locator for ${name}.`);
  return locator;
}

function elementByName(root: EditorElement, name: string): EditorElement {
  const found = [root, ...root.children.flatMap(walk)].find((element) =>
    element.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name),
  );
  if (found === undefined) throw new Error(`Missing ${name}.`);
  return found;
}

function walk(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walk)];
}
