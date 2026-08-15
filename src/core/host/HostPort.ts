declare const projectIdBrand: unique symbol;
declare const projectPathBrand: unique symbol;
declare const fileRevisionBrand: unique symbol;
const projectGrantGeneration = Symbol('projectGrantGeneration');

export type ProjectId = string & { readonly [projectIdBrand]: true };
export type ProjectPath = Readonly<{
  projectId: ProjectId;
  relativePath: string;
  readonly [projectPathBrand]?: true;
  readonly [projectGrantGeneration]?: string;
}>;
export type FileRevision = string & { readonly [fileRevisionBrand]: true };

export interface ProjectRoot {
  readonly id: ProjectId;
  readonly name: string;
  readonly [projectGrantGeneration]?: string;
}

export interface FileReadResult {
  readonly path: ProjectPath;
  readonly text: string;
  readonly revision: FileRevision;
}

export type FileEnumerationResult =
  | Readonly<{ readonly status: 'supported'; readonly files: readonly ProjectPath[] }>
  | Readonly<{ readonly status: 'unsupported' }>;

export interface RecentProject {
  readonly root: ProjectRoot;
  readonly lastOpenedAt: number;
}

export interface ConfirmationRequest {
  readonly kind: 'discard-changes' | 'external-change' | 'overwrite';
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

export interface ConfirmationResult {
  readonly confirmed: boolean;
}

export interface MessageRequest {
  readonly kind: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly message: string;
}

export interface HostCapabilities {
  readonly mode: 'memory' | 'browser-file-system' | 'demo-memory' | 'tauri';
  readonly projectSelection: 'deterministic' | 'directory-picker' | 'demo';
  readonly atomicReplace: 'guaranteed' | 'best-effort-safe-write' | 'unsupported';
  readonly watch: 'deterministic' | 'native-revision-aware' | 'unsupported';
  readonly appData: 'memory' | 'local-storage' | 'app-data' | 'unsupported';
  readonly dialogs: 'deterministic' | 'browser' | 'native' | 'unsupported';
}

export type FileChangeEvent =
  | Readonly<{ readonly kind: 'changed'; readonly path: ProjectPath; readonly revision: FileRevision }>
  | Readonly<{ readonly kind: 'deleted'; readonly path: ProjectPath }>
  | Readonly<{ readonly kind: 'rescan-required'; readonly root: ProjectRoot }>;

export type FileChangeListener = (event: FileChangeEvent) => void | Promise<void>;
export type ScheduledCallback = () => void | Promise<void>;

export interface Disposable {
  dispose(): void;
  readonly completion?: Promise<DisposalOutcome>;
}

export type DisposalOutcome =
  | Readonly<{ readonly status: 'disposed' }>
  | Readonly<{ readonly status: 'failed'; readonly error: HostError }>;

export interface HostPort {
  readonly capabilities: HostCapabilities;
  chooseProject(): Promise<ProjectRoot | null>;
  enumerateFiles(root: ProjectRoot): Promise<FileEnumerationResult>;
  readText(path: ProjectPath): Promise<FileReadResult>;
  createText(path: ProjectPath, text: string): Promise<FileRevision>;
  replaceTextAtomically(path: ProjectPath, expectedRevision: FileRevision, text: string): Promise<FileRevision>;
  watch(root: ProjectRoot, listener: FileChangeListener): Promise<Disposable>;
  readRecovery(projectId: ProjectId): Promise<string | null>;
  writeRecovery(projectId: ProjectId, journal: string): Promise<void>;
  clearRecovery(projectId: ProjectId): Promise<void>;
  listRecentProjects(): Promise<readonly RecentProject[]>;
  rememberRecentProject(root: ProjectRoot): Promise<void>;
  confirm(request: ConfirmationRequest): Promise<ConfirmationResult>;
  showMessage(request: MessageRequest): Promise<void>;
  now(): number;
  schedule(delayMs: number, callback: ScheduledCallback): Disposable;
}

export type HostErrorCode =
  | 'invalid-path'
  | 'root-not-granted'
  | 'not-found'
  | 'stale-revision'
  | 'replace-failed'
  | 'read-failed'
  | 'selection-failed'
  | 'permission-denied'
  | 'identity-failed'
  | 'app-data-failed'
  | 'dialog-failed'
  | 'unsupported';

export class HostError extends Error {
  constructor(readonly code: HostErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'HostError';
  }
}

export function projectPath(root: ProjectRoot, candidate: string): ProjectPath {
  if (!isProjectRoot(root) || typeof candidate !== 'string') {
    throw new HostError('invalid-path', 'A project path requires a valid project root and text path.');
  }
  const relativePath = normalizeRelativePath(candidate);
  const path: { projectId: ProjectId; relativePath: string; [projectGrantGeneration]?: string } = {
    projectId: root.id,
    relativePath,
  };
  copyProjectGrantGeneration(root, path);
  return Object.freeze(path);
}

export function normalizeRelativePath(candidate: string): string {
  const normalized = candidate.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized) || normalized.includes('\0')) {
    throw new HostError('invalid-path', `Path is outside the granted project root: ${candidate}`);
  }
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new HostError('invalid-path', `Path escapes the granted project root: ${candidate}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new HostError('invalid-path', 'A project file path cannot resolve to the project root.');
  }
  return segments.join('/');
}

export function projectId(value: string): ProjectId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostError('root-not-granted', 'A project root requires a nonempty id.');
  }
  return value as ProjectId;
}

export function fileRevision(value: string): FileRevision {
  return value as FileRevision;
}

export function snapshotProjectRoot(root: ProjectRoot, generation?: string): ProjectRoot {
  if (!isProjectRoot(root)) {
    throw new HostError('root-not-granted', 'The project root is invalid.');
  }
  const snapshot: { id: ProjectId; name: string; [projectGrantGeneration]?: string } = {
    id: projectId(root.id),
    name: root.name,
  };
  copyProjectGrantGeneration(root, snapshot, generation);
  return Object.freeze(snapshot);
}

export function projectGrantGenerationOf(candidate: ProjectRoot | ProjectPath): string | undefined {
  return candidate[projectGrantGeneration];
}

function copyProjectGrantGeneration(
  source: ProjectRoot | ProjectPath,
  target: { [projectGrantGeneration]?: string },
  override?: string,
): void {
  const generation = override ?? source[projectGrantGeneration];
  if (generation === undefined) return;
  Object.defineProperty(target, projectGrantGeneration, {
    configurable: false,
    enumerable: false,
    value: generation,
    writable: false,
  });
}

function isProjectRoot(candidate: unknown): candidate is ProjectRoot {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const root = candidate as ProjectRoot;
  return typeof root.id === 'string' && root.id.length > 0
    && typeof root.name === 'string' && root.name.length > 0;
}
