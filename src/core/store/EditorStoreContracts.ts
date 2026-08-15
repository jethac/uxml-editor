import type { EditorDiagnostic, EditorDiagnosticKind, EditorNodeId } from '../adapter/types';
import type { DocumentSession } from '../documents/DocumentSession';
import type { HostPort } from '../host/HostPort';
import type {
  EditorLayoutStorage,
  EditorViewport,
  PaneDimensions,
  PaneName,
} from './EditorLayoutStorage';

export type EditorTool = 'select' | 'pan';
export type EditorPanel = 'hierarchy' | 'inspector' | 'diagnostics';
export type PreviewState = 'edit' | 'preview';

export interface EditorCommandAvailability {
  readonly openProject: boolean;
  readonly undo: boolean;
  readonly redo: boolean;
  readonly zoomIn: boolean;
  readonly zoomOut: boolean;
}

export interface EditorSnapshot {
  readonly session: DocumentSession | null;
  readonly host: HostPort | null;
  readonly selection: readonly EditorNodeId[];
  readonly diagnostics: readonly EditorDiagnostic[];
  readonly viewport: EditorViewport;
  readonly panes: PaneDimensions;
  readonly activeTool: EditorTool;
  readonly activePanel: EditorPanel;
  readonly zoom: number;
  readonly previewState: PreviewState;
  readonly commands: EditorCommandAvailability;
}

export type EditorAction =
  | Readonly<{ type: 'context/set'; session: DocumentSession | null; host: HostPort | null }>
  | Readonly<{ type: 'session/sync' }>
  | Readonly<{ type: 'selection/set'; selection: readonly EditorNodeId[] }>
  | Readonly<{ type: 'diagnostics/set'; diagnostics: readonly EditorDiagnostic[] }>
  | Readonly<{ type: 'viewport/set'; width: number; height: number }>
  | Readonly<{ type: 'panes/resize'; pane: PaneName; size: number; persist: boolean }>
  | Readonly<{ type: 'tool/set'; tool: EditorTool }>
  | Readonly<{ type: 'panel/set'; panel: EditorPanel }>
  | Readonly<{ type: 'zoom/set'; zoom: number }>
  | Readonly<{ type: 'preview/set'; state: PreviewState }>
  | Readonly<{ type: 'command/open-project' }>
  | Readonly<{ type: 'command/undo' }>
  | Readonly<{ type: 'command/redo' }>
  | Readonly<{ type: 'command/zoom-in' }>
  | Readonly<{ type: 'command/zoom-out' }>;

export interface EditorStoreOptions {
  readonly session?: DocumentSession | null;
  readonly host?: HostPort | null;
  readonly storage?: EditorLayoutStorage | null;
  readonly viewport?: EditorViewport;
}

export type EditorStoreErrorCode = 'invalid-action' | 'invalid-options';

export class EditorStoreError extends Error {
  constructor(readonly code: EditorStoreErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'EditorStoreError';
  }
}

export function normalizeEditorAction(candidate: EditorAction): EditorAction {
  try {
    if (!isRecord(candidate) || typeof candidate.type !== 'string') return invalidAction();
    switch (candidate.type) {
      case 'context/set': {
        const session = candidate.session as DocumentSession | null;
        const host = candidate.host as HostPort | null;
        validateEditorContext(session, host, 'invalid-action');
        return Object.freeze({ type: candidate.type, session, host });
      }
      case 'session/sync':
      case 'command/open-project':
      case 'command/undo':
      case 'command/redo':
      case 'command/zoom-in':
      case 'command/zoom-out':
        return Object.freeze({ type: candidate.type });
      case 'selection/set':
        return Object.freeze({ type: candidate.type, selection: copyEditorSelection(candidate.selection) });
      case 'diagnostics/set':
        return Object.freeze({ type: candidate.type, diagnostics: copyEditorDiagnostics(candidate.diagnostics) });
      case 'viewport/set': {
        const viewport = normalizeEditorViewport({ width: candidate.width, height: candidate.height }, 'invalid-action');
        return Object.freeze({ type: candidate.type, ...viewport });
      }
      case 'panes/resize':
        if (!isPaneName(candidate.pane) || !isFiniteNumber(candidate.size) || typeof candidate.persist !== 'boolean') {
          return invalidAction();
        }
        return Object.freeze({ type: candidate.type, pane: candidate.pane, size: candidate.size, persist: candidate.persist });
      case 'tool/set':
        if (!isEditorTool(candidate.tool)) return invalidAction();
        return Object.freeze({ type: candidate.type, tool: candidate.tool });
      case 'panel/set':
        if (!isEditorPanel(candidate.panel)) return invalidAction();
        return Object.freeze({ type: candidate.type, panel: candidate.panel });
      case 'zoom/set':
        if (!isFiniteNumber(candidate.zoom)) return invalidAction();
        return Object.freeze({ type: candidate.type, zoom: candidate.zoom });
      case 'preview/set':
        if (!isPreviewState(candidate.state)) return invalidAction();
        return Object.freeze({ type: candidate.type, state: candidate.state });
      default:
        return invalidAction();
    }
  } catch (error) {
    if (error instanceof EditorStoreError) throw error;
    throw new EditorStoreError('invalid-action', 'Editor action could not be snapshotted.', error);
  }
}

export function normalizeEditorViewport(
  viewport: EditorViewport,
  code: EditorStoreErrorCode,
): EditorViewport {
  if (!isFiniteNumber(viewport.width) || viewport.width <= 0 || !isFiniteNumber(viewport.height) || viewport.height <= 0) {
    throw new EditorStoreError(code, 'Editor viewport requires positive finite dimensions.');
  }
  return Object.freeze({ width: viewport.width, height: viewport.height });
}

export function validateEditorContext(
  session: DocumentSession | null,
  host: HostPort | null,
  code: EditorStoreErrorCode,
): void {
  if (session !== null && !isDocumentSession(session)) {
    throw new EditorStoreError(code, 'Editor context session must be a DocumentSession or null.');
  }
  if (host !== null && !isHostPort(host)) {
    throw new EditorStoreError(code, 'Editor context host must implement HostPort or be null.');
  }
}

export function copyEditorSelection(candidate: unknown): readonly EditorNodeId[] {
  if (!Array.isArray(candidate) || !candidate.every((nodeId) => typeof nodeId === 'string' && nodeId.length > 0)) {
    return invalidAction('Editor selection must contain nonempty node ids.');
  }
  return Object.freeze([...candidate]) as readonly EditorNodeId[];
}

export function copyEditorDiagnostics(candidate: unknown): readonly EditorDiagnostic[] {
  if (!Array.isArray(candidate)) return invalidAction('Editor diagnostics must be an array.');
  try {
    return Object.freeze(candidate.map((value) => copyDiagnostic(value)));
  } catch (error) {
    if (error instanceof EditorStoreError) throw error;
    throw new EditorStoreError('invalid-action', 'Editor diagnostics could not be snapshotted.', error);
  }
}

export function emptyEditorSelection(): readonly EditorNodeId[] {
  return Object.freeze([]);
}

export function emptyEditorDiagnostics(): readonly EditorDiagnostic[] {
  return Object.freeze([]);
}

export function equalEditorSelection(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function equalEditorDiagnostics(
  left: readonly EditorDiagnostic[],
  right: readonly EditorDiagnostic[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return value.origin === other.origin
      && value.severity === other.severity
      && value.kind === other.kind
      && value.message === other.message
      && value.nodeId === other.nodeId
      && value.source?.path === other.source?.path
      && value.source?.start === other.source?.start
      && value.source?.end === other.source?.end;
  });
}

function copyDiagnostic(candidate: unknown): EditorDiagnostic {
  if (!isRecord(candidate)
    || (candidate.origin !== 'parse' && candidate.origin !== 'render')
    || candidate.severity !== 'warning'
    || !isDiagnosticKind(candidate.kind)
    || typeof candidate.message !== 'string') {
    return invalidAction('Editor diagnostic is malformed.');
  }
  if (candidate.nodeId !== undefined && (typeof candidate.nodeId !== 'string' || candidate.nodeId.length === 0)) {
    return invalidAction('Editor diagnostic node id is malformed.');
  }
  const source = candidate.source === undefined ? undefined : copySourceSpan(candidate.source);
  return Object.freeze({
    origin: candidate.origin,
    severity: candidate.severity,
    kind: candidate.kind,
    message: candidate.message,
    ...(source === undefined ? {} : { source }),
    ...(candidate.nodeId === undefined ? {} : { nodeId: candidate.nodeId as EditorNodeId }),
  });
}

function copySourceSpan(candidate: unknown): Readonly<{ path: string; start: number; end: number }> {
  if (!isRecord(candidate)
    || typeof candidate.path !== 'string'
    || candidate.path.length === 0
    || !Number.isInteger(candidate.start)
    || !Number.isInteger(candidate.end)
    || (candidate.start as number) < 0
    || (candidate.end as number) < (candidate.start as number)) {
    return invalidAction('Editor diagnostic source span is malformed.');
  }
  return Object.freeze({ path: candidate.path, start: candidate.start as number, end: candidate.end as number });
}

function isDocumentSession(candidate: unknown): candidate is DocumentSession {
  const history = isRecord(candidate) ? candidate.history : null;
  return isRecord(candidate)
    && typeof candidate.entryPath === 'string'
    && typeof candidate.snapshot === 'function'
    && typeof candidate.setSelection === 'function'
    && isRecord(history)
    && typeof history.canUndo === 'boolean'
    && typeof history.canRedo === 'boolean'
    && typeof history.undo === 'function'
    && typeof history.redo === 'function';
}

function isHostPort(candidate: unknown): candidate is HostPort {
  return isRecord(candidate)
    && isRecord(candidate.capabilities)
    && typeof candidate.chooseProject === 'function';
}

function isPaneName(value: unknown): value is PaneName {
  return value === 'left' || value === 'right' || value === 'bottom';
}

function isEditorTool(value: unknown): value is EditorTool {
  return value === 'select' || value === 'pan';
}

function isEditorPanel(value: unknown): value is EditorPanel {
  return value === 'hierarchy' || value === 'inspector' || value === 'diagnostics';
}

function isPreviewState(value: unknown): value is PreviewState {
  return value === 'edit' || value === 'preview';
}

function isDiagnosticKind(value: unknown): value is EditorDiagnosticKind {
  return value === 'unsupported-control'
    || value === 'unsupported-property'
    || value === 'unsupported-selector'
    || value === 'unsupported-unit'
    || value === 'version-dependent'
    || value === 'asset-unresolved'
    || value === 'import-unresolved'
    || value === 'malformed';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalidAction(message = 'Editor action is malformed.'): never {
  throw new EditorStoreError('invalid-action', message);
}
