import { useRef, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react';
import {
  PANE_LIMITS,
  WORKBENCH_COMMAND_BAR_HEIGHT,
  WORKBENCH_COMPACT_BREAKPOINT,
  WORKBENCH_MIN_CANVAS_WIDTH,
  WORKBENCH_SEPARATOR_SIZE,
} from '../../core/store/EditorLayoutStorage';
import type { EditorPanel, EditorSnapshot, EditorStore } from '../../core/store/EditorStore';
import { CommandBar } from './CommandBar';
import { PaneResizer } from './PaneResizer';
import '../../styles/workbench.css';

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
  const desktopCanvasWidth = snapshot.viewport.width
    - snapshot.panes.left
    - snapshot.panes.right
    - (WORKBENCH_SEPARATOR_SIZE * 2);
  const compact = snapshot.viewport.width <= WORKBENCH_COMPACT_BREAKPOINT
    || desktopCanvasWidth < WORKBENCH_MIN_CANVAS_WIDTH;
  const geometry = getWorkbenchGeometry(snapshot, compact);
  const style: WorkbenchStyle = {
    '--workbench-left-pane': `${snapshot.panes.left}px`,
    '--workbench-right-pane': `${snapshot.panes.right}px`,
    '--workbench-bottom-pane': `${snapshot.panes.bottom}px`,
    '--workbench-commandbar': `${WORKBENCH_COMMAND_BAR_HEIGHT}px`,
    '--workbench-separator': `${WORKBENCH_SEPARATOR_SIZE}px`,
  };

  return (
    <div
      className={`editor-workbench editor-workbench--${compact ? 'compact' : 'desktop'}`}
      style={style}
      role="application"
      aria-label="UXML Editor"
      data-layout-mode={compact ? 'compact' : 'desktop'}
    >
      <CommandBar store={store} snapshot={snapshot} />
      {compact
        ? <CompactWorkspace store={store} snapshot={snapshot} geometry={geometry} />
        : <DesktopWorkspace store={store} snapshot={snapshot} geometry={geometry} />}
    </div>
  );
}

interface WorkspaceProps {
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
  readonly geometry: WorkbenchGeometry;
}

function DesktopWorkspace({ store, snapshot, geometry }: WorkspaceProps) {
  return (
    <>
      <ToolPane kind="hierarchy" snapshot={snapshot} compact={false} geometry={geometry.left} />
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
      <CanvasPane geometry={geometry.canvas} />
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
      <ToolPane kind="inspector" snapshot={snapshot} compact={false} geometry={geometry.right} />
      <ToolPane kind="diagnostics" snapshot={snapshot} compact={false} geometry={geometry.bottom} />
    </>
  );
}

function CompactWorkspace({ store, snapshot, geometry }: WorkspaceProps) {
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
      <CanvasPane geometry={geometry.canvas} />
      <div
        className="compact-tools"
        data-testid="compact-tools"
        data-layout-top={geometry.tools.top}
        data-layout-height={geometry.tools.height}
      >
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
            snapshot={snapshot}
            compact
            hidden={snapshot.activePanel !== panel}
            geometry={geometry.tools}
          />
        ))}
      </div>
    </>
  );
}

interface ToolPaneProps {
  readonly kind: EditorPanel;
  readonly snapshot: EditorSnapshot;
  readonly compact: boolean;
  readonly hidden?: boolean;
  readonly geometry: RegionGeometry;
}

function ToolPane({ kind, snapshot, compact, hidden = false, geometry }: ToolPaneProps) {
  const headingId = `${compact ? 'compact-' : ''}${kind}-heading`;
  const panelId = compact ? `compact-${kind}-panel` : undefined;
  const labelId = compact ? `compact-${kind}-tab` : headingId;
  return (
    <section
      id={panelId}
      className={`workspace-pane workspace-pane--${kind}`}
      data-testid={paneTestId(kind)}
      data-layout-top={geometry.top}
      data-layout-height={geometry.height}
      role={compact ? 'tabpanel' : 'region'}
      aria-labelledby={labelId}
      hidden={hidden}
      style={hidden ? { display: 'none' } : undefined}
    >
      <h2 id={headingId}>{panelLabel(kind)}</h2>
      <div className="workspace-pane-body">
        {kind === 'hierarchy' && <span className="pane-empty">{snapshot.session === null ? 'No document' : snapshot.session.entryPath}</span>}
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

function CanvasPane({ geometry }: { readonly geometry: RegionGeometry }) {
  return (
    <section
      className="workspace-pane workspace-pane--canvas"
      data-testid="canvas-pane"
      data-layout-top={geometry.top}
      data-layout-height={geometry.height}
      data-layout-width={geometry.width}
      aria-labelledby="canvas-heading"
    >
      <h2 id="canvas-heading">Canvas</h2>
      <div className="canvas-field">
        <div className="canvas-surface" />
      </div>
    </section>
  );
}

interface RegionGeometry {
  readonly top: number;
  readonly height: number;
  readonly width: number;
}

interface WorkbenchGeometry {
  readonly left: RegionGeometry;
  readonly canvas: RegionGeometry;
  readonly right: RegionGeometry;
  readonly bottom: RegionGeometry;
  readonly tools: RegionGeometry;
}

function getWorkbenchGeometry(snapshot: EditorSnapshot, compact: boolean): WorkbenchGeometry {
  const { width, height } = snapshot.viewport;
  if (compact) {
    const canvasHeight = Math.max(0, height - WORKBENCH_COMMAND_BAR_HEIGHT - snapshot.panes.bottom);
    return Object.freeze({
      left: region(WORKBENCH_COMMAND_BAR_HEIGHT + canvasHeight, snapshot.panes.bottom, width),
      canvas: region(WORKBENCH_COMMAND_BAR_HEIGHT, canvasHeight, width),
      right: region(WORKBENCH_COMMAND_BAR_HEIGHT + canvasHeight, snapshot.panes.bottom, width),
      bottom: region(WORKBENCH_COMMAND_BAR_HEIGHT + canvasHeight, snapshot.panes.bottom, width),
      tools: region(WORKBENCH_COMMAND_BAR_HEIGHT + canvasHeight, snapshot.panes.bottom, width),
    });
  }
  const canvasWidth = Math.max(0, width - snapshot.panes.left - snapshot.panes.right - (WORKBENCH_SEPARATOR_SIZE * 2));
  const canvasHeight = Math.max(0, height - WORKBENCH_COMMAND_BAR_HEIGHT - snapshot.panes.bottom - WORKBENCH_SEPARATOR_SIZE);
  return Object.freeze({
    left: region(WORKBENCH_COMMAND_BAR_HEIGHT, canvasHeight, snapshot.panes.left),
    canvas: region(WORKBENCH_COMMAND_BAR_HEIGHT, canvasHeight, canvasWidth),
    right: region(WORKBENCH_COMMAND_BAR_HEIGHT, canvasHeight, snapshot.panes.right),
    bottom: region(height - snapshot.panes.bottom, snapshot.panes.bottom, width),
    tools: region(height - snapshot.panes.bottom, snapshot.panes.bottom, width),
  });
}

function region(top: number, height: number, width: number): RegionGeometry {
  return Object.freeze({ top, height, width });
}

function paneTestId(panel: EditorPanel): string {
  if (panel === 'hierarchy') return 'left-pane';
  if (panel === 'inspector') return 'right-pane';
  return 'bottom-pane';
}

function panelLabel(panel: EditorPanel): string {
  return panel[0].toUpperCase() + panel.slice(1);
}
