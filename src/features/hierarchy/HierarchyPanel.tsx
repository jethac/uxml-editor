import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  IndentDecrease,
  IndentIncrease,
  Pencil,
  Trash2,
  WrapText,
  X,
} from 'lucide-react';
import type { EditorElement, EditorNodeId } from '../../core/adapter/types';
import type { EditorTransaction } from '../../core/commands/EditorTransaction';
import {
  duplicateElement,
  moveElement,
  removeElement,
  renameElement,
  wrapElements,
} from '../../core/commands/uxmlCommands';
import type { DocumentSession } from '../../core/documents/DocumentSession';
import { resolveElementLocator, type ElementLocator } from '../../core/documents/ElementLocator';
import type { EditorSnapshot, EditorStore } from '../../core/store/EditorStore';
import { HierarchyRow, type HierarchyDropPosition } from './HierarchyRow';

export interface HierarchyPanelProps {
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
}

interface LocatedElement {
  readonly element: EditorElement;
  readonly parent: EditorElement | null;
  readonly index: number;
}

interface SelectedBlock {
  readonly elements: readonly EditorElement[];
  readonly parent: EditorElement | null;
  readonly indices: readonly number[];
  readonly contiguous: boolean;
}

type EditForm = 'rename' | 'wrap' | null;

export function HierarchyPanel({ store, snapshot }: HierarchyPanelProps) {
  if (snapshot.session === null) return <span className="pane-empty">No document</span>;
  return <SessionHierarchyPanel store={store} session={snapshot.session} />;
}

function SessionHierarchyPanel({ store, session }: { readonly store: EditorStore; readonly session: DocumentSession }) {
  const root = session.document.root;
  const all = useMemo(() => locateElements(root), [root]);
  const byId = useMemo(() => new Map(all.map((entry) => [entry.element.id, entry])), [all]);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<EditorNodeId>>(
    () => new Set(all.filter((entry) => entry.element.children.length > 0).map((entry) => entry.element.id)),
  );
  const [activeId, setActiveId] = useState<EditorNodeId>(root.id);
  const [dropTarget, setDropTarget] = useState<Readonly<{
    nodeId: EditorNodeId;
    position: HierarchyDropPosition;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(null);
  const [editValue, setEditValue] = useState('');
  const [, setRevision] = useState(0);
  const rowRefs = useRef(new Map<EditorNodeId, HTMLDivElement>());
  const selectionAnchor = useRef<EditorNodeId>(root.id);
  const draggedLocators = useRef<readonly ElementLocator[]>(Object.freeze([]));
  const selectedIds = new Set(session.selectedNodeIds);
  const visible = visibleElements(root, expandedIds);
  const block = selectedBlock(root, selectedIds);
  const rootSelected = selectedIds.has(root.id);

  useEffect(() => {
    setExpandedIds(new Set(all
      .filter((entry) => entry.element.children.length > 0)
      .map((entry) => entry.element.id)));
    const next = session.selectedNodeIds[0] ?? root.id;
    setActiveId(next);
    selectionAnchor.current = next;
  }, [all, root, session]);

  useEffect(() => {
    if (byId.has(activeId)) return;
    const next = session.selectedNodeIds.find((nodeId) => byId.has(nodeId)) ?? root.id;
    setActiveId(next);
  }, [activeId, byId, root.id, session]);

  const setRowRef = (nodeId: EditorNodeId, element: HTMLDivElement | null) => {
    if (element === null) rowRefs.current.delete(nodeId);
    else rowRefs.current.set(nodeId, element);
  };
  const focusRow = (nodeId: EditorNodeId) => {
    setActiveId(nodeId);
    rowRefs.current.get(nodeId)?.focus();
  };
  const syncSelection = (locators: readonly ElementLocator[], focusId?: EditorNodeId) => {
    session.setSelection(locators);
    store.dispatch({ type: 'session/sync' });
    setRevision((value) => value + 1);
    if (focusId !== undefined) {
      selectionAnchor.current = focusId;
      setActiveId(focusId);
    }
  };
  const syncMutation = (expandSelected = false) => {
    store.dispatch({ type: 'session/sync' });
    setRevision((value) => value + 1);
    const next = session.selectedNodeIds[0] ?? session.document.root.id;
    setActiveId(next);
    selectionAnchor.current = next;
    if (expandSelected) {
      setExpandedIds((current) => new Set([...current, ...session.selectedNodeIds]));
    }
  };
  const execute = (
    transaction: EditorTransaction,
    selectionAfter?: readonly ElementLocator[],
    expandSelected = false,
  ) => {
    session.history.execute(selectionAfter === undefined ? transaction : withSelection(transaction, selectionAfter));
    syncMutation(expandSelected);
    setError(null);
  };
  const selectElement = (element: EditorElement, event: Pick<MouseEvent<HTMLDivElement>, 'ctrlKey' | 'metaKey' | 'shiftKey'>) => {
    let nodeIds: readonly EditorNodeId[];
    if (event.shiftKey && byId.has(selectionAnchor.current)) {
      const anchorIndex = visible.findIndex((candidate) => candidate.id === selectionAnchor.current);
      const targetIndex = visible.findIndex((candidate) => candidate.id === element.id);
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      nodeIds = visible.slice(start, end + 1).map((candidate) => candidate.id);
    } else if (event.ctrlKey || event.metaKey) {
      nodeIds = selectedIds.has(element.id)
        ? session.selectedNodeIds.filter((nodeId) => nodeId !== element.id)
        : [...session.selectedNodeIds, element.id];
    } else {
      nodeIds = [element.id];
    }
    const locators = nodeIds
      .map((nodeId) => session.locatorFor(nodeId))
      .filter((locator): locator is ElementLocator => locator !== null);
    syncSelection(locators, element.id);
    if (!event.shiftKey) selectionAnchor.current = element.id;
    setError(null);
  };
  const toggle = (element: EditorElement) => {
    if (expandedIds.has(element.id) && findElement(element, activeId) !== null) {
      setActiveId(element.id);
      selectionAnchor.current = element.id;
    }
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(element.id)) next.delete(element.id);
      else next.add(element.id);
      return next;
    });
  };

  const executeMove = (elements: readonly EditorElement[], destination: EditorElement, index: number) => {
    const sourceLocators = locatorsFor(session, elements);
    const destinationLocator = session.locatorFor(destination.id);
    if (destinationLocator === null) throw new Error('The move destination is no longer available.');
    const selectionAfter = relocatedLocators(elements, destination, destinationLocator, index);
    execute(moveElement(session, sourceLocators, destinationLocator, index), selectionAfter, true);
  };
  const moveSelection = (direction: 'up' | 'down' | 'indent' | 'outdent') => {
    try {
      if (block.elements.length === 0 || block.parent === null) {
        throw new Error('The UXML root element cannot be moved.');
      }
      const firstIndex = block.indices[0];
      const lastIndex = block.indices[block.indices.length - 1];
      if (direction === 'up') {
        if (firstIndex <= 0) throw new Error('The selection is already first.');
        executeMove(block.elements, block.parent, firstIndex - 1);
      } else if (direction === 'down') {
        if (lastIndex >= block.parent.children.length - 1) throw new Error('The selection is already last.');
        executeMove(block.elements, block.parent, firstIndex + 1);
      } else if (direction === 'indent') {
        const destination = block.parent.children[firstIndex - 1];
        if (destination === undefined) throw new Error('The selection has no previous sibling to contain it.');
        requireContainer(destination);
        executeMove(block.elements, destination, destination.children.length);
      } else {
        const parentEntry = byId.get(block.parent.id);
        if (parentEntry?.parent === null || parentEntry?.parent === undefined) {
          throw new Error('The selection is already at the document root.');
        }
        executeMove(block.elements, parentEntry.parent, parentEntry.index + 1);
      }
    } catch (caught) {
      setError(messageFrom(caught, 'The selection could not be moved.'));
    }
  };

  const handleKeyDown = (element: EditorElement, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey && ['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft'].includes(event.key)) {
      event.preventDefault();
      const direction = event.key === 'ArrowUp'
        ? 'up'
        : event.key === 'ArrowDown'
          ? 'down'
          : event.key === 'ArrowRight' ? 'indent' : 'outdent';
      moveSelection(direction);
      return;
    }
    const index = visible.findIndex((candidate) => candidate.id === element.id);
    if (event.key === 'ArrowDown' && visible[index + 1] !== undefined) focusRow(visible[index + 1].id);
    else if (event.key === 'ArrowUp' && visible[index - 1] !== undefined) focusRow(visible[index - 1].id);
    else if (event.key === 'Home') focusRow(visible[0].id);
    else if (event.key === 'End') focusRow(visible[visible.length - 1].id);
    else if (event.key === 'ArrowRight') {
      if (element.children.length > 0 && !expandedIds.has(element.id)) toggle(element);
      else if (element.children[0] !== undefined) focusRow(element.children[0].id);
    } else if (event.key === 'ArrowLeft') {
      if (element.children.length > 0 && expandedIds.has(element.id)) toggle(element);
      else {
        const parent = byId.get(element.id)?.parent;
        if (parent !== null && parent !== undefined) focusRow(parent.id);
      }
    } else if (event.key === ' ' || event.key === 'Enter') {
      selectElement(element, event);
    } else return;
    event.preventDefault();
  };

  const handleDragStart = (element: EditorElement, event: DragEvent<HTMLDivElement>) => {
    if (element.id === root.id) {
      event.preventDefault();
      return;
    }
    if (!selectedIds.has(element.id)) {
      selectElement(element, { ctrlKey: false, metaKey: false, shiftKey: false });
    }
    const locator = session.locatorFor(element.id);
    if (locator === null) {
      event.preventDefault();
      setError('The dragged element is no longer available.');
      return;
    }
    draggedLocators.current = selectedIds.has(element.id)
      ? Object.freeze([...session.selection])
      : Object.freeze([locator]);
    const dataTransfer = event.dataTransfer;
    dataTransfer?.setData('text/plain', String(element.id));
    if (dataTransfer !== undefined && dataTransfer !== null) dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (element: EditorElement, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const dataTransfer = event.dataTransfer;
    if (dataTransfer !== undefined && dataTransfer !== null) dataTransfer.dropEffect = 'move';
    setDropTarget({ nodeId: element.id, position: dropPositionFor(element, event) });
  };
  const handleDragLeave = (element: EditorElement, event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropTarget((current) => current?.nodeId === element.id ? null : current);
  };
  const handleDrop = (target: EditorElement, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const position = dropTarget?.nodeId === target.id ? dropTarget.position : dropPositionFor(target, event);
    setDropTarget(null);
    try {
      const sources = draggedLocators.current
        .map((locator) => resolveLocatorElement(session, locator))
        .filter((element): element is EditorElement => element !== null);
      if (sources.length === 0) return;
      if (position === 'inside') {
        requireContainer(target);
        const movingIds = new Set(sources.map((element) => element.id));
        const index = target.children.filter((child) => !movingIds.has(child.id)).length;
        executeMove(sources, target, index);
      } else {
        const targetEntry = byId.get(target.id);
        if (targetEntry?.parent === null || targetEntry?.parent === undefined) {
          throw new Error('Elements cannot be dropped beside the UXML root.');
        }
        const movingIds = new Set(sources.map((element) => element.id));
        const remaining = targetEntry.parent.children.filter((child) => !movingIds.has(child.id));
        const targetIndex = remaining.findIndex((child) => child.id === target.id);
        if (targetIndex < 0) throw new Error('The selection cannot be dropped onto itself.');
        executeMove(sources, targetEntry.parent, targetIndex + (position === 'after' ? 1 : 0));
      }
    } catch (caught) {
      setError(messageFrom(caught, 'The selection could not be moved.'));
    } finally {
      draggedLocators.current = Object.freeze([]);
    }
  };

  const removeSelected = () => {
    try {
      if (block.elements.length === 0 || block.parent === null) throw new Error('The UXML root element cannot be removed.');
      if (!block.contiguous) throw new Error('Removed elements must be contiguous siblings.');
      const parentLocator = session.locatorFor(block.parent.id);
      if (parentLocator === null) throw new Error('The selection parent is no longer available.');
      const commands = locatorsFor(session, block.elements).map((locator) => removeElement(session, locator));
      execute(commands.length === 1 ? commands[0] : combineTransactions(commands, 'remove-elements', `Remove ${commands.length} elements`), [parentLocator]);
      setEditForm(null);
    } catch (caught) {
      setError(messageFrom(caught, 'The selection could not be removed.'));
    }
  };
  const duplicateSelected = () => {
    try {
      const element = block.elements.length === 1 ? block.elements[0] : null;
      if (element === null || block.parent === null) throw new Error('Select one non-root element to duplicate.');
      const locator = requireLocator(session, element.id);
      const parentLocator = requireLocator(session, block.parent.id);
      const selectionAfter = relocatedLocators([element], block.parent, parentLocator, block.indices[0] + 1);
      execute(duplicateElement(session, locator), selectionAfter);
    } catch (caught) {
      setError(messageFrom(caught, 'The element could not be duplicated.'));
    }
  };
  const openRename = () => {
    const element = block.elements.length === 1 ? block.elements[0] : null;
    if (element === null) return;
    setEditValue(element.name);
    setEditForm('rename');
    setError(null);
  };
  const applyRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const element = block.elements.length === 1 ? block.elements[0] : null;
      if (element === null) throw new Error('Select one element to rename.');
      const locator = requireLocator(session, element.id);
      execute(renameElement(session, locator, editValue), [{ ...locator, qualifiedTag: editValue }]);
      setEditForm(null);
    } catch (caught) {
      setError(messageFrom(caught, 'The element could not be renamed.'));
    }
  };
  const openWrap = () => {
    setEditValue('');
    setEditForm('wrap');
    setError(null);
  };
  const applyWrap = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      if (block.elements.length === 0 || block.parent === null) throw new Error('Select non-root elements to wrap.');
      const parentLocator = requireLocator(session, block.parent.id);
      const wrapperLocator = insertedLocator(parentLocator, block.parent, block.indices[0], editValue);
      execute(wrapElements(session, locatorsFor(session, block.elements), editValue), [wrapperLocator], true);
      setEditForm(null);
    } catch (caught) {
      setError(messageFrom(caught, 'The selection could not be wrapped.'));
    }
  };

  const canMove = block.elements.length > 0 && block.parent !== null && block.contiguous && !rootSelected;
  const canMoveUp = canMove && block.indices[0] > 0;
  const canMoveDown = canMove && block.indices[block.indices.length - 1] < block.parent!.children.length - 1;
  const previousSibling = canMove ? block.parent!.children[block.indices[0] - 1] : undefined;
  const canIndent = previousSibling !== undefined && isContainerCapable(previousSibling);
  const parentEntry = block.parent === null ? undefined : byId.get(block.parent.id);
  const canOutdent = canMove && parentEntry?.parent !== null && parentEntry?.parent !== undefined;
  const duplicateNames = duplicateNameMessages(root);

  return (
    <section className="hierarchy-panel" aria-label="Hierarchy editor">
      <div className="hierarchy-toolbar" role="toolbar" aria-label="Hierarchy actions">
        <ActionButton label="Move selected up" disabled={!canMoveUp} onClick={() => moveSelection('up')}><ArrowUp /></ActionButton>
        <ActionButton label="Move selected down" disabled={!canMoveDown} onClick={() => moveSelection('down')}><ArrowDown /></ActionButton>
        <ActionButton label="Indent selected" disabled={!canIndent} onClick={() => moveSelection('indent')}><IndentIncrease /></ActionButton>
        <ActionButton label="Outdent selected" disabled={!canOutdent} onClick={() => moveSelection('outdent')}><IndentDecrease /></ActionButton>
        <span className="hierarchy-toolbar-separator" aria-hidden="true" />
        <ActionButton label="Duplicate selected" disabled={block.elements.length !== 1 || rootSelected} onClick={duplicateSelected}><Copy /></ActionButton>
        <ActionButton label="Rename selected" disabled={block.elements.length !== 1 || rootSelected} onClick={openRename}><Pencil /></ActionButton>
        <ActionButton label="Wrap selected" disabled={!canMove} onClick={openWrap}><WrapText /></ActionButton>
        <ActionButton label="Remove selected" disabled={!canMove} onClick={removeSelected}><Trash2 /></ActionButton>
      </div>
      {editForm === 'rename' && (
        <StructuralForm
          label="Rename element"
          inputLabel="Qualified element name"
          value={editValue}
          applyLabel="Apply rename"
          onChange={setEditValue}
          onSubmit={applyRename}
          onCancel={() => setEditForm(null)}
        />
      )}
      {editForm === 'wrap' && (
        <StructuralForm
          label="Wrap elements"
          inputLabel="Wrapper element name"
          value={editValue}
          applyLabel="Apply wrap"
          onChange={setEditValue}
          onSubmit={applyWrap}
          onCancel={() => setEditForm(null)}
        />
      )}
      {error !== null && <div className="structural-error" role="alert">{error}</div>}
      {duplicateNames.length > 0 && (
        <ul className="hierarchy-validation" aria-label="Hierarchy validation">
          {duplicateNames.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}
      <div className="hierarchy-tree-scroll">
        <div role="tree" aria-label="Document hierarchy" aria-multiselectable="true">
          <HierarchyRow
            element={root}
            level={1}
            root
            activeId={activeId}
            expandedIds={expandedIds}
            selectedIds={selectedIds}
            dropTarget={dropTarget}
            setRowRef={setRowRef}
            onFocus={(element) => setActiveId(element.id)}
            onToggle={toggle}
            onSelect={selectElement}
            onKeyDown={handleKeyDown}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onDragEnd={() => setDropTarget(null)}
          />
        </div>
      </div>
    </section>
  );
}

function ActionButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactElement<{ size?: number; 'aria-hidden'?: string }>;
}) {
  return (
    <button type="button" className="hierarchy-action" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function StructuralForm({
  label,
  inputLabel,
  value,
  applyLabel,
  onChange,
  onSubmit,
  onCancel,
}: {
  readonly label: string;
  readonly inputLabel: string;
  readonly value: string;
  readonly applyLabel: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onCancel: () => void;
}) {
  return (
    <form className="hierarchy-edit-form" aria-label={label} onSubmit={onSubmit}>
      <input autoFocus type="text" aria-label={inputLabel} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
      <button type="submit">{applyLabel}</button>
      <button type="button" className="hierarchy-form-cancel" aria-label={`Cancel ${label.toLocaleLowerCase()}`} title="Cancel" onClick={onCancel}>
        <X size={14} aria-hidden="true" />
      </button>
    </form>
  );
}

function locateElements(root: EditorElement): readonly LocatedElement[] {
  const result: LocatedElement[] = [];
  const visit = (element: EditorElement, parent: EditorElement | null, index: number) => {
    result.push({ element, parent, index });
    element.children.forEach((child, childIndex) => visit(child, element, childIndex));
  };
  visit(root, null, 0);
  return result;
}

function visibleElements(root: EditorElement, expandedIds: ReadonlySet<EditorNodeId>): readonly EditorElement[] {
  const result: EditorElement[] = [];
  const visit = (element: EditorElement) => {
    result.push(element);
    if (expandedIds.has(element.id)) element.children.forEach(visit);
  };
  visit(root);
  return result;
}

function selectedBlock(root: EditorElement, selectedIds: ReadonlySet<EditorNodeId>): SelectedBlock {
  const selected = locateElements(root).filter((entry) => selectedIds.has(entry.element.id));
  if (selected.length === 0) return { elements: [], parent: null, indices: [], contiguous: false };
  const parent = selected[0].parent;
  const sameParent = parent !== null && selected.every((entry) => entry.parent?.id === parent.id);
  const indices = selected.map((entry) => entry.index).sort((left, right) => left - right);
  const contiguous = sameParent && indices.every((value, position) => position === 0 || value === indices[position - 1] + 1);
  return {
    elements: selected.sort((left, right) => left.index - right.index).map((entry) => entry.element),
    parent: sameParent ? parent : null,
    indices,
    contiguous,
  };
}

function locatorsFor(session: DocumentSession, elements: readonly EditorElement[]): readonly ElementLocator[] {
  return elements.map((element) => requireLocator(session, element.id, element.name));
}

function requireLocator(session: DocumentSession, nodeId: EditorNodeId, label = 'Element'): ElementLocator {
  const locator = session.locatorFor(nodeId);
  if (locator === null) throw new Error(`${label} is no longer available.`);
  return locator;
}

function relocatedLocators(
  elements: readonly EditorElement[],
  destination: EditorElement,
  destinationLocator: ElementLocator,
  index: number,
): readonly ElementLocator[] {
  return elements.map((element, offset) => {
    const authoredName = element.attributes.find((attribute) => attribute.name === 'name')?.value;
    return Object.freeze({
      qualifiedTag: element.name,
      childPath: Object.freeze([...destinationLocator.childPath, index + offset]),
      ancestorTags: Object.freeze([...destinationLocator.ancestorTags, destination.name]),
      attributeHints: Object.freeze(element.attributes.map((attribute) => Object.freeze({
        name: attribute.name,
        value: attribute.value,
      }))),
      ...(authoredName === undefined ? {} : { authoredName }),
    });
  });
}

function insertedLocator(
  parentLocator: ElementLocator,
  parent: EditorElement,
  index: number,
  qualifiedTag: string,
): ElementLocator {
  return Object.freeze({
    qualifiedTag,
    childPath: Object.freeze([...parentLocator.childPath, index]),
    ancestorTags: Object.freeze([...parentLocator.ancestorTags, parent.name]),
    attributeHints: Object.freeze([]),
  });
}

function resolveLocatorElement(session: DocumentSession, locator: ElementLocator): EditorElement | null {
  const nodeId = resolveElementLocator(session.document.root, locator);
  if (nodeId === null) return null;
  return findElement(session.document.root, nodeId);
}

function findElement(root: EditorElement, nodeId: EditorNodeId): EditorElement | null {
  if (root.id === nodeId) return root;
  for (const child of root.children) {
    const found = findElement(child, nodeId);
    if (found !== null) return found;
  }
  return null;
}

function dropPositionFor(element: EditorElement, event: DragEvent<HTMLDivElement>): HierarchyDropPosition {
  const rectangle = event.currentTarget.getBoundingClientRect();
  if (rectangle.height <= 0) return 'inside';
  const offset = event.clientY - rectangle.top;
  if (offset < rectangle.height / 3) return 'before';
  if (offset > rectangle.height * 2 / 3) return 'after';
  return 'inside';
}

function requireContainer(element: EditorElement): void {
  if (!isContainerCapable(element)) throw new Error(`${localNameOf(element.name)} cannot contain children.`);
}

function isContainerCapable(element: EditorElement): boolean {
  return !['Label', 'Button', 'Image'].includes(localNameOf(element.name));
}

function localNameOf(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);
}

function combineTransactions(
  transactions: readonly EditorTransaction[],
  id: string,
  label: string,
): EditorTransaction {
  const patchesByFile = new Map<string, import('../../core/commands/SourcePatch').SourcePatch[]>();
  for (const transaction of transactions) {
    for (const [path, patches] of transaction.patchesByFile) {
      patchesByFile.set(path, [...(patchesByFile.get(path) ?? []), ...patches]);
    }
  }
  return { id, label, patchesByFile };
}

function withSelection(transaction: EditorTransaction, selectionAfter: readonly ElementLocator[]): EditorTransaction {
  return { ...transaction, selectionAfter };
}

function duplicateNameMessages(root: EditorElement): readonly string[] {
  const counts = new Map<string, number>();
  for (const { element } of locateElements(root)) {
    for (const attribute of element.attributes) {
      if (attribute.name === 'name') counts.set(attribute.value, (counts.get(attribute.value) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `Duplicate name "${name}" appears ${count} times.`);
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
