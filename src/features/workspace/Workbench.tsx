import { useRef, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type Ref } from 'react';
import {
  PANE_LIMITS,
  WORKBENCH_COMMAND_BAR_HEIGHT,
  WORKBENCH_COMPACT_BREAKPOINT,
  WORKBENCH_MIN_CANVAS_WIDTH,
  WORKBENCH_SEPARATOR_SIZE,
} from '../../core/store/EditorLayoutStorage';
import type { EditorPanel, EditorSnapshot, EditorStore } from '../../core/store/EditorStore';
import { PreviewCanvas } from '../canvas/PreviewCanvas';
import { HierarchyPanel } from '../hierarchy/HierarchyPanel';
import { PalettePanel } from '../palette/PalettePanel';
import { CommandBar } from './CommandBar';
import { PaneResizer } from './PaneResizer';
import '../../styles/workbench.css';
import '../../styles/canvas.css';

export interface WorkbenchProps {
  readonly store: EditorStore;
}

type WorkbenchStyle = CSSProperties & {
  '--workbench-left-pane': string;
  '--workbench-right-pane': string;
  '--workbench-bottom-pane': string;
  '--workbench-commandbar': string;
  '--workbench-separator': string;
};

const PANELS: readonly EditorPanel[] = Object.freeze(['hierarchy', 'inspector', 'diagnostics']);

export function Workbench({ store }: WorkbenchProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const desktopPanes = useRef<Record<EditorPanel, HTMLElement | null>>({
    hierarchy: null,
    inspector: null,
    diagnostics: null,
  });
  const desktopCanvasWidth = snapshot.viewport.width
    - snapshot.panes.left
    - snapshot.panes.right
    - (WORKBENCH_SEPARATOR_SIZE * 2);
  const compact = snapshot.viewport.width <= WORKBENCH_COMPACT_BREAKPOINT
    || desktopCanvasWidth < WORKBENCH_MIN_CANVAS_WIDTH;
  const style: WorkbenchStyle = {
    '--workbench-left-pane': `${snapshot.panes.left}px`,
    '--workbench-right-pane': `${snapshot.panes.right}px`,
    '--workbench-bottom-pane': `${snapshot.panes.bottom}px`,
    '--workbench-commandbar': `${WORKBENCH_COMMAND_BAR_HEIGHT}px`,
    '--workbench-separator': `${WORKBENCH_SEPARATOR_SIZE}px`,
  };
  const activatePanel = (panel: EditorPanel) => {
    store.dispatch({ type: 'panel/set', panel });
    if (!compact) desktopPanes.current[panel]?.focus();
  };

  return (
    <div
      className={`editor-workbench editor-workbench--${compact ? 'compact' : 'desktop'}`}
      style={style}
      role="application"
      aria-label="UXML Editor"
      data-layout-mode={compact ? 'compact' : 'desktop'}
    >
      <CommandBar store={store} snapshot={snapshot} onPanelActivate={activatePanel} />
      {compact
        ? <CompactWorkspace store={store} snapshot={snapshot} />
        : <DesktopWorkspace
            store={store}
            snapshot={snapshot}
            setPaneRef={(panel, element) => { desktopPanes.current[panel] = element; }}
          />}
    </div>
  );
}

interface WorkspaceProps {
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
}

interface DesktopWorkspaceProps extends WorkspaceProps {
  readonly setPaneRef: (panel: EditorPanel, element: HTMLElement | null) => void;
}

function DesktopWorkspace({ store, snapshot, setPaneRef }: DesktopWorkspaceProps) {
  return (
    <>
      <ToolPane
        kind="hierarchy"
        store={store}
        snapshot={snapshot}
        compact={false}
        paneRef={(element) => setPaneRef('hierarchy', element)}
      />
      <PaneResizer
        testId="left-resizer"
        label="Resize hierarchy pane"
        orientation="vertical"
        value={snapshot.panes.left}
        min={PANE_LIMITS.left.min}
        max={PANE_LIMITS.left.max}
        movementSign={1}
        onResize={(size, persist) => store.dispatch({ type: 'panes/resize', pane: 'left', size, persist })}
      />
      <PreviewCanvas store={store} />
      <PaneResizer
        testId="right-resizer"
        label="Resize inspector pane"
        orientation="vertical"
        value={snapshot.panes.right}
        min={PANE_LIMITS.right.min}
        max={PANE_LIMITS.right.max}
        movementSign={-1}
        onResize={(size, persist) => store.dispatch({ type: 'panes/resize', pane: 'right', size, persist })}
      />
      <PaneResizer
        testId="bottom-resizer"
        label="Resize diagnostics pane"
        orientation="horizontal"
        value={snapshot.panes.bottom}
        min={PANE_LIMITS.bottom.min}
        max={PANE_LIMITS.bottom.max}
        movementSign={-1}
        onResize={(size, persist) => store.dispatch({ type: 'panes/resize', pane: 'bottom', size, persist })}
      />
      <ToolPane
        kind="inspector"
        store={store}
        snapshot={snapshot}
        compact={false}
        paneRef={(element) => setPaneRef('inspector', element)}
      />
      <ToolPane
        kind="diagnostics"
        store={store}
        snapshot={snapshot}
        compact={false}
        paneRef={(element) => setPaneRef('diagnostics', element)}
      />
    </>
  );
}

function CompactWorkspace({ store, snapshot }: WorkspaceProps) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = PANELS.indexOf(snapshot.activePanel);
  const activate = (index: number, moveFocus: boolean) => {
    const normalized = (index + PANELS.length) % PANELS.length;
    store.dispatch({ type: 'panel/set', panel: PANELS[normalized] });
    if (moveFocus) tabs.current[normalized]?.focus();
  };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowRight') activate(index + 1, true);
    else if (event.key === 'ArrowLeft') activate(index - 1, true);
    else if (event.key === 'Home') activate(0, true);
    else if (event.key === 'End') activate(PANELS.length - 1, true);
    else return;
    event.preventDefault();
  };

  return (
    <>
      <PreviewCanvas store={store} />
      <div className="compact-tools" data-testid="compact-tools">
        <div className="compact-tabs" role="tablist" aria-label="Tool panes">
          {PANELS.map((panel, index) => (
            <button
              key={panel}
              ref={(element) => { tabs.current[index] = element; }}
              type="button"
              role="tab"
              id={`compact-${panel}-tab`}
              aria-controls={`compact-${panel}-panel`}
              aria-selected={activeIndex === index}
              tabIndex={activeIndex === index ? 0 : -1}
              onClick={() => activate(index, false)}
              onKeyDown={(event) => handleTabKey(event, index)}
            >
              {panelLabel(panel)}
            </button>
          ))}
        </div>
        {PANELS.map((panel) => (
          <ToolPane
            key={panel}
            kind={panel}
            store={store}
            snapshot={snapshot}
            compact
            hidden={snapshot.activePanel !== panel}
          />
        ))}
      </div>
    </>
  );
}

interface ToolPaneProps {
  readonly kind: EditorPanel;
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
  readonly compact: boolean;
  readonly hidden?: boolean;
  readonly paneRef?: Ref<HTMLElement>;
}

function ToolPane({ kind, store, snapshot, compact, hidden = false, paneRef }: ToolPaneProps) {
  const headingId = `${compact ? 'compact-' : ''}${kind}-heading`;
  const panelId = compact ? `compact-${kind}-panel` : undefined;
  const labelId = compact ? `compact-${kind}-tab` : headingId;
  const active = !compact && snapshot.activePanel === kind;
  return (
    <section
      ref={paneRef}
      id={panelId}
      className={`workspace-pane workspace-pane--${kind}`}
      data-testid={paneTestId(kind)}
      data-active={active ? 'true' : undefined}
      role={compact ? 'tabpanel' : 'region'}
      aria-labelledby={labelId}
      aria-current={active ? 'true' : undefined}
      tabIndex={compact ? undefined : -1}
      hidden={hidden}
      style={hidden ? { display: 'none' } : undefined}
    >
      <h2 id={headingId}>{panelLabel(kind)}</h2>
      <div className="workspace-pane-body">
        {kind === 'hierarchy' && (
          snapshot.session === null
            ? <span className="pane-empty">No document</span>
            : (
                <div className="authoring-surface">
                  <PalettePanel store={store} snapshot={snapshot} />
                  <HierarchyPanel store={store} snapshot={snapshot} />
                </div>
              )
        )}
        {kind === 'inspector' && <span className="pane-empty">{snapshot.selection.length === 0 ? 'Nothing selected' : `${snapshot.selection.length} selected`}</span>}
        {kind === 'diagnostics' && (
          snapshot.diagnostics.length === 0
            ? <span className="pane-empty">No diagnostics</span>
            : <ul className="diagnostic-list">
                {snapshot.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.kind}:${diagnostic.message}:${index}`}>
                    <span className="diagnostic-marker" aria-hidden="true" />
                    <span>{diagnostic.message}</span>
                  </li>
                ))}
              </ul>
        )}
      </div>
    </section>
  );
}

function paneTestId(panel: EditorPanel): string {
  if (panel === 'hierarchy') return 'left-pane';
  if (panel === 'inspector') return 'right-pane';
  return 'bottom-pane';
}

function panelLabel(panel: EditorPanel): string {
  return panel[0].toUpperCase() + panel.slice(1);
}
