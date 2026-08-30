import type {
  CSSProperties,
  DragEvent,
  KeyboardEvent,
  MouseEvent,
} from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { EditorElement, EditorNodeId } from '../../core/adapter/types';

export type HierarchyDropPosition = 'before' | 'inside' | 'after';

export interface HierarchyRowProps {
  readonly element: EditorElement;
  readonly level: number;
  readonly root: boolean;
  readonly activeId: EditorNodeId;
  readonly expandedIds: ReadonlySet<EditorNodeId>;
  readonly selectedIds: ReadonlySet<EditorNodeId>;
  readonly dropTarget: Readonly<{ nodeId: EditorNodeId; position: HierarchyDropPosition }> | null;
  readonly setRowRef: (nodeId: EditorNodeId, element: HTMLDivElement | null) => void;
  readonly onFocus: (element: EditorElement) => void;
  readonly onToggle: (element: EditorElement) => void;
  readonly onSelect: (element: EditorElement, event: MouseEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (element: EditorElement, event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onDragStart: (element: EditorElement, event: DragEvent<HTMLDivElement>) => void;
  readonly onDragOver: (element: EditorElement, event: DragEvent<HTMLDivElement>) => void;
  readonly onDragLeave: (element: EditorElement, event: DragEvent<HTMLDivElement>) => void;
  readonly onDrop: (element: EditorElement, event: DragEvent<HTMLDivElement>) => void;
  readonly onDragEnd: () => void;
}

export function HierarchyRow(props: HierarchyRowProps) {
  const {
    element,
    level,
    root,
    activeId,
    expandedIds,
    selectedIds,
    dropTarget,
    setRowRef,
    onFocus,
    onToggle,
    onSelect,
    onKeyDown,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
  } = props;
  const label = displayName(element);
  const hasChildren = element.children.length > 0;
  const expanded = hasChildren && expandedIds.has(element.id);
  const dropPosition = dropTarget?.nodeId === element.id ? dropTarget.position : undefined;
  const style: CSSProperties = { paddingLeft: `${4 + ((level - 1) * 14)}px` };

  return (
    <div
      ref={(node) => setRowRef(element.id, node)}
      className="hierarchy-treeitem"
      role="treeitem"
      aria-label={label}
      aria-level={level}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selectedIds.has(element.id)}
      draggable={!root}
      tabIndex={activeId === element.id ? 0 : -1}
      data-drop-position={dropPosition}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus(element);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(element, event);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (hasChildren) onToggle(element);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        onKeyDown(element, event);
      }}
      onDragStart={(event) => {
        event.stopPropagation();
        onDragStart(element, event);
      }}
      onDragOver={(event) => {
        event.stopPropagation();
        onDragOver(element, event);
      }}
      onDragLeave={(event) => {
        event.stopPropagation();
        onDragLeave(element, event);
      }}
      onDrop={(event) => {
        event.stopPropagation();
        onDrop(element, event);
      }}
      onDragEnd={(event) => {
        event.stopPropagation();
        onDragEnd();
      }}
    >
      <div className="hierarchy-row" style={style}>
        {hasChildren
          ? (
              <button
                type="button"
                className="hierarchy-expander"
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
                title={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle(element);
                }}
              >
                {expanded
                  ? <ChevronDown size={13} aria-hidden="true" />
                  : <ChevronRight size={13} aria-hidden="true" />}
              </button>
            )
          : <span className="hierarchy-expander-spacer" aria-hidden="true" />}
        <span className="hierarchy-row-label">{label}</span>
        {label !== element.name && <span className="hierarchy-row-tag">{element.name}</span>}
      </div>
      {expanded && (
        <div role="group">
          {element.children.map((child) => (
            <HierarchyRow
              key={child.id}
              {...props}
              element={child}
              level={level + 1}
              root={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function displayName(element: EditorElement): string {
  return element.attributes.find((attribute) => attribute.name === 'name')?.value ?? element.name;
}
