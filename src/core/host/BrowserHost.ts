import {
  HostError,
  fileRevision,
  projectId,
  projectPath,
  snapshotProjectRoot,
  type ConfirmationRequest,
  type ConfirmationResult,
  type Disposable,
  type FileChangeListener,
  type FileReadResult,
  type FileRevision,
  type HostCapabilities,
  type HostPort,
  type MessageRequest,
  type ProjectId,
  type ProjectPath,
  type ProjectRoot,
  type RecentProject,
  type ScheduledCallback,
} from './HostPort';
import { MemoryHost } from './MemoryHost';
import {
  createDefaultBrowserProjectIdentityStore,
  type BrowserProjectIdentityStore,
} from './BrowserProjectIdentityRegistry';

export { IndexedDbBrowserProjectIdentityStore } from './BrowserProjectIdentityRegistry';
export type { BrowserProjectIdentityStore } from './BrowserProjectIdentityRegistry';

export interface BrowserScope {
  readonly showDirectoryPicker?: (options?: BrowserDirectoryPickerOptions) => Promise<BrowserDirectoryHandle>;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly crypto?: Pick<Crypto, 'subtle' | 'randomUUID'>;
  readonly indexedDB?: IDBFactory;
  readonly localStorage?: BrowserStorage;
  readonly confirm?: (message: string) => boolean;
  readonly alert?: (message: string) => void;
  readonly now?: () => number;
}

export interface BrowserDirectoryPickerOptions {
  readonly mode: 'readwrite';
}

export interface BrowserPermissionDescriptor {
  readonly mode: 'readwrite';
}

export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowserWritableFileStream {
  write(text: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface BrowserFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable?(): Promise<BrowserWritableFileStream>;
}

export interface BrowserDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string): Promise<BrowserDirectoryHandle>;
  getFileHandle(name: string): Promise<BrowserFileHandle>;
  queryPermission?(descriptor: BrowserPermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor: BrowserPermissionDescriptor): Promise<PermissionState>;
  isSameEntry?(other: BrowserDirectoryHandle): Promise<boolean>;
}

export interface BrowserHostOptions {
  readonly scope?: BrowserScope;
  readonly fallback?: MemoryHost;
  readonly identityStore?: BrowserProjectIdentityStore;
}

export class BrowserHost implements HostPort {
  readonly capabilities: HostCapabilities;
  private readonly scope: BrowserScope;
  private readonly fallback: MemoryHost;
  private readonly usesFileSystemAccess: boolean;
  private readonly identityStore: BrowserProjectIdentityStore | undefined;
  private readonly storage: BrowserStorage | undefined;
  private readonly grantedRoots = new Map<ProjectId, { readonly root: ProjectRoot; readonly handle: BrowserDirectoryHandle }>();

  constructor(options: BrowserHostOptions = {}) {
    this.scope = options.scope ?? safelyReadGlobalScope();
    this.fallback = options.fallback ?? new MemoryHost({
      projects: [{ id: 'demo', name: 'Demo Project', files: { 'Assets/Main.uxml': '<UXML />\n' } }],
    });
    this.usesFileSystemAccess = typeof this.scope.showDirectoryPicker === 'function';
    this.identityStore = options.identityStore ?? createDefaultBrowserProjectIdentityStore(this.scope);
    this.storage = this.identityStore === undefined ? undefined : safelyReadStorage(this.scope);
    this.capabilities = this.usesFileSystemAccess
      ? Object.freeze({
        mode: 'browser-file-system',
        projectSelection: 'directory-picker',
        atomicReplace: 'best-effort-safe-write',
        watch: 'unsupported',
        appData: this.storage === undefined ? 'unsupported' : 'local-storage',
        dialogs: typeof this.scope.confirm === 'function' && typeof this.scope.alert === 'function'
          ? 'browser'
          : 'unsupported',
      })
      : Object.freeze({
        ...this.fallback.capabilities,
        mode: 'demo-memory',
        projectSelection: 'demo',
      });
  }

  async chooseProject(): Promise<ProjectRoot | null> {
    if (!this.usesFileSystemAccess) return this.fallback.chooseProject();
    try {
      const handle = await this.scope.showDirectoryPicker!({ mode: 'readwrite' });
      if (!isDirectoryHandle(handle)) throw new TypeError('Directory picker returned an invalid handle.');
      await requireReadWritePermission(handle);
      if (this.identityStore === undefined) {
        throw new HostError('identity-failed', 'Durable browser project identity is unavailable.');
      }
      const id = projectId(await this.identityStore.identify(handle));
      const root = snapshotProjectRoot({ id, name: handle.name });
      this.grantedRoots.set(id, { root, handle });
      return snapshotProjectRoot(root);
    } catch (error) {
      if (isNamedError(error, 'AbortError')) return null;
      if (isNamedError(error, 'NotAllowedError')) {
        throw new HostError('permission-denied', 'Read/write access to the project directory was denied.', error);
      }
      if (error instanceof HostError) throw error;
      throw new HostError('selection-failed', 'The browser could not grant a project directory.', error);
    }
  }

  async readText(path: ProjectPath): Promise<FileReadResult> {
    if (!this.usesFileSystemAccess) return this.fallback.readText(path);
    const { normalizedPath, file } = await this.resolveFile(path);
    try {
      const text = await (await file.getFile()).text();
      if (typeof text !== 'string') throw new TypeError('File text result was not a string.');
      return Object.freeze({ path: normalizedPath, text, revision: await this.revisionFor(text) });
    } catch (error) {
      if (error instanceof HostError) throw error;
      if (isNamedError(error, 'NotFoundError')) {
        throw new HostError('not-found', `File does not exist: ${normalizedPath.relativePath}`, error);
      }
      throw new HostError('read-failed', `Could not read file: ${normalizedPath.relativePath}`, error);
    }
  }

  async replaceTextAtomically(path: ProjectPath, expectedRevision: FileRevision, text: string): Promise<FileRevision> {
    if (!this.usesFileSystemAccess) return this.fallback.replaceTextAtomically(path, expectedRevision, text);
    const { normalizedPath, file } = await this.resolveFile(path);
    let writable: BrowserWritableFileStream | undefined;
    try {
      const currentText = await (await file.getFile()).text();
      const currentRevision = await this.revisionFor(currentText);
      if (currentRevision !== expectedRevision) {
        throw new HostError('stale-revision', `File changed before replacement: ${normalizedPath.relativePath}`);
      }
      if (typeof file.createWritable !== 'function') throw unsupported('replaceTextAtomically');
      writable = await file.createWritable();
      await writable.write(text);
      await writable.close();
      writable = undefined;
      const confirmedText = await (await file.getFile()).text();
      if (confirmedText !== text) {
        throw new HostError('replace-failed', `Browser replacement could not be confirmed: ${normalizedPath.relativePath}`);
      }
      return this.revisionFor(confirmedText);
    } catch (error) {
      if (writable?.abort) {
        try { await writable.abort(); } catch { /* The primary replacement failure is authoritative. */ }
      }
      if (error instanceof HostError) throw error;
      if (isNamedError(error, 'NotFoundError')) {
        throw new HostError('not-found', `File does not exist: ${normalizedPath.relativePath}`, error);
      }
      throw new HostError('replace-failed', `Could not replace file: ${normalizedPath.relativePath}`, error);
    }
  }

  async watch(root: ProjectRoot, listener: FileChangeListener): Promise<Disposable> {
    if (!this.usesFileSystemAccess) return this.fallback.watch(root, listener);
    throw unsupported('watch');
  }

  async readRecovery(projectId: ProjectId): Promise<string | null> {
    if (!this.usesFileSystemAccess) return this.fallback.readRecovery(projectId);
    try {
      return this.requireStorage('readRecovery').getItem(recoveryKey(projectId));
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('app-data-failed', 'Browser recovery data could not be read.', error);
    }
  }

  async writeRecovery(projectId: ProjectId, journal: string): Promise<void> {
    if (!this.usesFileSystemAccess) return this.fallback.writeRecovery(projectId, journal);
    try {
      this.requireStorage('writeRecovery').setItem(recoveryKey(projectId), journal);
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('app-data-failed', 'Browser recovery data could not be written.', error);
    }
  }

  async clearRecovery(projectId: ProjectId): Promise<void> {
    if (!this.usesFileSystemAccess) return this.fallback.clearRecovery(projectId);
    try {
      this.requireStorage('clearRecovery').removeItem(recoveryKey(projectId));
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('app-data-failed', 'Browser recovery data could not be cleared.', error);
    }
  }

  async listRecentProjects(): Promise<readonly RecentProject[]> {
    if (!this.usesFileSystemAccess) return this.fallback.listRecentProjects();
    try {
      const stored = this.requireStorage('listRecentProjects').getItem(RECENT_KEY);
      if (stored === null) return Object.freeze([]);
      const value: unknown = JSON.parse(stored);
      if (!Array.isArray(value)) throw new TypeError('Recent project data is not an array.');
      return Object.freeze(value.map(snapshotStoredRecent));
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('app-data-failed', 'Browser recent project data is invalid.', error);
    }
  }

  async rememberRecentProject(root: ProjectRoot): Promise<void> {
    if (!this.usesFileSystemAccess) return this.fallback.rememberRecentProject(root);
    const snapshot = snapshotProjectRoot(root);
    const existing = await this.listRecentProjects();
    const next = [
      { root: snapshot, lastOpenedAt: this.now() },
      ...existing.filter((entry) => entry.root.id !== snapshot.id),
    ];
    try {
      this.requireStorage('rememberRecentProject').setItem(RECENT_KEY, JSON.stringify(next.map((entry) => ({
        id: entry.root.id,
        name: entry.root.name,
        lastOpenedAt: entry.lastOpenedAt,
      }))));
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('app-data-failed', 'Browser recent project data could not be written.', error);
    }
  }

  async confirm(request: ConfirmationRequest): Promise<ConfirmationResult> {
    if (!this.usesFileSystemAccess) return this.fallback.confirm(request);
    const snapshot = snapshotConfirmation(request);
    if (typeof this.scope.confirm !== 'function') throw unsupported('confirm');
    try {
      return Object.freeze({ confirmed: this.scope.confirm(`${snapshot.title}\n\n${snapshot.message}`) });
    } catch (error) {
      throw new HostError('dialog-failed', 'The browser confirmation dialog failed.', error);
    }
  }

  async showMessage(request: MessageRequest): Promise<void> {
    if (!this.usesFileSystemAccess) return this.fallback.showMessage(request);
    const snapshot = snapshotMessage(request);
    if (typeof this.scope.alert !== 'function') throw unsupported('showMessage');
    try {
      this.scope.alert(`${snapshot.title}\n\n${snapshot.message}`);
    } catch (error) {
      throw new HostError('dialog-failed', 'The browser message dialog failed.', error);
    }
  }

  now(): number {
    return this.usesFileSystemAccess ? (this.scope.now?.() ?? Date.now()) : this.fallback.now();
  }

  schedule(delayMs: number, callback: ScheduledCallback): Disposable {
    if (!this.usesFileSystemAccess) return this.fallback.schedule(delayMs, callback);
    const setTimer = this.scope.setTimeout;
    const clearTimer = this.scope.clearTimeout;
    if (!setTimer || !clearTimer) throw unsupported('schedule');
    const handle = setTimer(() => { void callback(); }, delayMs);
    return Object.freeze({ dispose: () => { clearTimer(handle); } });
  }

  private async resolveFile(path: ProjectPath): Promise<{ readonly normalizedPath: ProjectPath; readonly file: BrowserFileHandle }> {
    const grant = this.grantedRoots.get(path.projectId);
    if (!grant) throw new HostError('root-not-granted', `Project root is not granted: ${path.projectId}`);
    const normalizedPath = projectPath(grant.root, path.relativePath);
    const segments = normalizedPath.relativePath.split('/');
    try {
      let directory = grant.handle;
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment);
      }
      const file = await directory.getFileHandle(segments.at(-1)!);
      if (!isFileHandle(file)) throw new TypeError('Project path did not resolve to a file handle.');
      return Object.freeze({ normalizedPath, file });
    } catch (error) {
      if (isNamedError(error, 'NotFoundError')) {
        throw new HostError('not-found', `File does not exist: ${normalizedPath.relativePath}`, error);
      }
      throw new HostError('read-failed', `Could not resolve file: ${normalizedPath.relativePath}`, error);
    }
  }

  private async revisionFor(text: string): Promise<FileRevision> {
    const subtle = this.scope.crypto?.subtle;
    if (subtle && typeof TextEncoder !== 'undefined') {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
      const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return fileRevision(`browser:v1:sha256:${hex}`);
    }
    return fileRevision(`browser:v1:exact:${JSON.stringify(text)}`);
  }

  private requireStorage(operation: string): BrowserStorage {
    if (!this.storage) throw unsupported(operation);
    return this.storage;
  }
}

const RECENT_KEY = 'uxml-editor:v1:recent-projects';

function recoveryKey(projectId: ProjectId): string {
  return `uxml-editor:v1:recovery:${encodeURIComponent(projectId)}`;
}

function safelyReadGlobalScope(): BrowserScope {
  return typeof globalThis === 'object' && globalThis !== null
    ? globalThis as BrowserScope
    : {};
}

async function requireReadWritePermission(handle: BrowserDirectoryHandle): Promise<void> {
  const descriptor = Object.freeze({ mode: 'readwrite' as const });
  if (typeof handle.queryPermission !== 'function' || typeof handle.requestPermission !== 'function') {
    throw new HostError('permission-denied', 'The browser cannot verify read/write project permission.');
  }
  try {
    if (await handle.queryPermission(descriptor) === 'granted') return;
    if (await handle.requestPermission(descriptor) === 'granted') return;
  } catch (error) {
    throw new HostError('permission-denied', 'Read/write access to the project directory could not be verified.', error);
  }
  throw new HostError('permission-denied', 'Read/write access to the project directory was denied.');
}

function unsupported(operation: string): HostError {
  return new HostError('unsupported', `Browser host capability is unavailable: ${operation}`);
}

function isDirectoryHandle(candidate: unknown): candidate is BrowserDirectoryHandle {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const handle = candidate as BrowserDirectoryHandle;
  return handle.kind === 'directory' && typeof handle.name === 'string'
    && typeof handle.getDirectoryHandle === 'function' && typeof handle.getFileHandle === 'function';
}

function isFileHandle(candidate: unknown): candidate is BrowserFileHandle {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const handle = candidate as BrowserFileHandle;
  return handle.kind === 'file' && typeof handle.name === 'string' && typeof handle.getFile === 'function';
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name;
}

function safelyReadStorage(scope: BrowserScope): BrowserStorage | undefined {
  try {
    const storage = scope.localStorage;
    return storage !== undefined
      && typeof storage.getItem === 'function'
      && typeof storage.setItem === 'function'
      && typeof storage.removeItem === 'function'
      ? storage
      : undefined;
  } catch {
    return undefined;
  }
}

function snapshotStoredRecent(value: unknown): RecentProject {
  if (typeof value !== 'object' || value === null) throw new TypeError('Recent project entry is invalid.');
  const entry = value as { id?: unknown; name?: unknown; lastOpenedAt?: unknown };
  if (typeof entry.id !== 'string' || entry.id.length === 0
    || typeof entry.name !== 'string' || entry.name.length === 0
    || typeof entry.lastOpenedAt !== 'number' || !Number.isFinite(entry.lastOpenedAt)) {
    throw new TypeError('Recent project entry is invalid.');
  }
  return Object.freeze({
    root: snapshotProjectRoot({ id: projectId(entry.id), name: entry.name }),
    lastOpenedAt: entry.lastOpenedAt,
  });
}

function snapshotConfirmation(request: ConfirmationRequest): ConfirmationRequest {
  return Object.freeze({
    kind: request.kind,
    title: request.title,
    message: request.message,
    confirmLabel: request.confirmLabel,
    cancelLabel: request.cancelLabel,
  });
}

function snapshotMessage(request: MessageRequest): MessageRequest {
  return Object.freeze({ kind: request.kind, title: request.title, message: request.message });
}
