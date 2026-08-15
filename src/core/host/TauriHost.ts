import {
  HostError,
  fileRevision,
  normalizeRelativePath,
  projectId,
  projectPath,
  snapshotProjectRoot,
  type ConfirmationRequest,
  type ConfirmationResult,
  type Disposable,
  type FileChangeListener,
  type FileChangeEvent,
  type FileEnumerationResult,
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

export interface TauriEvent<T> {
  readonly payload: T;
}

export interface TauriTimerPorts {
  now(): number;
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TauriHostPorts {
  readonly invoke: (command: string, payload?: unknown) => Promise<unknown>;
  readonly listen: (
    event: string,
    listener: (event: TauriEvent<unknown>) => void | Promise<void>,
  ) => Promise<() => void>;
  readonly timers: TauriTimerPorts;
}

export class TauriHost implements HostPort {
  readonly capabilities: HostCapabilities = Object.freeze({
    mode: 'tauri',
    projectSelection: 'directory-picker',
    atomicReplace: 'guaranteed',
    watch: 'native-revision-aware',
    appData: 'app-data',
    dialogs: 'native',
  });
  private readonly grants = new Map<ProjectId, ProjectRoot>();

  constructor(private readonly ports: TauriHostPorts) {}

  async chooseProject(): Promise<ProjectRoot | null> {
    const result = await this.invoke('host_choose_project', undefined, 'selection-failed');
    if (result === null) return null;
    if (!isExactRecord(result, ['projectId', 'displayName'])
      || !isNonemptyString(result.projectId)
      || !isNonemptyString(result.displayName)) {
      throw malformed('selection-failed', 'Project selection returned a malformed result.');
    }
    const root = snapshotProjectRoot({ id: projectId(result.projectId), name: result.displayName });
    this.grants.clear();
    this.grants.set(root.id, root);
    return snapshotProjectRoot(root);
  }

  async enumerateFiles(root: ProjectRoot): Promise<FileEnumerationResult> {
    const grant = this.requireRoot(root);
    const result = await this.invoke(
      'host_enumerate_files',
      request({ projectId: grant.id }),
      'read-failed',
    );
    if (!isExactRecord(result, ['relativePaths']) || !Array.isArray(result.relativePaths)) {
      throw malformed('read-failed', 'File enumeration returned a malformed result.');
    }
    const paths: ProjectPath[] = [];
    const seen = new Set<string>();
    for (const value of result.relativePaths) {
      if (typeof value !== 'string') throw malformed('read-failed', 'File enumeration returned a non-text path.');
      const normalized = strictNormalizedPath(value, 'read-failed');
      const collisionKey = normalized.toLocaleLowerCase('en-US');
      if (seen.has(collisionKey)) {
        throw malformed('read-failed', `File enumeration returned a duplicate or case-colliding path: ${normalized}`);
      }
      seen.add(collisionKey);
      paths.push(projectPath(grant, normalized));
    }
    paths.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
    return Object.freeze({ status: 'supported', files: Object.freeze(paths) });
  }

  async readText(path: ProjectPath): Promise<FileReadResult> {
    const normalizedPath = this.requirePath(path);
    const result = await this.invoke(
      'host_read_text',
      request(pathRequest(normalizedPath)),
      'read-failed',
    );
    if (!isExactRecord(result, ['text', 'revision'])
      || typeof result.text !== 'string'
      || !isNativeRevision(result.revision)) {
      throw malformed('read-failed', 'File read returned malformed text or revision data.');
    }
    return Object.freeze({
      path: normalizedPath,
      text: result.text,
      revision: fileRevision(result.revision),
    });
  }

  async replaceTextAtomically(
    path: ProjectPath,
    expectedRevision: FileRevision,
    text: string,
  ): Promise<FileRevision> {
    const normalizedPath = this.requirePath(path);
    if (!isNativeRevision(expectedRevision)) {
      throw new HostError('stale-revision', 'Atomic replacement requires a valid content revision.');
    }
    const result = await this.invoke(
      'host_replace_text',
      request({ ...pathRequest(normalizedPath), expectedRevision, text }),
      'replace-failed',
    );
    if (!isExactRecord(result, ['revision']) || !isNativeRevision(result.revision)) {
      throw malformed('replace-failed', 'Atomic replacement returned a malformed revision.');
    }
    return fileRevision(result.revision);
  }

  async watch(root: ProjectRoot, listener: FileChangeListener): Promise<Disposable> {
    const grant = this.requireRoot(root);
    if (typeof listener !== 'function') throw new HostError('read-failed', 'File watching requires a listener.');
    let active = true;
    let watchId: string | undefined;
    const pendingPayloads: unknown[] = [];
    const delivered = new Map<string, string>();
    let unlisten: (() => void) | undefined;
    let delivery = Promise.resolve();
    const deliver = (payload: unknown): Promise<void> | undefined => {
      if (!active) return undefined;
      if (watchId === undefined) {
        pendingPayloads.push(payload);
        return undefined;
      }
      const event = parseWatchEvent(payload, watchId, grant);
      if (event === null || !active) return undefined;
      const prior = delivered.get(event.path.relativePath);
      const token = event.kind === 'deleted' ? '<deleted>' : event.revision;
      if (prior === token) return undefined;
      delivered.set(event.path.relativePath, token);
      delivery = delivery
        .then(async () => {
          if (active) await listener(event);
        })
        .catch(() => undefined);
      return delivery;
    };
    try {
      unlisten = await this.ports.listen('uxml://file-change', ({ payload }) => {
        return deliver(payload);
      });
      const result = await this.invoke(
        'host_start_watch',
        request({ projectId: grant.id }),
        'read-failed',
      );
      if (!isExactRecord(result, ['watchId']) || !isNonemptyString(result.watchId)) {
        throw malformed('read-failed', 'File watch returned a malformed id.');
      }
      watchId = result.watchId;
      for (const payload of pendingPayloads.splice(0)) deliver(payload);
      await delivery;
    } catch (error) {
      active = false;
      unlisten?.();
      if (error instanceof HostError) throw error;
      throw mapNativeError(error, 'read-failed');
    }
    return Object.freeze({
      dispose: () => {
        if (!active) return;
        active = false;
        unlisten?.();
        if (watchId !== undefined) {
          void this.invoke('host_stop_watch', request({ watchId }), 'read-failed').catch(() => undefined);
        }
      },
    });
  }

  async readRecovery(projectIdValue: ProjectId): Promise<string | null> {
    const id = this.requireProjectId(projectIdValue);
    const result = await this.invoke('host_read_recovery', request({ projectId: id }), 'app-data-failed');
    if (!isExactRecord(result, ['journal']) || (result.journal !== null && typeof result.journal !== 'string')) {
      throw malformed('app-data-failed', 'Recovery storage returned malformed data.');
    }
    return result.journal;
  }

  async writeRecovery(projectIdValue: ProjectId, journal: string): Promise<void> {
    const id = this.requireProjectId(projectIdValue);
    await this.invokeVoid('host_write_recovery', request({ projectId: id, journal }), 'app-data-failed');
  }

  async clearRecovery(projectIdValue: ProjectId): Promise<void> {
    const id = this.requireProjectId(projectIdValue);
    await this.invokeVoid('host_clear_recovery', request({ projectId: id }), 'app-data-failed');
  }

  async listRecentProjects(): Promise<readonly RecentProject[]> {
    const result = await this.invoke('host_list_recent_projects', undefined, 'app-data-failed');
    if (!Array.isArray(result) || result.length > 10) {
      throw malformed('app-data-failed', 'Recent-project storage returned malformed data.');
    }
    const entries: RecentProject[] = [];
    const seen = new Set<string>();
    let priorTime = Number.POSITIVE_INFINITY;
    for (const value of result) {
      if (!isExactRecord(value, ['projectId', 'displayName', 'lastOpenedAt'])
        || !isNonemptyString(value.projectId)
        || !isNonemptyString(value.displayName)
        || !isFiniteTimestamp(value.lastOpenedAt)
        || value.lastOpenedAt > priorTime
        || seen.has(value.projectId)) {
        throw malformed('app-data-failed', 'Recent-project storage returned an invalid ordering or entry.');
      }
      priorTime = value.lastOpenedAt;
      seen.add(value.projectId);
      entries.push(Object.freeze({
        root: snapshotProjectRoot({ id: projectId(value.projectId), name: value.displayName }),
        lastOpenedAt: value.lastOpenedAt,
      }));
    }
    return Object.freeze(entries);
  }

  async rememberRecentProject(root: ProjectRoot): Promise<void> {
    const snapshot = snapshotProjectRoot(root);
    await this.invokeVoid(
      'host_remember_recent_project',
      request({ projectId: snapshot.id, displayName: snapshot.name }),
      'app-data-failed',
    );
  }

  async confirm(requestValue: ConfirmationRequest): Promise<ConfirmationResult> {
    const snapshot = snapshotConfirmation(requestValue);
    const result = await this.invoke('host_confirm', request({ ...snapshot }), 'dialog-failed');
    if (!isExactRecord(result, ['confirmed']) || typeof result.confirmed !== 'boolean') {
      throw malformed('dialog-failed', 'Confirmation dialog returned a malformed decision.');
    }
    return Object.freeze({ confirmed: result.confirmed });
  }

  async showMessage(requestValue: MessageRequest): Promise<void> {
    await this.invokeVoid('host_show_message', request({ ...snapshotMessage(requestValue) }), 'dialog-failed');
  }

  now(): number {
    return this.ports.timers.now();
  }

  schedule(delayMs: number, callback: ScheduledCallback): Disposable {
    const handle = this.ports.timers.setTimeout(callback, delayMs);
    return Object.freeze({ dispose: () => this.ports.timers.clearTimeout(handle) });
  }

  private requireRoot(candidate: ProjectRoot): ProjectRoot {
    const snapshot = snapshotProjectRoot(candidate);
    const grant = this.grants.get(snapshot.id);
    if (grant === undefined || grant.name !== snapshot.name) {
      throw new HostError('root-not-granted', `Project root is not granted: ${snapshot.id}`);
    }
    return grant;
  }

  private requireProjectId(candidate: ProjectId): ProjectId {
    if (typeof candidate !== 'string' || !this.grants.has(candidate)) {
      throw new HostError('root-not-granted', `Project root is not granted: ${String(candidate)}`);
    }
    return candidate;
  }

  private requirePath(candidate: ProjectPath): ProjectPath {
    if (!isRecord(candidate) || !isNonemptyString(candidate.projectId) || typeof candidate.relativePath !== 'string') {
      throw new HostError('invalid-path', 'Project file path is malformed.');
    }
    const grant = this.grants.get(candidate.projectId as ProjectId);
    if (grant === undefined) {
      throw new HostError('root-not-granted', `Project root is not granted: ${candidate.projectId}`);
    }
    return projectPath(grant, candidate.relativePath);
  }

  private async invoke(
    command: string,
    payload: unknown,
    fallbackCode: HostError['code'],
  ): Promise<unknown> {
    try {
      return await this.ports.invoke(command, payload);
    } catch (error) {
      throw mapNativeError(error, fallbackCode);
    }
  }

  private async invokeVoid(command: string, payload: unknown, fallbackCode: HostError['code']): Promise<void> {
    const result = await this.invoke(command, payload, fallbackCode);
    if (result !== null && result !== undefined) {
      throw malformed(fallbackCode, `${command} returned unexpected data.`);
    }
  }
}

const HOST_ERROR_CODES = new Set<HostError['code']>([
  'invalid-path', 'root-not-granted', 'not-found', 'stale-revision', 'replace-failed',
  'read-failed', 'selection-failed', 'permission-denied', 'identity-failed',
  'app-data-failed', 'dialog-failed', 'unsupported',
]);

function request(value: Record<string, unknown>): Readonly<{ request: Readonly<Record<string, unknown>> }> {
  return Object.freeze({ request: Object.freeze(value) });
}

function pathRequest(path: ProjectPath): Readonly<{ projectId: ProjectId; relativePath: string }> {
  return Object.freeze({ projectId: path.projectId, relativePath: path.relativePath });
}

function strictNormalizedPath(value: string, code: HostError['code']): string {
  try {
    const normalized = normalizeRelativePath(value);
    if (normalized !== value || value.includes('\\')) throw new TypeError('Path is not normalized.');
    return normalized;
  } catch (error) {
    throw new HostError(code, `Native host returned an unsafe project path: ${value}`, error);
  }
}

function parseWatchEvent(payload: unknown, watchId: string, root: ProjectRoot): FileChangeEvent | null {
  if (!isRecord(payload)
    || payload.watchId !== watchId
    || payload.projectId !== root.id
    || (payload.kind !== 'changed' && payload.kind !== 'deleted')) return null;
  const expectedKeys = payload.kind === 'changed'
    ? ['watchId', 'projectId', 'kind', 'relativePath', 'revision']
    : ['watchId', 'projectId', 'kind', 'relativePath'];
  if (!isExactRecord(payload, expectedKeys) || typeof payload.relativePath !== 'string') return null;
  let path: ProjectPath;
  try {
    path = projectPath(root, strictNormalizedPath(payload.relativePath, 'read-failed'));
  } catch {
    return null;
  }
  if (payload.kind === 'changed') {
    if (!isNativeRevision(payload.revision)) return null;
    return Object.freeze({ kind: 'changed', path, revision: fileRevision(payload.revision) });
  }
  return Object.freeze({ kind: 'deleted', path });
}

function snapshotConfirmation(candidate: ConfirmationRequest): ConfirmationRequest {
  if (!isRecord(candidate)
    || (candidate.kind !== 'discard-changes' && candidate.kind !== 'external-change' && candidate.kind !== 'overwrite')
    || !isNonemptyString(candidate.title)
    || !isNonemptyString(candidate.message)
    || !isNonemptyString(candidate.confirmLabel)
    || !isNonemptyString(candidate.cancelLabel)) {
    throw new HostError('dialog-failed', 'Confirmation request is malformed.');
  }
  return Object.freeze({
    kind: candidate.kind,
    title: candidate.title,
    message: candidate.message,
    confirmLabel: candidate.confirmLabel,
    cancelLabel: candidate.cancelLabel,
  });
}

function snapshotMessage(candidate: MessageRequest): MessageRequest {
  if (!isRecord(candidate)
    || (candidate.kind !== 'info' && candidate.kind !== 'warning' && candidate.kind !== 'error')
    || !isNonemptyString(candidate.title)
    || !isNonemptyString(candidate.message)) {
    throw new HostError('dialog-failed', 'Message request is malformed.');
  }
  return Object.freeze({ kind: candidate.kind, title: candidate.title, message: candidate.message });
}

function mapNativeError(error: unknown, fallbackCode: HostError['code']): HostError {
  if (error instanceof HostError) return error;
  if (isExactRecord(error, ['code', 'message'])
    && typeof error.code === 'string'
    && HOST_ERROR_CODES.has(error.code as HostError['code'])
    && isNonemptyString(error.message)) {
    return new HostError(error.code as HostError['code'], error.message, error);
  }
  const message = error instanceof Error && error.message.length > 0
    ? error.message
    : 'Native host operation failed.';
  return new HostError(fallbackCode, message, error);
}

function malformed(code: HostError['code'], message: string): HostError {
  return new HostError(code, message);
}

function isNativeRevision(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:v1:[0-9a-f]{64}$/.test(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
