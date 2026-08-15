import type { DocumentSession } from '../documents/DocumentSession';
import type { ElementLocator } from '../documents/ElementLocator';
import {
  HostError,
  projectPath,
  snapshotProjectRoot,
  type FileReadResult,
  type FileRevision,
  type Disposable,
  type HostPort,
  type ProjectPath,
  type ProjectRoot,
} from '../host/HostPort';

export type SaveFileStatus = 'noop' | 'saved' | 'conflict' | 'failed' | 'skipped';
export type SaveStatus = 'noop' | 'saved' | 'partial' | 'conflict' | 'failed';
export type RecoveryCleanupStatus = 'not-requested' | 'cleared' | 'retained' | 'failed';

export interface SaveFileOutcome {
  readonly path: string;
  readonly status: SaveFileStatus;
  readonly revision?: FileRevision;
  readonly error?: SaveFailure;
}

export interface SaveFailure {
  readonly code: string;
  readonly message: string;
}

export interface SaveOutcome {
  readonly status: SaveStatus;
  readonly files: readonly SaveFileOutcome[];
  readonly dirtyPaths: readonly string[];
  readonly recovery: RecoveryCleanupStatus;
  readonly recoveryRequired: boolean;
  readonly recoveryError?: SaveFailure;
  readonly writeState?: SaveWriteState;
}

export interface SaveWriteState {
  readonly writtenPaths: readonly string[];
  readonly pendingPaths: readonly string[];
}

export interface RecoveryCleanup {
  clear(): Promise<void>;
  prepareSave?(input: RecoverySavePreparation): Promise<void>;
}

export interface RecoverySavePreparation {
  readonly entryPath: string;
  readonly baseFiles: ReadonlyMap<string, string>;
  readonly targetFiles: ReadonlyMap<string, string>;
  readonly dirtyPaths: readonly string[];
  readonly selectionAfter: readonly ElementLocator[];
}

export interface RecoveryCleanupRetryOutcome {
  readonly status: 'not-pending' | 'blocked' | 'cleared' | 'failed';
  readonly recoveryRequired: boolean;
  readonly error?: SaveFailure;
}

export type ExternalChangeStatus = 'reloaded' | 'unchanged' | 'conflict' | 'deleted' | 'reload-failed';

export interface ExternalChangeOutcome {
  readonly path: string;
  readonly status: ExternalChangeStatus;
  readonly external: 'changed' | 'deleted';
  readonly localDirty: boolean;
  readonly revision?: FileRevision;
  readonly error?: SaveFailure;
}

export type ExternalChangeDecision = 'reload' | 'overwrite' | 'cancel';
export type ExternalResolutionStatus = 'reloaded' | 'overwritten' | 'cancelled' | 'deleted' | 'conflict' | 'failed';

export interface ExternalResolutionOutcome {
  readonly path: string;
  readonly decision: ExternalChangeDecision;
  readonly status: ExternalResolutionStatus;
  readonly external: 'changed' | 'deleted';
  readonly localDirty: boolean;
  readonly revision?: FileRevision;
  readonly error?: SaveFailure;
}

export type ExternalChangeListener = (outcomes: readonly ExternalChangeOutcome[]) => void | Promise<void>;

interface SavedFileState {
  readonly path: ProjectPath;
  readonly text: string;
  readonly revision: FileRevision;
}

export class SaveCoordinator {
  private readonly root: ProjectRoot;
  private readonly saved = new Map<string, SavedFileState>();
  private readonly pendingExternal = new Map<string, FileReadResult | null>();
  private externalSequence = 1;
  private cleanupPending = false;

  constructor(
    private readonly host: HostPort,
    root: ProjectRoot,
    initialFiles: readonly FileReadResult[],
    private readonly recoveryCleanup?: RecoveryCleanup,
  ) {
    this.root = snapshotProjectRoot(root);
    for (const file of initialFiles) {
      if (file.path.projectId !== this.root.id) {
        throw new HostError('root-not-granted', `Initial file belongs to another project root: ${file.path.projectId}`);
      }
      const path = projectPath(this.root, file.path.relativePath);
      this.saved.set(path.relativePath, Object.freeze({ path, text: file.text, revision: file.revision }));
    }
  }

  async save(session: DocumentSession, path = session.entryPath): Promise<SaveOutcome> {
    const generation = session.generation;
    const snapshot = session.snapshot();
    const file = snapshot.files.get(path);
    const baseline = this.saved.get(path);
    if (file && baseline && file.text === baseline.text) {
      return this.finishSave(session, {
        status: 'noop',
        files: [{ path, status: 'noop', revision: baseline.revision }],
        dirtyPaths: this.dirtyPaths(session),
        recovery: 'not-requested',
      });
    }
    if (!file || !baseline) throw new Error(`Save baseline is missing for ${path}.`);
    const preparationError = await this.prepareRecovery(session, generation, snapshot);
    if (preparationError !== null) {
      const recoveryError = preparationError.code === 'local-changed'
        ? await this.replanRecovery(session)
        : preparationError;
      return this.finishSave(session, {
        status: preparationError.code === 'local-changed' ? 'conflict' : 'failed',
        files: [{
          path,
          status: preparationError.code === 'local-changed' ? 'conflict' : 'failed',
          error: preparationError,
        }],
        dirtyPaths: this.dirtyPaths(session),
        recovery: recoveryError === null ? 'not-requested' : 'failed',
        ...(recoveryError === null ? {} : { recoveryError }),
      });
    }
    let disk: FileReadResult;
    try {
      disk = await this.host.readText(baseline.path);
      if (!sessionMatches(session, generation, path, file.text)) {
        const recoveryError = await this.replanRecovery(session);
        return this.finishSave(session, {
          status: 'conflict',
          files: [{ path, status: 'conflict', error: localChangedFailure('save', path) }],
          dirtyPaths: this.dirtyPaths(session),
          recovery: recoveryError === null ? 'not-requested' : 'failed',
          ...(recoveryError === null ? {} : { recoveryError }),
        });
      }
      if (disk.text !== baseline.text) {
        throw new HostError('stale-revision', `File changed before replacement: ${path}`);
      }
      const revision = await this.host.replaceTextAtomically(baseline.path, disk.revision, file.text);
      this.saved.set(path, Object.freeze({ path: baseline.path, text: file.text, revision }));
      let dirtyPaths = this.dirtyPaths(session);
      const recoveryError = dirtyPaths.length > 0 && session.generation !== generation
        ? await this.replanRecovery(session)
        : null;
      dirtyPaths = this.dirtyPaths(session);
      return this.finishSave(session, {
        status: dirtyPaths.length === 0 ? 'saved' : 'partial',
        files: [{ path, status: 'saved', revision }],
        dirtyPaths,
        recovery: recoveryError === null ? 'not-requested' : 'failed',
        ...(recoveryError === null ? {} : { recoveryError }),
      });
    } catch (error) {
      const conflict = error instanceof HostError && (error.code === 'stale-revision' || error.code === 'not-found');
      return this.finishSave(session, {
        status: conflict ? 'conflict' : 'failed',
        files: [{ path, status: conflict ? 'conflict' : 'failed', error: snapshotFailure(error) }],
        dirtyPaths: this.dirtyPaths(session),
        recovery: 'not-requested',
      });
    }
  }

  async saveAll(session: DocumentSession): Promise<SaveOutcome> {
    const generation = session.generation;
    const snapshot = session.snapshot();
    const paths = [...snapshot.files.keys()].sort(comparePaths);
    const files: SaveFileOutcome[] = [];
    let stopped = false;
    let terminalStatus: 'conflict' | 'failed' | undefined;
    let recoveryReplanError: SaveFailure | null = null;

    const preparationError = await this.prepareRecovery(session, generation, snapshot);
    if (preparationError !== null) {
      const recoveryError = preparationError.code === 'local-changed'
        ? await this.replanRecovery(session)
        : preparationError;
      let failedAssigned = false;
      for (const path of paths) {
        const file = snapshot.files.get(path);
        const baseline = this.saved.get(path);
        if (file && baseline && file.text === baseline.text) {
          files.push({ path, status: 'noop', revision: baseline.revision });
        } else if (!failedAssigned) {
          const conflict = preparationError.code === 'local-changed';
          files.push({ path, status: conflict ? 'conflict' : 'failed', error: preparationError });
          failedAssigned = true;
        } else {
          files.push({ path, status: 'skipped' });
        }
      }
      return this.finishSave(session, {
        status: preparationError.code === 'local-changed' ? 'conflict' : 'failed',
        files,
        dirtyPaths: this.dirtyPaths(session),
        recovery: recoveryError === null ? 'not-requested' : 'failed',
        ...(recoveryError === null ? {} : { recoveryError }),
      });
    }

    for (const path of paths) {
      if (stopped) {
        files.push({ path, status: 'skipped' });
        continue;
      }
      const file = snapshot.files.get(path);
      const baseline = this.saved.get(path);
      if (!file || !baseline) {
        files.push({ path, status: 'failed', error: { code: 'missing-baseline', message: `Save baseline is missing for ${path}.` } });
        terminalStatus = 'failed';
        stopped = true;
        continue;
      }
      if (file.text === baseline.text) {
        files.push({ path, status: 'noop', revision: baseline.revision });
        continue;
      }
      try {
        const disk = await this.host.readText(baseline.path);
        if (!sessionMatches(session, generation, path, file.text)) {
          recoveryReplanError = await this.replanRecovery(session);
          terminalStatus = 'conflict';
          files.push({ path, status: 'conflict', error: localChangedFailure('save', path) });
          stopped = true;
          continue;
        }
        if (disk.text !== baseline.text) {
          throw new HostError('stale-revision', `File changed before replacement: ${path}`);
        }
        const revision = await this.host.replaceTextAtomically(baseline.path, disk.revision, file.text);
        this.saved.set(path, Object.freeze({ path: baseline.path, text: file.text, revision }));
        files.push({ path, status: 'saved', revision });
        if (!sessionMatches(session, generation, path, file.text)) {
          terminalStatus = 'conflict';
          stopped = true;
        }
      } catch (error) {
        const conflict = error instanceof HostError && (error.code === 'stale-revision' || error.code === 'not-found');
        terminalStatus = conflict ? 'conflict' : 'failed';
        files.push({ path, status: terminalStatus, error: snapshotFailure(error) });
        stopped = true;
      }
    }

    let dirtyPaths = this.dirtyPaths(session);
    const savedAny = files.some((file) => file.status === 'saved');
    const status: SaveStatus = dirtyPaths.length === 0
      ? (savedAny ? 'saved' : 'noop')
      : savedAny
        ? 'partial'
        : terminalStatus ?? 'failed';
    const recoveryError = recoveryReplanError ?? (
      savedAny && dirtyPaths.length > 0 && session.generation !== generation
        ? await this.replanRecovery(session)
        : null
    );
    dirtyPaths = this.dirtyPaths(session);
    return this.finishSave(session, {
      status,
      files,
      dirtyPaths,
      recovery: recoveryError === null ? 'not-requested' : 'failed',
      ...(recoveryError === null ? {} : { recoveryError }),
    });
  }

  async processExternalChanges(
    session: DocumentSession,
    candidatePaths: readonly string[],
  ): Promise<readonly ExternalChangeOutcome[]> {
    const outcomes: ExternalChangeOutcome[] = [];
    const openPaths = session.snapshot().files;
    const paths = [...new Set(candidatePaths.map((path) => projectPath(this.root, path).relativePath))]
      .filter((path) => this.saved.has(path) && openPaths.has(path))
      .sort(comparePaths);
    for (const path of paths) {
      const baseline = this.saved.get(path);
      const generation = session.generation;
      let local = session.snapshot().files.get(path);
      if (!baseline || !local) throw new Error(`External-change baseline is missing for ${path}.`);
      let localDirty = local.text !== baseline.text;
      let disk: FileReadResult;
      try {
        disk = await this.host.readText(baseline.path);
      } catch (error) {
        if (!(error instanceof HostError) || error.code !== 'not-found') throw error;
        local = session.snapshot().files.get(path);
        if (!local) continue;
        localDirty = local.text !== baseline.text;
        this.pendingExternal.set(path, null);
        outcomes.push({
          path,
          status: localDirty ? 'conflict' : 'deleted',
          external: 'deleted',
          localDirty,
        });
        continue;
      }
      const latestLocal = session.snapshot().files.get(path);
      if (!latestLocal) continue;
      const changedDuringRead = session.generation !== generation || latestLocal.text !== local.text;
      local = latestLocal;
      localDirty = local.text !== baseline.text;
      if (disk.text === local.text) {
        this.saved.set(path, Object.freeze({ path: baseline.path, text: disk.text, revision: disk.revision }));
        this.pendingExternal.delete(path);
        outcomes.push({
          path,
          status: 'unchanged',
          external: 'changed',
          revision: disk.revision,
          localDirty: false,
        });
        continue;
      }
      if (disk.text === baseline.text) {
        this.saved.set(path, Object.freeze({ path: baseline.path, text: baseline.text, revision: disk.revision }));
        this.pendingExternal.delete(path);
        outcomes.push({
          path,
          status: 'unchanged',
          external: 'changed',
          revision: disk.revision,
          localDirty,
        });
        continue;
      }
      if (changedDuringRead || localDirty) {
        this.pendingExternal.set(path, disk);
        outcomes.push({
          path,
          status: 'conflict',
          external: 'changed',
          revision: disk.revision,
          localDirty: true,
        });
        continue;
      }
      try {
        session.history.execute({
          id: `external-reload:v1:${this.externalSequence++}:${path}`,
          label: `Reload ${path}`,
          patchesByFile: new Map([[path, [{ start: 0, end: local.text.length, replacement: disk.text }]]]),
        });
      } catch {
        this.pendingExternal.set(path, disk);
        outcomes.push({
          path,
          status: 'reload-failed',
          external: 'changed',
          revision: disk.revision,
          localDirty: false,
          error: { code: 'reload-failed', message: `External reload failed for ${path}.` },
        });
        continue;
      }
      this.pendingExternal.delete(path);
      this.saved.set(path, Object.freeze({ path: baseline.path, text: disk.text, revision: disk.revision }));
      outcomes.push({ path, status: 'reloaded', external: 'changed', revision: disk.revision, localDirty: false });
    }
    return freezeExternalOutcomes(outcomes);
  }

  async resolveExternalChange(
    session: DocumentSession,
    candidatePath: string,
    decision: ExternalChangeDecision,
  ): Promise<ExternalResolutionOutcome> {
    const path = projectPath(this.root, candidatePath).relativePath;
    if (!this.pendingExternal.has(path)) throw new Error(`No external change is pending for ${path}.`);
      const pending = this.pendingExternal.get(path) ?? null;
      const baseline = this.saved.get(path);
      const generation = session.generation;
      const local = session.snapshot().files.get(path);
    if (!baseline || !local) throw new Error(`External-change baseline is missing for ${path}.`);
    const localDirty = local.text !== baseline.text;
    if (decision === 'cancel') {
      this.pendingExternal.delete(path);
      return freezeExternalResolution({
        path,
        decision,
        status: 'cancelled',
        external: pending === null ? 'deleted' : 'changed',
        ...(pending === null ? {} : { revision: pending.revision }),
        localDirty,
      });
    }
    if (decision === 'reload') {
      if (pending === null) {
        return freezeExternalResolution({ path, decision, status: 'deleted', external: 'deleted', localDirty });
      }
      const current = await this.host.readText(baseline.path);
      if (!sessionMatches(session, generation, path, local.text)) {
        this.pendingExternal.set(path, current);
        return freezeExternalResolution({
          path,
          decision,
          status: 'conflict',
          external: 'changed',
          revision: current.revision,
          localDirty: true,
          error: localChangedFailure('reload', path),
        });
      }
      if (current.revision !== pending.revision || current.text !== pending.text) {
        this.pendingExternal.set(path, current);
        return freezeExternalResolution({
          path,
          decision,
          status: 'conflict',
          external: 'changed',
          revision: current.revision,
          localDirty,
          error: { code: 'external-changed-again', message: `File changed again before reload: ${path}` },
        });
      }
      try {
        session.history.execute({
          id: `external-reload:v1:${this.externalSequence++}:${path}`,
          label: `Reload ${path}`,
          patchesByFile: new Map([[path, [{ start: 0, end: local.text.length, replacement: current.text }]]]),
        });
      } catch {
        return freezeExternalResolution({
          path,
          decision,
          status: 'failed',
          external: 'changed',
          revision: current.revision,
          localDirty,
          error: { code: 'reload-failed', message: `External reload failed for ${path}.` },
        });
      }
      this.saved.set(path, Object.freeze({ path: baseline.path, text: current.text, revision: current.revision }));
      this.pendingExternal.delete(path);
      return freezeExternalResolution({
        path,
        decision,
        status: 'reloaded',
        external: 'changed',
        revision: current.revision,
        localDirty: false,
      });
    }
    if (pending === null) {
      return freezeExternalResolution({
        path,
        decision,
        status: 'deleted',
        external: 'deleted',
        localDirty,
        error: { code: 'not-found', message: `Cannot overwrite deleted file without a create capability: ${path}` },
      });
    }
    try {
      const revision = await this.host.replaceTextAtomically(baseline.path, pending.revision, local.text);
      this.saved.set(path, Object.freeze({ path: baseline.path, text: local.text, revision }));
      this.pendingExternal.delete(path);
      if (!sessionMatches(session, generation, path, local.text)) {
        return freezeExternalResolution({
          path,
          decision,
          status: 'conflict',
          external: 'changed',
          revision,
          localDirty: this.dirtyPaths(session).includes(path),
          error: localChangedFailure('overwrite', path),
        });
      }
      return freezeExternalResolution({
        path,
        decision,
        status: 'overwritten',
        external: 'changed',
        revision,
        localDirty: false,
      });
    } catch (error) {
      const conflict = error instanceof HostError && (error.code === 'stale-revision' || error.code === 'not-found');
      return freezeExternalResolution({
        path,
        decision,
        status: conflict ? 'conflict' : 'failed',
        external: 'changed',
        revision: pending.revision,
        localDirty,
        error: snapshotFailure(error),
      });
    }
  }

  async watch(
    session: () => DocumentSession,
    listener: ExternalChangeListener,
    debounceMs = 50,
  ): Promise<Disposable> {
    let disposed = false;
    let timer: Disposable | undefined;
    const pending = new Set<string>();
    const hostWatcher = await this.host.watch(this.root, (event) => {
      if (disposed) return;
      if (!this.saved.has(event.path.relativePath)) return;
      pending.add(event.path.relativePath);
      timer?.dispose();
      timer = this.host.schedule(debounceMs, async () => {
        timer = undefined;
        if (disposed) return;
        const paths = [...pending];
        pending.clear();
        const outcomes = await this.processExternalChanges(session(), paths);
        if (!disposed) await listener(outcomes);
      });
    });
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        pending.clear();
        timer?.dispose();
        timer = undefined;
        hostWatcher.dispose();
      },
    });
  }

  dirtyPaths(session: DocumentSession): readonly string[] {
    const snapshot = session.snapshot();
    return Object.freeze([...snapshot.files]
      .filter(([path, buffer]) => this.saved.get(path)?.text !== buffer.text)
      .map(([path]) => path)
      .sort());
  }

  async retryRecoveryCleanup(session: DocumentSession): Promise<RecoveryCleanupRetryOutcome> {
    if (!this.cleanupPending || !this.recoveryCleanup) {
      return freezeCleanupRetry({ status: 'not-pending', recoveryRequired: false });
    }
    if (this.dirtyPaths(session).length > 0) {
      return freezeCleanupRetry({ status: 'blocked', recoveryRequired: true });
    }
    try {
      await this.recoveryCleanup.clear();
      this.cleanupPending = false;
      return freezeCleanupRetry({ status: 'cleared', recoveryRequired: false });
    } catch (error) {
      this.cleanupPending = true;
      return freezeCleanupRetry({ status: 'failed', recoveryRequired: true, error: snapshotFailure(error) });
    }
  }

  private async prepareRecovery(
    session: DocumentSession,
    generation: number,
    snapshot: ReturnType<DocumentSession['snapshot']>,
  ): Promise<SaveFailure | null> {
    if (typeof this.recoveryCleanup?.prepareSave !== 'function') return null;
    const dirtyPaths = Object.freeze([...snapshot.files]
      .filter(([path, buffer]) => this.saved.get(path)?.text !== buffer.text)
      .map(([path]) => path)
      .sort(comparePaths));
    if (dirtyPaths.length === 0) return null;
    const baseFiles = new Map([...this.saved]
      .sort(([left], [right]) => comparePaths(left, right))
      .map(([path, file]) => [path, file.text]));
    const targetFiles = new Map([...snapshot.files]
      .sort(([left], [right]) => comparePaths(left, right))
      .map(([path, buffer]) => [path, buffer.text]));
    try {
      await this.recoveryCleanup.prepareSave({
        entryPath: snapshot.entryPath,
        baseFiles,
        targetFiles,
        dirtyPaths,
        selectionAfter: session.selection,
      });
    } catch {
      return Object.freeze({
        code: 'recovery-prepare-failed',
        message: 'Recovery state could not be persisted before save.',
      });
    }
    if (session.generation !== generation || !snapshotFilesMatch(session, snapshot)) {
      return localChangedFailure('save', snapshot.entryPath);
    }
    return null;
  }

  private async replanRecovery(session: DocumentSession): Promise<SaveFailure | null> {
    if (typeof this.recoveryCleanup?.prepareSave !== 'function') return null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generation = session.generation;
      const snapshot = session.snapshot();
      const error = await this.prepareRecovery(session, generation, snapshot);
      if (error === null || error.code !== 'local-changed') return error;
    }
    return Object.freeze({
      code: 'local-changed',
      message: 'Local source kept changing while recovery was being replanned.',
    });
  }

  private async finishSave(
    session: DocumentSession,
    outcome: Omit<SaveOutcome, 'recoveryRequired'>,
  ): Promise<SaveOutcome> {
    const shouldClear = this.recoveryCleanup !== undefined
      && outcome.dirtyPaths.length === 0
      && (outcome.status === 'saved' || this.cleanupPending);
    if (!shouldClear) {
      return freezeOutcome(outcome, this.cleanupPending);
    }
    const generation = session.generation;
    try {
      await this.recoveryCleanup!.clear();
      this.cleanupPending = false;
      let dirtyPaths = this.dirtyPaths(session);
      if (session.generation !== generation && dirtyPaths.length > 0) {
        const recoveryError = typeof this.recoveryCleanup!.prepareSave === 'function'
          ? await this.replanRecovery(session)
          : Object.freeze({
            code: 'recovery-prepare-failed',
            message: 'Recovery state could not be restored after cleanup raced with a local edit.',
          });
        dirtyPaths = this.dirtyPaths(session);
        this.cleanupPending = recoveryError !== null;
        const wroteAny = outcome.files.some((file) => file.status === 'saved');
        return freezeOutcome({
          ...outcome,
          status: wroteAny ? 'partial' : 'conflict',
          dirtyPaths,
          recovery: recoveryError === null ? 'retained' : 'failed',
          ...(recoveryError === null ? { recoveryError: undefined } : { recoveryError }),
        }, this.cleanupPending);
      }
      return freezeOutcome({ ...outcome, recovery: 'cleared' });
    } catch (error) {
      this.cleanupPending = true;
      let dirtyPaths = this.dirtyPaths(session);
      if (session.generation !== generation && dirtyPaths.length > 0
        && typeof this.recoveryCleanup!.prepareSave === 'function') {
        await this.replanRecovery(session);
        dirtyPaths = this.dirtyPaths(session);
        const wroteAny = outcome.files.some((file) => file.status === 'saved');
        return freezeOutcome({
          ...outcome,
          status: wroteAny ? 'partial' : 'conflict',
          dirtyPaths,
          recovery: 'failed',
          recoveryError: snapshotFailure(error),
        }, true);
      }
      return freezeOutcome({
        ...outcome,
        recovery: 'failed',
        recoveryError: snapshotFailure(error),
      });
    }
  }
}

function freezeOutcome(outcome: Omit<SaveOutcome, 'recoveryRequired'>, cleanupPending = false): SaveOutcome {
  const writeState = outcome.status === 'partial'
    ? Object.freeze({
      writtenPaths: Object.freeze(outcome.files.filter((file) => file.status === 'saved').map((file) => file.path)),
      pendingPaths: Object.freeze([...outcome.dirtyPaths]),
    })
    : undefined;
  return Object.freeze({
    status: outcome.status,
    files: Object.freeze(outcome.files.map((file) => Object.freeze({
      ...file,
      ...(file.error === undefined ? {} : { error: Object.freeze({ ...file.error }) }),
    }))),
    dirtyPaths: Object.freeze([...outcome.dirtyPaths]),
    recovery: outcome.recovery,
    recoveryRequired: outcome.dirtyPaths.length > 0 || outcome.recovery === 'failed' || cleanupPending,
    ...(outcome.recoveryError === undefined ? {} : { recoveryError: Object.freeze({ ...outcome.recoveryError }) }),
    ...(writeState === undefined ? {} : { writeState }),
  });
}

function freezeCleanupRetry(outcome: RecoveryCleanupRetryOutcome): RecoveryCleanupRetryOutcome {
  return Object.freeze({
    status: outcome.status,
    recoveryRequired: outcome.recoveryRequired,
    ...(outcome.error === undefined ? {} : { error: Object.freeze({ ...outcome.error }) }),
  });
}

function snapshotFailure(error: unknown): SaveFailure {
  if (error instanceof HostError) return Object.freeze({ code: error.code, message: error.message });
  if (typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { message?: unknown }).message === 'string') {
    return Object.freeze({
      code: (error as { code: string }).code,
      message: (error as { message: string }).message,
    });
  }
  if (error instanceof Error) return Object.freeze({ code: 'unknown', message: error.message });
  return Object.freeze({ code: 'unknown', message: 'Unknown save failure.' });
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sessionMatches(session: DocumentSession, generation: number, path: string, text: string): boolean {
  return session.generation === generation && session.snapshot().files.get(path)?.text === text;
}

function snapshotFilesMatch(
  session: DocumentSession,
  expected: ReturnType<DocumentSession['snapshot']>,
): boolean {
  const current = session.snapshot();
  if (current.entryPath !== expected.entryPath || current.files.size !== expected.files.size) return false;
  for (const [path, buffer] of expected.files) {
    if (current.files.get(path)?.text !== buffer.text) return false;
  }
  return true;
}

function localChangedFailure(operation: 'save' | 'reload' | 'overwrite', path: string): SaveFailure {
  const action = operation === 'save'
    ? 'preparing save'
    : operation === 'reload'
      ? 'preparing reload'
      : 'preparing overwrite';
  return Object.freeze({ code: 'local-changed', message: `Local source changed while ${action}: ${path}` });
}

function freezeExternalOutcomes(outcomes: readonly ExternalChangeOutcome[]): readonly ExternalChangeOutcome[] {
  return Object.freeze(outcomes.map((outcome) => Object.freeze({
    ...outcome,
    ...(outcome.error === undefined ? {} : { error: Object.freeze({ ...outcome.error }) }),
  })));
}

function freezeExternalResolution(outcome: ExternalResolutionOutcome): ExternalResolutionOutcome {
  return Object.freeze({
    ...outcome,
    ...(outcome.error === undefined ? {} : { error: Object.freeze({ ...outcome.error }) }),
  });
}
