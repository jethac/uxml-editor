import { useMemo, useState, type FormEvent } from 'react';
import { Plus, Search } from 'lucide-react';
import type { EditorElement } from '../../core/adapter/types';
import { insertElement } from '../../core/commands/uxmlCommands';
import type { EditorTransaction } from '../../core/commands/EditorTransaction';
import type { DocumentSession } from '../../core/documents/DocumentSession';
import type { ElementLocator } from '../../core/documents/ElementLocator';
import type { EditorSnapshot, EditorStore } from '../../core/store/EditorStore';
import { createControlCatalog } from './controlCatalog';

export interface PalettePanelProps {
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
}

interface InsertionTarget {
  readonly parent: EditorElement;
  readonly index: number;
}

export function PalettePanel({ store, snapshot }: PalettePanelProps) {
  const [search, setSearch] = useState('');
  const [genericName, setGenericName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const session = snapshot.session;
  const controls = useMemo(
    () => createControlCatalog(session?.adapter.supportedControlNames() ?? []),
    [session],
  );
  const query = search.toLocaleLowerCase();
  const visible = controls.filter((control) => control.name.toLocaleLowerCase().includes(query));

  const addElement = (requestedName: string, generic: boolean) => {
    if (session === null) return;
    try {
      const target = insertionTarget(session);
      const qualifiedName = generic
        ? requestedName
        : qualifiedControlName(session.document.root, target.parent, requestedName);
      const parentLocator = session.locatorFor(target.parent.id);
      if (parentLocator === null) throw new Error('The insertion parent is no longer available.');
      const selectionAfter = insertedLocator(parentLocator, target.parent, target.index, qualifiedName);
      const command = insertElement(session, parentLocator, target.index, `<${qualifiedName} />`);
      session.history.execute(withSelection(command, [selectionAfter]));
      store.dispatch({ type: 'session/sync' });
      setError(null);
      if (generic) setGenericName('');
    } catch (caught) {
      setError(generic
        ? 'invalid element name or namespace binding.'
        : messageFrom(caught, 'The control could not be added.'));
    }
  };
  const submitGeneric = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    addElement(genericName, true);
  };

  return (
    <section className="palette-panel" aria-label="Element palette">
      <label className="palette-search">
        <Search size={14} aria-hidden="true" />
        <span className="visually-hidden">Search elements</span>
        <input
          type="search"
          aria-label="Search elements"
          placeholder="Search elements"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </label>
      <div className="palette-list" aria-label="Supported elements">
        {visible.map((control) => (
          <button
            key={control.name}
            type="button"
            className="palette-item"
            aria-label={`Add ${control.name}`}
            title={`Add ${control.name}`}
            disabled={session === null}
            onClick={() => addElement(control.name, false)}
          >
            <Plus size={13} aria-hidden="true" />
            <span>{control.name}</span>
          </button>
        ))}
        {visible.length === 0 && <span className="palette-empty">No matching elements</span>}
      </div>
      <form className="generic-element-form" aria-label="Add generic element" onSubmit={submitGeneric}>
        <input
          type="text"
          aria-label="Generic qualified name"
          placeholder="prefix:Element"
          value={genericName}
          onChange={(event) => setGenericName(event.currentTarget.value)}
        />
        <button type="submit" aria-label="Add generic element" title="Add generic element" disabled={session === null}>
          <Plus size={14} aria-hidden="true" />
        </button>
      </form>
      {error !== null && <div className="structural-error" role="alert">{error}</div>}
    </section>
  );
}

function insertionTarget(session: DocumentSession): InsertionTarget {
  const root = session.document.root;
  const selected = session.selectedNodeIds
    .map((nodeId) => findElement(root, nodeId))
    .filter((element): element is EditorElement => element !== null);
  if (selected.length === 1 && isContainerCapable(selected[0])) {
    return { parent: selected[0], index: selected[0].children.length };
  }
  if (selected.length > 0) {
    const selectedIds = new Set(selected.map((element) => element.id));
    const ordered = walkElements(root).filter((element) => selectedIds.has(element.id));
    const last = ordered[ordered.length - 1];
    const parent = parentOf(root, last);
    if (parent !== null) {
      return { parent, index: parent.children.findIndex((child) => child.id === last.id) + 1 };
    }
  }
  return { parent: root, index: root.children.length };
}

function insertedLocator(
  parentLocator: ElementLocator,
  parent: EditorElement,
  index: number,
  qualifiedName: string,
): ElementLocator {
  return Object.freeze({
    qualifiedTag: qualifiedName,
    childPath: Object.freeze([...parentLocator.childPath, index]),
    ancestorTags: Object.freeze([...parentLocator.ancestorTags, parent.name]),
    attributeHints: Object.freeze([]),
  });
}

function qualifiedControlName(root: EditorElement, destination: EditorElement, localName: string): string {
  const bindings = namespaceBindingsAt(root, destination);
  if (bindings.get('') === 'UnityEngine.UIElements') return localName;
  const prefixed = [...bindings].find(([prefix, namespace]) =>
    prefix.length > 0 && namespace === 'UnityEngine.UIElements',
  );
  if (prefixed !== undefined) return `${prefixed[0]}:${localName}`;
  throw new Error(`${localName} cannot be added because no in-scope namespace is bound to UnityEngine.UIElements.`);
}

function namespaceBindingsAt(root: EditorElement, destination: EditorElement): ReadonlyMap<string, string> {
  const path = pathToElement(root, destination.id);
  if (path === null) throw new Error('The insertion parent is no longer available.');
  const bindings = new Map<string, string>();
  for (const element of path) {
    for (const attribute of element.attributes) {
      if (attribute.name === 'xmlns') bindings.set('', attribute.value);
      else if (attribute.name.startsWith('xmlns:')) {
        bindings.set(attribute.name.slice('xmlns:'.length), attribute.value);
      }
    }
  }
  return bindings;
}

function pathToElement(root: EditorElement, nodeId: string): readonly EditorElement[] | null {
  if (root.id === nodeId) return [root];
  for (const child of root.children) {
    const path = pathToElement(child, nodeId);
    if (path !== null) return [root, ...path];
  }
  return null;
}

function isContainerCapable(element: EditorElement): boolean {
  return !['Label', 'Button', 'Image'].includes(localNameOf(element.name));
}

function localNameOf(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);
}

function findElement(root: EditorElement, nodeId: string): EditorElement | null {
  if (root.id === nodeId) return root;
  for (const child of root.children) {
    const found = findElement(child, nodeId);
    if (found !== null) return found;
  }
  return null;
}

function parentOf(root: EditorElement, target: EditorElement): EditorElement | null {
  for (const child of root.children) {
    if (child.id === target.id) return root;
    const found = parentOf(child, target);
    if (found !== null) return found;
  }
  return null;
}

function walkElements(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walkElements)];
}

function withSelection(transaction: EditorTransaction, selectionAfter: readonly ElementLocator[]): EditorTransaction {
  return { ...transaction, selectionAfter };
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
