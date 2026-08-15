import { useSyncExternalStore } from 'react';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { EditorElement } from '../../core/adapter/types';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../../core/documents/DocumentSession';
import { EditorStore } from '../../core/store/EditorStore';
import { Workbench } from '../workspace/Workbench';
import { HierarchyPanel } from './HierarchyPanel';

const PATH = 'Assets/UI/Main.uxml';
const SOURCE = [
  '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:custom="urn:custom">',
  '  <ui:VisualElement name="Main">',
  '    <ui:Button name="Play" />',
  '    <ui:Button name="Quit" />',
  '    <ui:Button name="Settings" />',
  '    <custom:Widget name="Mystery">',
  '      <custom:Part />',
  '    </custom:Widget>',
  '  </ui:VisualElement>',
  '  <ui:VisualElement name="Footer" />',
  '</ui:UXML>',
].join('\n');

describe('HierarchyPanel tree and selection', () => {
  it('renders the complete authored tree including unsupported tags', () => {
    const { store, session } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);

    expect(screen.getByRole('tree', { name: 'Document hierarchy' })).toBeVisible();
    expect(screen.getByRole('treeitem', { name: 'Mystery' })).toBeVisible();
    expect(screen.getByRole('treeitem', { name: 'custom:Part' })).toBeVisible();
    expect(session.snapshot().files.get(PATH)?.text).toBe(SOURCE);
  });

  it('uses roving tabindex with keyboard expand, collapse, and traversal', () => {
    const { store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    const root = screen.getByRole('treeitem', { name: 'ui:UXML' });

    expect(root).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('treeitem', { name: 'Main' })).toHaveAttribute('tabindex', '-1');
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(root).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: 'Main' })).not.toBeInTheDocument();

    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(root).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(screen.getByRole('treeitem', { name: 'Main' })).toHaveFocus();
    expect(screen.getByRole('treeitem', { name: 'Main' })).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Main' }), { key: 'ArrowDown' });
    expect(screen.getByRole('treeitem', { name: 'Play' })).toHaveFocus();
  });

  it('keeps a visible roving tab stop when an active descendant is collapsed', () => {
    const { store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    const main = screen.getByRole('treeitem', { name: 'Main' });
    const play = screen.getByRole('treeitem', { name: 'Play' });
    fireEvent.click(play);
    expect(play).toHaveAttribute('tabindex', '0');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Main' }));

    expect(screen.queryByRole('treeitem', { name: 'Play' })).not.toBeInTheDocument();
    expect(main).toHaveAttribute('tabindex', '0');
  });

  it('writes single and multi-selection as locators and synchronizes the store', () => {
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);

    fireEvent.click(screen.getByRole('treeitem', { name: 'Play' }));
    fireEvent.click(screen.getByRole('treeitem', { name: 'Quit' }), { ctrlKey: true });

    expect(session.selection.map((locator) => locator.authoredName)).toEqual(['Play', 'Quit']);
    expect(store.getSnapshot().selection).toEqual(session.selectedNodeIds);
    expect(screen.getByRole('treeitem', { name: 'Play' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('treeitem', { name: 'Quit' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('treeitem', { name: 'Settings' })).toHaveAttribute('aria-selected', 'false');
  });
});

describe('HierarchyPanel structural editing', () => {
  it('reparents an element through one undoable hierarchy drop and exposes its insertion state', () => {
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);

    const play = screen.getByRole('treeitem', { name: 'Play' });
    const footer = screen.getByRole('treeitem', { name: 'Footer' });
    fireEvent.dragStart(play);
    fireEvent.dragOver(footer);
    expect(footer).toHaveAttribute('data-drop-position', 'inside');
    fireEvent.drop(footer);

    expect(parentOf(session.document.root, 'Play')?.attributes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'name', value: 'Footer' })]),
    );
    expect(session.history.canUndo).toBe(true);

    session.history.undo();

    expect(session.snapshot().files.get(PATH)?.text).toBe(SOURCE);
    expect(parentOf(session.document.root, 'Play')?.attributes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'name', value: 'Main' })]),
    );
    expect(session.history.canUndo).toBe(false);
  });

  it('reorders an element through one undoable before drop with a visible insertion state', () => {
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    const settings = screen.getByRole('treeitem', { name: 'Settings' });
    const play = screen.getByRole('treeitem', { name: 'Play' });
    vi.spyOn(play, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 100,
      top: 100,
      right: 200,
      bottom: 130,
      left: 0,
      width: 200,
      height: 30,
      toJSON: () => ({}),
    });

    fireEvent.dragStart(settings);
    const dragOver = createEvent.dragOver(play);
    Object.defineProperty(dragOver, 'clientY', { value: 101 });
    fireEvent(play, dragOver);
    expect(play).toHaveAttribute('data-drop-position', 'before');
    fireEvent.drop(play);

    expect(childNames(findByAuthoredName(session.document.root, 'Main')!)).toEqual([
      'Settings', 'Play', 'Quit', 'Mystery',
    ]);
    session.history.undo();
    expect(session.snapshot().files.get(PATH)?.text).toBe(SOURCE);
    expect(session.history.canUndo).toBe(false);
  });

  it('moves contiguous selected siblings once with Alt+ArrowDown and preserves selection through undo', () => {
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    const play = screen.getByRole('treeitem', { name: 'Play' });
    fireEvent.click(play);
    fireEvent.click(screen.getByRole('treeitem', { name: 'Quit' }), { ctrlKey: true });

    fireEvent.keyDown(play, { key: 'ArrowDown', altKey: true });

    expect(childNames(findByAuthoredName(session.document.root, 'Main')!)).toEqual([
      'Settings', 'Play', 'Quit', 'Mystery',
    ]);
    expect(session.selection.map((locator) => locator.authoredName)).toEqual(['Play', 'Quit']);
    session.history.undo();
    expect(session.snapshot().files.get(PATH)?.text).toBe(SOURCE);
    expect(session.selectedNodeIds).toHaveLength(2);
    expect(session.history.canUndo).toBe(false);
  });

  it('reparents a sibling once with Alt+ArrowRight and restores it through undo', () => {
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    const footer = screen.getByRole('treeitem', { name: 'Footer' });
    fireEvent.click(footer);

    fireEvent.keyDown(footer, { key: 'ArrowRight', altKey: true });

    expect(parentOf(session.document.root, 'Footer')?.attributes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'name', value: 'Main' })]),
    );
    session.history.undo();
    expect(session.snapshot().files.get(PATH)?.text).toBe(SOURCE);
    expect(session.history.canUndo).toBe(false);
  });

  it('rejects noncontiguous keyboard moves without changing source', () => {
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    const play = screen.getByRole('treeitem', { name: 'Play' });
    fireEvent.click(play);
    fireEvent.click(screen.getByRole('treeitem', { name: 'Settings' }), { ctrlKey: true });

    fireEvent.keyDown(play, { key: 'ArrowDown', altKey: true });

    expect(screen.getByRole('alert')).toHaveTextContent('contiguous siblings');
    expect(session.snapshot().files.get(PATH)?.text).toBe(SOURCE);
    expect(session.history.canUndo).toBe(false);
  });

  it('rejects drops into leaf controls without source mutation', () => {
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);

    fireEvent.dragStart(screen.getByRole('treeitem', { name: 'Play' }));
    fireEvent.dragOver(screen.getByRole('treeitem', { name: 'Quit' }));
    fireEvent.drop(screen.getByRole('treeitem', { name: 'Quit' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Button cannot contain children');
    expect(session.snapshot().files.get(PATH)?.text).toBe(SOURCE);
    expect(session.history.canUndo).toBe(false);
  });

  it('prevents root deletion and movement in the action and drag surfaces', () => {
    const { store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    const root = screen.getByRole('treeitem', { name: 'ui:UXML' });
    fireEvent.click(root);

    expect(root).toHaveAttribute('draggable', 'false');
    expect(screen.getByRole('button', { name: 'Remove selected' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move selected up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Indent selected' })).toBeDisabled();
  });

  it('selects the parent after deletion and restores the prior selection on undo', () => {
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'Play' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove selected' }));

    expect(screen.queryByRole('treeitem', { name: 'Play' })).not.toBeInTheDocument();
    expect(session.selection.map((locator) => locator.authoredName)).toEqual(['Main']);
    expect(store.getSnapshot().selection).toEqual(session.selectedNodeIds);
    session.history.undo();
    act(() => store.dispatch({ type: 'session/sync' }));
    expect(session.snapshot().files.get(PATH)?.text).toBe(SOURCE);
    expect(session.selection.map((locator) => locator.authoredName)).toEqual(['Play']);
    expect(store.getSnapshot().selection).toEqual(session.selectedNodeIds);
    expect(screen.getByRole('treeitem', { name: 'Play' })).toHaveAttribute('aria-selected', 'true');
  });

  it('duplicates source verbatim and reports duplicate authored names', () => {
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'Play' }));

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate selected' }));

    expect(screen.getAllByRole('treeitem', { name: 'Play' })).toHaveLength(2);
    expect(screen.getByText('Duplicate name "Play" appears 2 times.')).toBeVisible();
    expect(session.snapshot().files.get(PATH)?.text.match(/name="Play"/g)).toHaveLength(2);
    expect(session.snapshot().files.get(PATH)?.text).not.toContain('Play Copy');
  });

  it('renames an authored qualified element through an accessible form', async () => {
    const user = userEvent.setup();
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    await user.click(screen.getByRole('treeitem', { name: 'Mystery' }));
    await user.click(screen.getByRole('button', { name: 'Rename selected' }));
    const input = screen.getByRole('textbox', { name: 'Qualified element name' });
    await user.clear(input);
    await user.type(input, 'custom:Panel');

    await user.click(screen.getByRole('button', { name: 'Apply rename' }));

    expect(session.snapshot().files.get(PATH)?.text).toContain('<custom:Panel name="Mystery">');
    expect(session.snapshot().files.get(PATH)?.text).toContain('</custom:Panel>');
    expect(screen.getByRole('treeitem', { name: 'Mystery' })).toBeVisible();
  });

  it('wraps a contiguous multi-selection through one transaction', async () => {
    const user = userEvent.setup();
    const { session, store } = openEditor(SOURCE);
    render(<HierarchyHarness store={store} />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'Play' }));
    fireEvent.click(screen.getByRole('treeitem', { name: 'Quit' }), { ctrlKey: true });
    await user.click(screen.getByRole('button', { name: 'Wrap selected' }));
    await user.type(screen.getByRole('textbox', { name: 'Wrapper element name' }), 'ui:ScrollView');

    await user.click(screen.getByRole('button', { name: 'Apply wrap' }));

    const wrapper = screen.getByRole('treeitem', { name: 'ui:ScrollView' });
    expect(wrapper).toHaveAttribute('aria-selected', 'true');
    expect(parentOf(session.document.root, 'Play')?.name).toBe('ui:ScrollView');
    session.history.undo();
    expect(session.snapshot().files.get(PATH)?.text).toBe(SOURCE);
    expect(session.history.canUndo).toBe(false);
  });
});

describe('Workbench hierarchy integration', () => {
  it.each([
    { width: 1024, mode: 'desktop' },
    { width: 720, mode: 'compact' },
  ])('keeps the palette and hierarchy in the left authoring pane in $mode mode', ({ width, mode }) => {
    const { store } = openEditor(SOURCE, width);
    render(<Workbench store={store} />);

    expect(screen.getByRole('application', { name: 'UXML Editor' })).toHaveAttribute('data-layout-mode', mode);
    expect(screen.getByTestId('left-pane')).toContainElement(screen.getByRole('searchbox', { name: 'Search elements' }));
    expect(screen.getByTestId('left-pane')).toContainElement(screen.getByRole('tree', { name: 'Document hierarchy' }));
    expect(screen.getByRole('treeitem', { name: 'Mystery' })).toBeVisible();
  });
});

function HierarchyHarness({ store }: { readonly store: EditorStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <HierarchyPanel store={store} snapshot={snapshot} />;
}

function openEditor(source: string, width = 1024): { readonly session: DocumentSession; readonly store: EditorStore } {
  const session = DocumentSession.open(new Map([[PATH, source]]), PATH, new UxmlPreviewAdapter());
  return { session, store: new EditorStore({ session, viewport: { width, height: 768 } }) };
}

function parentOf(root: EditorElement, authoredName: string): EditorElement | null {
  for (const child of root.children) {
    if (child.attributes.some((attribute) => attribute.name === 'name' && attribute.value === authoredName)) {
      return root;
    }
    const nested = parentOf(child, authoredName);
    if (nested !== null) return nested;
  }
  return null;
}

function findByAuthoredName(root: EditorElement, authoredName: string): EditorElement | null {
  if (root.attributes.some((attribute) => attribute.name === 'name' && attribute.value === authoredName)) return root;
  for (const child of root.children) {
    const found = findByAuthoredName(child, authoredName);
    if (found !== null) return found;
  }
  return null;
}

function childNames(parent: EditorElement): readonly string[] {
  return parent.children.map((child) =>
    child.attributes.find((attribute) => attribute.name === 'name')?.value ?? child.name,
  );
}
