import {
  HostError,
  fileRevision,
  normalizeRelativePath,
  projectId,
  projectGrantGenerationOf,
  projectPath,
  snapshotProjectRoot,
  type ConfirmationRequest,
  type ConfirmationResult,
  type Disposable,
  type DisposalOutcome,
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
  readonly reportError?: (error: unknown) => void;
  readonly timers: TauriTimerPorts;
}

export class TauriHost implements HostPort {
  private capabilitySnapshot: HostCapabilities = Object.freeze({
    mode: 'tauri',
    projectSelection: 'directory-picker',
    atomicReplace: 'unsupported',
    watch: 'native-revision-aware',
    appData: 'app-data',
    dialogs: 'native',
  });
  private readonly grants = new Map<ProjectId, NativeGrant>();
  private readonly watches = new Set<ActiveNativeWatch>();

  constructor(private readonly ports: TauriHostPorts) {}

  get capabilities(): HostCapabilities {
    return this.capabilitySnapshot;
  }

  async chooseProject(): Promise<ProjectRoot | null> {
    const result = await this.invoke('host_choose_project', undefined, 'selection-failed');
    if (result === null) return null;
    if (!isExactRecord(result, ['projectId', 'displayName', 'grant', 'atomicReplace'])
      || !isNativeProjectId(result.projectId)
      || !isNativeGrant(result.grant)
      || !isNativeAtomicReplace(result.atomicReplace)
      || !isNonemptyString(result.displayName)) {
      await Promise.all([...this.watches].map((watch) => watch.retire(true, true)));
      this.grants.clear();
      this.publishAtomicReplace('unsupported');
      throw malformed('selection-failed', 'Project selection returned a malformed result.');
    }
    const root = snapshotProjectRoot(
      { id: projectId(result.projectId), name: result.displayName },
      result.grant,
    );
    await Promise.all([...this.watches].map((watch) => watch.retire(true, true)));
    this.grants.clear();
    this.grants.set(root.id, Object.freeze({ root, token: result.grant }));
    this.publishAtomicReplace(result.atomicReplace);
    return snapshotProjectRoot(root);
  }

  async enumerateFiles(root: ProjectRoot): Promise<FileEnumerationResult> {
    const grant = this.requireRoot(root);
    const result = await this.invoke(
      'host_enumerate_files',
      request({ projectId: grant.root.id, grant: grant.token }),
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
      paths.push(projectPath(grant.root, normalized));
    }
    paths.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
    return Object.freeze({ status: 'supported', files: Object.freeze(paths) });
  }

  async readText(path: ProjectPath): Promise<FileReadResult> {
    const { path: normalizedPath, grant } = this.requirePath(path);
    const result = await this.invoke(
      'host_read_text',
      request(pathRequest(normalizedPath, grant.token)),
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

  async createText(path: ProjectPath, text: string): Promise<FileRevision> {
    const { path: normalizedPath, grant } = this.requirePath(path);
    const result = await this.invoke(
      'host_create_text',
      request({ ...pathRequest(normalizedPath, grant.token), text }),
      'replace-failed',
    );
    if (!isExactRecord(result, ['revision']) || !isNativeRevision(result.revision)) {
      throw malformed('replace-failed', 'Text creation returned a malformed revision.');
    }
    return fileRevision(result.revision);
  }

  async replaceTextAtomically(
    path: ProjectPath,
    expectedRevision: FileRevision,
    text: string,
  ): Promise<FileRevision> {
    if (this.capabilitySnapshot.atomicReplace === 'unsupported') {
      throw new HostError('unsupported', 'Native conditional replacement is unsupported on this platform.');
    }
    const { path: normalizedPath, grant } = this.requirePath(path);
    if (!isNativeRevision(expectedRevision)) {
      throw new HostError('stale-revision', 'Atomic replacement requires a valid content revision.');
    }
    const result = await this.invoke(
      'host_replace_text',
      request({ ...pathRequest(normalizedPath, grant.token), expectedRevision, text }),
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
    let resolveCompletion!: (outcome: DisposalOutcome) => void;
    const completion = new Promise<DisposalOutcome>((resolve) => { resolveCompletion = resolve; });
    let retirement: Promise<DisposalOutcome> | undefined;
    let retiredByReplacement = false;
    let deliveryFailure: HostError | undefined;
    const activeWatch: ActiveNativeWatch = {
      retire: (nativeAlreadyStopped, skipDelivery = false) => {
        if (retirement !== undefined) return retirement;
        retiredByReplacement = nativeAlreadyStopped;
        active = false;
        pendingPayloads.length = 0;
        unlisten?.();
        const deliveryAtRetirement = delivery;
        retirement = (async () => {
          if (!skipDelivery) await deliveryAtRetirement;
          try {
            if (!nativeAlreadyStopped && watchId !== undefined) {
              await this.invokeVoid(
                'host_stop_watch',
                request({ projectId: grant.root.id, grant: grant.token, watchId }),
                'read-failed',
              );
            }
            if (deliveryFailure !== undefined) {
              return Object.freeze({ status: 'failed' as const, error: deliveryFailure });
            }
            return Object.freeze({ status: 'disposed' as const });
          } catch (error) {
            return Object.freeze({
              status: 'failed' as const,
              error: error instanceof HostError ? error : mapNativeError(error, 'read-failed'),
            });
          } finally {
            this.watches.delete(activeWatch);
          }
        })();
        const completionSettlement = skipDelivery
          ? (async (): Promise<DisposalOutcome> => {
              const retirementOutcome = await retirement!;
              await deliveryAtRetirement;
              if (deliveryFailure !== undefined) {
                return Object.freeze({ status: 'failed' as const, error: deliveryFailure });
              }
              return retirementOutcome;
            })()
          : retirement;
        void completionSettlement.then(resolveCompletion);
        return retirement;
      },
    };
    this.watches.add(activeWatch);
    const deliver = (payload: unknown): Promise<void> | undefined => {
      if (!active) return undefined;
      if (watchId === undefined) {
        pendingPayloads.push(payload);
        return undefined;
      }
      const event = parseWatchEvent(payload, watchId, grant);
      if (event === null || !active) return undefined;
      if (event.kind !== 'rescan-required') {
        const prior = delivered.get(event.path.relativePath);
        const token = event.kind === 'deleted' ? '<deleted>' : event.revision;
        if (prior === token) return undefined;
        delivered.set(event.path.relativePath, token);
      }
      delivery = delivery
        .then(async () => {
          if (!active) return;
          await listener(event);
        })
        .catch((error) => {
          const failure = error instanceof HostError
            ? error
            : new HostError('read-failed', 'Native watch listener failed.', error);
          deliveryFailure ??= failure;
          this.reportError(failure);
        });
      return delivery;
    };
    try {
      unlisten = await this.ports.listen('uxml://file-change', ({ payload }) => {
        return deliver(payload);
      });
      const result = await this.invoke(
        'host_start_watch',
        request({ projectId: grant.root.id, grant: grant.token }),
        'read-failed',
      );
      if (!isExactRecord(result, ['watchId']) || !isNativeWatchId(result.watchId)) {
        throw malformed('read-failed', 'File watch returned a malformed id.');
      }
      watchId = result.watchId;
      if (!active) {
        throw new HostError(
          'root-not-granted',
          retiredByReplacement
            ? 'File watch grant was replaced during startup.'
            : 'File watch was disposed during startup.',
        );
      }
      for (const payload of pendingPayloads.splice(0)) deliver(payload);
      await delivery;
    } catch (error) {
      active = false;
      unlisten?.();
      this.watches.delete(activeWatch);
      if (error instanceof HostError) throw error;
      throw mapNativeError(error, 'read-failed');
    }
    return Object.freeze({
      dispose: () => { void activeWatch.retire(false); },
      completion,
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
        || !isNativeProjectId(value.projectId)
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
    if (!isNativeProjectId(snapshot.id)) {
      throw new HostError('app-data-failed', 'Recent project identifier is malformed.');
    }
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
    let active = true;
    let resolveCompletion!: (outcome: DisposalOutcome) => void;
    const completion = new Promise<DisposalOutcome>((resolve) => { resolveCompletion = resolve; });
    const handle = this.ports.timers.setTimeout(async () => {
      if (!active) return;
      active = false;
      try {
        await callback();
        resolveCompletion(Object.freeze({ status: 'disposed' }));
      } catch (error) {
        const failure = error instanceof HostError
          ? error
          : new HostError('read-failed', 'Scheduled desktop callback failed.', error);
        this.reportError(failure);
        resolveCompletion(Object.freeze({ status: 'failed', error: failure }));
      }
    }, delayMs);
    return Object.freeze({
      dispose: () => {
        if (!active) return;
        active = false;
        this.ports.timers.clearTimeout(handle);
        resolveCompletion(Object.freeze({ status: 'disposed' }));
      },
      completion,
    });
  }

  private reportError(error: unknown): void {
    try {
      this.ports.reportError?.(error);
    } catch {
      // Async adapters contain error-sink failures to prevent unhandled callbacks.
    }
  }

  private publishAtomicReplace(atomicReplace: NativeAtomicReplace): void {
    this.capabilitySnapshot = Object.freeze({
      ...this.capabilitySnapshot,
      atomicReplace,
    });
  }

  private requireRoot(candidate: ProjectRoot): NativeGrant {
    const snapshot = snapshotProjectRoot(candidate);
    const grant = this.grants.get(snapshot.id);
    if (grant === undefined
      || grant.root.name !== snapshot.name
      || projectGrantGenerationOf(snapshot) !== grant.token) {
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

  private requirePath(candidate: ProjectPath): Readonly<{ path: ProjectPath; grant: NativeGrant }> {
    if (!isRecord(candidate) || !isNonemptyString(candidate.projectId) || typeof candidate.relativePath !== 'string') {
      throw new HostError('invalid-path', 'Project file path is malformed.');
    }
    const grant = this.grants.get(candidate.projectId as ProjectId);
    if (grant === undefined || projectGrantGenerationOf(candidate) !== grant.token) {
      throw new HostError('root-not-granted', `Project root is not granted: ${candidate.projectId}`);
    }
    return Object.freeze({ path: projectPath(grant.root, candidate.relativePath), grant });
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

function pathRequest(path: ProjectPath, grant: string): Readonly<{ projectId: ProjectId; grant: string; relativePath: string }> {
  return Object.freeze({ projectId: path.projectId, grant, relativePath: path.relativePath });
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

function parseWatchEvent(payload: unknown, watchId: string, grant: NativeGrant): FileChangeEvent | null {
  if (!isRecord(payload)
    || payload.watchId !== watchId
    || payload.projectId !== grant.root.id
    || payload.grant !== grant.token
    || (payload.kind !== 'changed' && payload.kind !== 'deleted' && payload.kind !== 'rescan-required')) return null;
  if (payload.kind === 'rescan-required') {
    return isExactRecord(payload, ['watchId', 'projectId', 'grant', 'kind'])
      ? Object.freeze({ kind: 'rescan-required', root: snapshotProjectRoot(grant.root) })
      : null;
  }
  const expectedKeys = payload.kind === 'changed'
    ? ['watchId', 'projectId', 'grant', 'kind', 'relativePath', 'revision']
    : ['watchId', 'projectId', 'grant', 'kind', 'relativePath'];
  if (!isExactRecord(payload, expectedKeys) || typeof payload.relativePath !== 'string') return null;
  let path: ProjectPath;
  try {
    path = projectPath(grant.root, strictNormalizedPath(payload.relativePath, 'read-failed'));
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

function isNativeProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^project:v1:[0-9a-f]{64}$/.test(value);
}

function isNativeGrant(value: unknown): value is string {
  return typeof value === 'string' && /^grant:v1:[0-9a-f]{16}$/.test(value);
}

function isNativeWatchId(value: unknown): value is string {
  return typeof value === 'string' && /^watch:v1:[0-9a-f]{16}$/.test(value);
}

type NativeAtomicReplace = 'best-effort-safe-write' | 'unsupported';

function isNativeAtomicReplace(value: unknown): value is NativeAtomicReplace {
  return value === 'best-effort-safe-write' || value === 'unsupported';
}

interface NativeGrant {
  readonly root: ProjectRoot;
  readonly token: string;
}

interface ActiveNativeWatch {
  retire(nativeAlreadyStopped: boolean, skipOwnDelivery?: boolean): Promise<DisposalOutcome>;
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
