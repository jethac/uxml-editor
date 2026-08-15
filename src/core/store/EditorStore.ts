import type { DocumentSession } from '../documents/DocumentSession';
import type { HostPort } from '../host/HostPort';
import {
  DEFAULT_VIEWPORT,
  clampPaneDimension,
  freezePaneDimensions,
  persistPaneDimensions,
  restorePaneDimensions,
  type EditorLayoutStorage,
} from './EditorLayoutStorage';
import {
  copyEditorDiagnostics,
  copyEditorSelection,
  emptyEditorDiagnostics,
  emptyEditorSelection,
  equalEditorDiagnostics,
  equalEditorSelection,
  normalizeEditorAction,
  normalizeEditorViewport,
  validateEditorContext,
  EditorStoreError,
  type EditorAction,
  type EditorCommandAvailability,
  type EditorSnapshot,
  type EditorStoreOptions,
} from './EditorStoreContracts';

export {
  EditorStoreError,
  type EditorAction,
  type EditorCommandAvailability,
  type EditorPanel,
  type EditorSnapshot,
  type EditorStoreErrorCode,
  type EditorStoreOptions,
  type EditorTool,
  type PreviewState,
} from './EditorStoreContracts';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.1;

export class EditorStore {
  private readonly listeners = new Set<() => void>();
  private readonly pendingActions: EditorAction[] = [];
  private readonly storage: EditorLayoutStorage | null;
  private snapshot: EditorSnapshot;
  private dispatching = false;

  constructor(options: EditorStoreOptions = {}) {
    const viewport = normalizeEditorViewport(options.viewport ?? DEFAULT_VIEWPORT, 'invalid-options');
    const session = options.session ?? null;
    const host = options.host ?? null;
    validateEditorContext(session, host, 'invalid-options');
    this.storage = options.storage ?? null;
    this.snapshot = createSnapshot({
      session,
      host,
      selection: session === null ? emptyEditorSelection() : copyEditorSelection(session.selectedNodeIds),
      diagnostics: session === null ? emptyEditorDiagnostics() : copyEditorDiagnostics(session.diagnostics),
      viewport,
      panes: restorePaneDimensions(this.storage),
      activeTool: 'select',
      activePanel: 'hierarchy',
      zoom: 1,
      previewState: 'edit',
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (typeof listener !== 'function') {
      throw new EditorStoreError('invalid-action', 'EditorStore.subscribe requires a listener function.');
    }
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): EditorSnapshot => this.snapshot;

  readonly dispatch = (candidate: EditorAction): void => {
    this.pendingActions.push(normalizeEditorAction(candidate));
    if (this.dispatching) return;

    this.dispatching = true;
    let listenerError: unknown;
    try {
      while (this.pendingActions.length > 0) {
        const action = this.pendingActions.shift()!;
        const next = this.reduce(action);
        if (next === this.snapshot) continue;
        this.snapshot = next;
        for (const listener of [...this.listeners]) {
          try {
            listener();
          } catch (error) {
            listenerError ??= error;
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
    if (listenerError !== undefined) throw listenerError;
  };

  private reduce(action: EditorAction): EditorSnapshot {
    switch (action.type) {
      case 'context/set':
        return this.withContext(action.session, action.host);
      case 'session/sync':
        return this.syncSession();
      case 'selection/set':
        return equalEditorSelection(this.snapshot.selection, action.selection)
          ? this.snapshot
          : this.replace({ selection: action.selection });
      case 'diagnostics/set':
        return equalEditorDiagnostics(this.snapshot.diagnostics, action.diagnostics)
          ? this.snapshot
          : this.replace({ diagnostics: action.diagnostics });
      case 'viewport/set':
        return this.withViewport(action.width, action.height);
      case 'panes/resize':
        return this.withPaneSize(action.pane, action.size, action.persist);
      case 'tool/set':
        return action.tool === this.snapshot.activeTool ? this.snapshot : this.replace({ activeTool: action.tool });
      case 'panel/set':
        return action.panel === this.snapshot.activePanel ? this.snapshot : this.replace({ activePanel: action.panel });
      case 'zoom/set':
        return this.withZoom(action.zoom);
      case 'preview/set':
        return action.state === this.snapshot.previewState ? this.snapshot : this.replace({ previewState: action.state });
      case 'command/open-project':
        this.openProject();
        return this.snapshot;
      case 'command/undo':
        return this.replayHistory('undo');
      case 'command/redo':
        return this.replayHistory('redo');
      case 'command/zoom-in':
        return this.withZoom(this.snapshot.zoom + ZOOM_STEP);
      case 'command/zoom-out':
        return this.withZoom(this.snapshot.zoom - ZOOM_STEP);
    }
  }

  private withContext(session: DocumentSession | null, host: HostPort | null): EditorSnapshot {
    const selection = session === null ? emptyEditorSelection() : copyEditorSelection(session.selectedNodeIds);
    const diagnostics = session === null ? emptyEditorDiagnostics() : copyEditorDiagnostics(session.diagnostics);
    if (
      session === this.snapshot.session
      && host === this.snapshot.host
      && equalEditorSelection(selection, this.snapshot.selection)
      && equalEditorDiagnostics(diagnostics, this.snapshot.diagnostics)
    ) {
      return this.snapshot;
    }
    return this.replace({ session, host, selection, diagnostics });
  }

  private syncSession(): EditorSnapshot {
    const session = this.snapshot.session;
    if (session === null) return this.snapshot;
    const selection = copyEditorSelection(session.selectedNodeIds);
    const diagnostics = copyEditorDiagnostics(session.diagnostics);
    const commands = commandAvailability(this.snapshot.host, session, this.snapshot.zoom);
    if (
      equalEditorSelection(selection, this.snapshot.selection)
      && equalEditorDiagnostics(diagnostics, this.snapshot.diagnostics)
      && equalCommands(commands, this.snapshot.commands)
    ) {
      return this.snapshot;
    }
    return createSnapshot({ ...this.snapshot, selection, diagnostics });
  }

  private withViewport(width: number, height: number): EditorSnapshot {
    return this.snapshot.viewport.width === width && this.snapshot.viewport.height === height
      ? this.snapshot
      : this.replace({ viewport: Object.freeze({ width, height }) });
  }

  private withPaneSize(pane: 'left' | 'right' | 'bottom', candidate: number, persist: boolean): EditorSnapshot {
    const size = clampPaneDimension(pane, candidate);
    const panes = this.snapshot.panes[pane] === size
      ? this.snapshot.panes
      : freezePaneDimensions({ ...this.snapshot.panes, [pane]: size });
    if (persist) persistPaneDimensions(this.storage, panes);
    return panes === this.snapshot.panes ? this.snapshot : this.replace({ panes });
  }

  private replayHistory(command: 'undo' | 'redo'): EditorSnapshot {
    if (!this.snapshot.commands[command]) return this.snapshot;
    this.snapshot.session!.history[command]();
    return this.syncSession();
  }

  private withZoom(candidate: number): EditorSnapshot {
    const zoom = roundZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, candidate)));
    return zoom === this.snapshot.zoom ? this.snapshot : this.replace({ zoom });
  }

  private replace(changes: Partial<EditorSnapshot>): EditorSnapshot {
    return createSnapshot({ ...this.snapshot, ...changes });
  }

  private openProject(): void {
    const host = this.snapshot.host;
    if (host === null) return;
    try {
      void host.chooseProject().catch(() => undefined);
    } catch {
      // Host failures are surfaced by the project-opening workflow, not layout state.
    }
  }
}

function createSnapshot(state: Omit<EditorSnapshot, 'commands'> | EditorSnapshot): EditorSnapshot {
  return Object.freeze({
    session: state.session,
    host: state.host,
    selection: state.selection,
    diagnostics: state.diagnostics,
    viewport: state.viewport,
    panes: state.panes,
    activeTool: state.activeTool,
    activePanel: state.activePanel,
    zoom: state.zoom,
    previewState: state.previewState,
    commands: commandAvailability(state.host, state.session, state.zoom),
  });
}

function commandAvailability(
  host: HostPort | null,
  session: DocumentSession | null,
  zoom: number,
): EditorCommandAvailability {
  return Object.freeze({
    openProject: host !== null,
    undo: session?.history.canUndo ?? false,
    redo: session?.history.canRedo ?? false,
    zoomIn: zoom < ZOOM_MAX,
    zoomOut: zoom > ZOOM_MIN,
  });
}

function equalCommands(left: EditorCommandAvailability, right: EditorCommandAvailability): boolean {
  return left.openProject === right.openProject
    && left.undo === right.undo
    && left.redo === right.redo
    && left.zoomIn === right.zoomIn
    && left.zoomOut === right.zoomOut;
}

function roundZoom(value: number): number {
  return Math.round(value * 100) / 100;
}
