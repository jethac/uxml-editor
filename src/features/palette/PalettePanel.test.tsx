import { useSyncExternalStore } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { EditorElement } from '../../core/adapter/types';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../../core/documents/DocumentSession';
import { EditorStore } from '../../core/store/EditorStore';
import { PalettePanel } from './PalettePanel';

const PATH = 'Assets/UI/Main.uxml';
const EMPTY_SOURCE = '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:custom="urn:custom" />';

describe('PalettePanel search and creation', () => {
  it('filters adapter-supported controls case-insensitively', async () => {
    const user = userEvent.setup();
    const { store } = openEditor(EMPTY_SOURCE, new CatalogAdapter());
    render(<PaletteHarness store={store} />);

    expect(screen.getByRole('button', { name: 'Add Button' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add Dial' })).toBeVisible();
    await user.type(screen.getByRole('searchbox', { name: 'Search elements' }), 'ScRoLl');

    expect(screen.getByRole('button', { name: 'Add ScrollView' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add Button' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Dial' })).not.toBeInTheDocument();
  });

  it('creates a known control through one undoable transaction and selects it', async () => {
    const user = userEvent.setup();
    const { session, store } = openEditor(EMPTY_SOURCE);
    render(<PaletteHarness store={store} />);

    await user.click(screen.getByRole('button', { name: 'Add Button' }));

    expect(session.document.root.children.map((child) => child.name)).toEqual(['ui:Button']);
    expect(session.selection[0]?.qualifiedTag).toBe('ui:Button');
    expect(store.getSnapshot().selection).toEqual(session.selectedNodeIds);
    session.history.undo();
    expect(session.snapshot().files.get(PATH)?.text).toBe(EMPTY_SOURCE);
    expect(session.history.canUndo).toBe(false);
  });

  it('preserves a valid generic qualified name and namespace binding', async () => {
    const user = userEvent.setup();
    const { session, store } = openEditor(EMPTY_SOURCE);
    render(<PaletteHarness store={store} />);
    await user.type(screen.getByRole('textbox', { name: 'Generic qualified name' }), 'custom:Widget');

    await user.click(screen.getByRole('button', { name: 'Add generic element' }));

    expect(session.document.root.children[0]?.name).toBe('custom:Widget');
    expect(session.snapshot().files.get(PATH)?.text).toContain('<custom:Widget />');
    expect(session.selection[0]?.qualifiedTag).toBe('custom:Widget');
  });

  it.each(['bad name', 'missing:Widget'])(
    'reports invalid generic name or binding %s without mutating source',
    async (qualifiedName) => {
      const user = userEvent.setup();
      const { session, store } = openEditor(EMPTY_SOURCE);
      render(<PaletteHarness store={store} />);
      await user.type(screen.getByRole('textbox', { name: 'Generic qualified name' }), qualifiedName);

      await user.click(screen.getByRole('button', { name: 'Add generic element' }));

      expect(screen.getByRole('alert')).toHaveTextContent('invalid element name or namespace binding');
      expect(session.snapshot().files.get(PATH)?.text).toBe(EMPTY_SOURCE);
      expect(session.history.canUndo).toBe(false);
    },
  );

  it('inserts after a selected leaf instead of nesting inside it', () => {
    const source = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="Main">',
      '    <ui:Button name="Play" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n');
    const { session, store } = openEditor(source);
    selectByName(session, store, 'Play');
    render(<PaletteHarness store={store} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Label' }));

    const main = findByName(session.document.root, 'Main')!;
    expect(main.children.map((child) => child.name)).toEqual(['ui:Button', 'ui:Label']);
    expect(main.children[0].children).toHaveLength(0);
  });
});

function PaletteHarness({ store }: { readonly store: EditorStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <PalettePanel store={store} snapshot={snapshot} />;
}

function openEditor(
  source: string,
  adapter: UxmlPreviewAdapter = new UxmlPreviewAdapter(),
): { readonly session: DocumentSession; readonly store: EditorStore } {
  const session = DocumentSession.open(new Map([[PATH, source]]), PATH, adapter);
  return { session, store: new EditorStore({ session }) };
}

function selectByName(session: DocumentSession, store: EditorStore, name: string): void {
  const element = findByName(session.document.root, name)!;
  session.setSelection([session.locatorFor(element.id)!]);
  store.dispatch({ type: 'session/sync' });
}

function findByName(root: EditorElement, name: string): EditorElement | null {
  if (root.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name)) return root;
  for (const child of root.children) {
    const found = findByName(child, name);
    if (found !== null) return found;
  }
  return null;
}

class CatalogAdapter extends UxmlPreviewAdapter {
  override supportedControlNames(): readonly string[] {
    return Object.freeze(['Button', 'ScrollView', 'Dial']);
  }
}
