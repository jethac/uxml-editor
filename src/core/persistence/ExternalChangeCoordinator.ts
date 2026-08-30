import type { DocumentSession } from '../documents/DocumentSession';
import {
  HostError,
  projectPath,
  type Disposable,
  type DisposalOutcome,
  type FileReadResult,
  type HostPort,
  type ProjectRoot,
} from '../host/HostPort';
import {
  freezeExternalOutcomes,
  freezeExternalResolution,
  localChangedFailure,
  snapshotFailure,
} from './PersistenceOutcomes';
import { RecoveryLifecycle } from './RecoveryLifecycle';
import type {
  ExternalChangeDecision,
  ExternalChangeListener,
  ExternalChangeOutcome,
  ExternalResolutionOutcome,
} from './SaveCoordinatorContracts';
import { SavedFileRegistry } from './SavedFileRegistry';
import { comparePaths, sessionMatches } from './SessionPersistenceSnapshot';

export class ExternalChangeCoordinator {
  private readonly pending = new Map<string, FileReadResult | null>();
  private sequence = 1;

  constructor(
    private readonly host: HostPort,
    private readonly root: ProjectRoot,
    private readonly saved: SavedFileRegistry,
    private readonly recovery: RecoveryLifecycle,
  ) {}

  async process(
    session: DocumentSession,
    candidatePaths: readonly string[],
  ): Promise<readonly ExternalChangeOutcome[]> {
    return this.processWhile(session, candidatePaths, () => true);
  }

  async resolve(
    session: DocumentSession,
    candidatePath: string,
    decision: ExternalChangeDecision,
  ): Promise<ExternalResolutionOutcome> {
    const path = projectPath(this.root, candidatePath).relativePath;
    if (!this.pending.has(path)) throw new Error(`No external change is pending for ${path}.`);
    const pending = this.pending.get(path) ?? null;
    const baseline = this.saved.get(path);
    const generation = session.generation;
    const local = session.snapshot().files.get(path);
    if (!baseline || !local) throw new Error(`External-change baseline is missing for ${path}.`);
    const localDirty = local.text !== baseline.text;
    if (decision === 'cancel') {
      this.pending.delete(path);
      return freezeExternalResolution({
        path,
        decision,
        status: 'cancelled',
        external: pending === null ? 'deleted' : 'changed',
        ...(pending === null ? {} : { revision: pending.revision }),
        localDirty,
      });
    }
    if (decision === 'reload') return this.reload(session, path, pending, baseline.path, generation, local.text, localDirty);
    if (pending === null) return this.restoreDeleted(session, path, baseline.path, generation, local.text, localDirty);
    const overwritePreparation = await this.recovery.prepareOverwrite(
      session,
      generation,
      session.snapshot(),
      path,
      pending,
    );
    if (overwritePreparation !== null) {
      return freezeExternalResolution({
        path,
        decision,
        status: overwritePreparation.code === 'local-changed' ? 'conflict' : 'failed',
        external: 'changed',
        revision: pending.revision,
        localDirty: this.saved.dirtyPaths(session).includes(path),
        error: overwritePreparation,
      });
    }
    try {
      const revision = await this.host.replaceTextAtomically(baseline.path, pending.revision, local.text);
      this.saved.publish(path, local.text, revision);
      this.pending.delete(path);
      const recoveryFinalization = await this.recovery.finalizeConfirmedWrite(session);
      if (recoveryFinalization.status === 'failed') {
        return freezeExternalResolution({
          path,
          decision,
          status: 'failed',
          external: 'changed',
          revision,
          localDirty: this.saved.dirtyPaths(session).includes(path),
          error: recoveryFinalization.error,
        });
      }
      if (!sessionMatches(session, generation, path, local.text)) {
        return freezeExternalResolution({
          path,
          decision,
          status: 'conflict',
          external: 'changed',
          revision,
          localDirty: this.saved.dirtyPaths(session).includes(path),
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
    let lifecycle = 0;
    let timer: Disposable | undefined;
    const pendingPaths = new Set<string>();
    let settled = false;
    let resolveCompletion!: (outcome: DisposalOutcome) => void;
    const completion = new Promise<DisposalOutcome>((resolve) => { resolveCompletion = resolve; });
    const settle = (outcome: DisposalOutcome) => {
      if (settled) return;
      settled = true;
      resolveCompletion(outcome);
    };
    const fail = (error: unknown) => {
      const failure = error instanceof HostError
        ? error
        : new HostError('read-failed', 'External-change watch callback failed.', error);
      settle(Object.freeze({ status: 'failed', error: failure }));
    };
    const hostWatcher = await this.host.watch(this.root, (event) => {
      try {
        if (disposed) return;
        if (event.kind === 'rescan-required') {
          for (const path of session().snapshot().files.keys()) {
            if (this.saved.has(path)) pendingPaths.add(path);
          }
        } else {
          if (!this.saved.has(event.path.relativePath)) return;
          pendingPaths.add(event.path.relativePath);
        }
        timer?.dispose();
        timer = this.host.schedule(debounceMs, async () => {
          timer = undefined;
          if (disposed) return;
          const paths = [...pendingPaths];
          pendingPaths.clear();
          const token = lifecycle;
          try {
            const outcomes = await this.processWhile(
              session(),
              paths,
              () => !disposed && lifecycle === token,
            );
            if (!disposed && lifecycle === token) await listener(outcomes);
          } catch (error) {
            fail(error);
          }
        });
      } catch (error) {
        fail(error);
      }
    });
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        lifecycle += 1;
        pendingPaths.clear();
        timer?.dispose();
        timer = undefined;
        hostWatcher.dispose();
        if (hostWatcher.completion === undefined) {
          settle(Object.freeze({ status: 'disposed' }));
        } else {
          void hostWatcher.completion.then(
            (outcome) => settle(outcome),
            (error) => fail(error),
          );
        }
      },
      completion,
    });
  }

  private async processWhile(
    session: DocumentSession,
    candidatePaths: readonly string[],
    isActive: () => boolean,
  ): Promise<readonly ExternalChangeOutcome[]> {
    const outcomes: ExternalChangeOutcome[] = [];
    const openPaths = session.snapshot().files;
    const paths = [...new Set(candidatePaths.map((path) => projectPath(this.root, path).relativePath))]
      .filter((path) => this.saved.has(path) && openPaths.has(path))
      .sort(comparePaths);
    for (const path of paths) {
      if (!isActive()) break;
      const baseline = this.saved.get(path);
      const generation = session.generation;
      let local = session.snapshot().files.get(path);
      if (!baseline || !local) throw new Error(`External-change baseline is missing for ${path}.`);
      let localDirty = local.text !== baseline.text;
      let disk: FileReadResult;
      try {
        disk = await this.host.readText(baseline.path);
      } catch (error) {
        if (!isActive()) break;
        if (!(error instanceof HostError) || error.code !== 'not-found') throw error;
        local = session.snapshot().files.get(path);
        if (!local) continue;
        localDirty = local.text !== baseline.text;
        this.pending.set(path, null);
        outcomes.push({
          path,
          status: localDirty ? 'conflict' : 'deleted',
          external: 'deleted',
          localDirty,
        });
        continue;
      }
      if (!isActive()) break;
      const latestLocal = session.snapshot().files.get(path);
      if (!latestLocal) continue;
      const changedDuringRead = session.generation !== generation || latestLocal.text !== local.text;
      local = latestLocal;
      localDirty = local.text !== baseline.text;
      if (disk.text === local.text) {
        this.saved.publish(path, disk.text, disk.revision);
        this.pending.delete(path);
        outcomes.push({ path, status: 'unchanged', external: 'changed', revision: disk.revision, localDirty: false });
        continue;
      }
      if (disk.text === baseline.text) {
        this.saved.publish(path, baseline.text, disk.revision);
        this.pending.delete(path);
        outcomes.push({ path, status: 'unchanged', external: 'changed', revision: disk.revision, localDirty });
        continue;
      }
      if (changedDuringRead || localDirty) {
        this.pending.set(path, disk);
        outcomes.push({
          path,
          status: 'conflict',
          external: 'changed',
          revision: disk.revision,
          localDirty,
          ...(changedDuringRead ? { concurrentSessionChange: true } : {}),
        });
        continue;
      }
      try {
        session.history.execute({
          id: `external-reload:v1:${this.sequence++}:${path}`,
          label: `Reload ${path}`,
          patchesByFile: new Map([[path, [{ start: 0, end: local.text.length, replacement: disk.text }]]]),
        });
      } catch {
        this.pending.set(path, disk);
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
      this.pending.delete(path);
      this.saved.publish(path, disk.text, disk.revision);
      outcomes.push({ path, status: 'reloaded', external: 'changed', revision: disk.revision, localDirty: false });
    }
    return freezeExternalOutcomes(outcomes);
  }

  private async reload(
    session: DocumentSession,
    path: string,
    pending: FileReadResult | null,
    baselinePath: FileReadResult['path'],
    generation: number,
    localText: string,
    localDirty: boolean,
  ): Promise<ExternalResolutionOutcome> {
    const decision = 'reload' as const;
    if (pending === null) {
      return freezeExternalResolution({ path, decision, status: 'deleted', external: 'deleted', localDirty });
    }
    let current: FileReadResult;
    try {
      current = await this.host.readText(baselinePath);
    } catch (error) {
      if (error instanceof HostError && error.code === 'not-found') {
        this.pending.set(path, null);
        return freezeExternalResolution({
          path,
          decision,
          status: 'deleted',
          external: 'deleted',
          localDirty: this.saved.dirtyPaths(session).includes(path),
        });
      }
      return freezeExternalResolution({
        path,
        decision,
        status: 'failed',
        external: 'changed',
        revision: pending.revision,
        localDirty: this.saved.dirtyPaths(session).includes(path),
        error: snapshotFailure(error),
      });
    }
    if (!sessionMatches(session, generation, path, localText)) {
      this.pending.set(path, current);
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
      this.pending.set(path, current);
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
        id: `external-reload:v1:${this.sequence++}:${path}`,
        label: `Reload ${path}`,
        patchesByFile: new Map([[path, [{ start: 0, end: localText.length, replacement: current.text }]]]),
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
    this.saved.publish(path, current.text, current.revision);
    this.pending.delete(path);
    const recoveryFinalization = await this.recovery.finalizeDiscardedChanges(session);
    if (recoveryFinalization.status === 'failed') {
      return freezeExternalResolution({
        path,
        decision,
        status: 'failed',
        external: 'changed',
        revision: current.revision,
        localDirty: this.saved.dirtyPaths(session).includes(path),
        error: recoveryFinalization.error,
      });
    }
    return freezeExternalResolution({
      path,
      decision,
      status: 'reloaded',
      external: 'changed',
      revision: current.revision,
      localDirty: false,
    });
  }

  private async restoreDeleted(
    session: DocumentSession,
    path: string,
    baselinePath: FileReadResult['path'],
    generation: number,
    localText: string,
    localDirty: boolean,
  ): Promise<ExternalResolutionOutcome> {
    const decision = 'overwrite' as const;
    const snapshot = session.snapshot();
    const preparation = await this.recovery.prepareSave(session, generation, snapshot);
    if (preparation !== null) {
      return freezeExternalResolution({
        path,
        decision,
        status: preparation.code === 'local-changed' ? 'conflict' : 'failed',
        external: 'deleted',
        localDirty: this.saved.dirtyPaths(session).includes(path),
        error: preparation,
      });
    }
    try {
      const revision = await this.host.createText(baselinePath, localText);
      this.saved.publish(path, localText, revision);
      this.pending.delete(path);
      const recoveryFinalization = await this.recovery.finalizeConfirmedWrite(session);
      if (recoveryFinalization.status === 'failed') {
        return freezeExternalResolution({
          path,
          decision,
          status: 'failed',
          external: 'deleted',
          revision,
          localDirty: this.saved.dirtyPaths(session).includes(path),
          error: recoveryFinalization.error,
        });
      }
      if (!sessionMatches(session, generation, path, localText)) {
        return freezeExternalResolution({
          path,
          decision,
          status: 'conflict',
          external: 'deleted',
          revision,
          localDirty: this.saved.dirtyPaths(session).includes(path),
          error: localChangedFailure('overwrite', path),
        });
      }
      return freezeExternalResolution({
        path,
        decision,
        status: 'overwritten',
        external: 'deleted',
        revision,
        localDirty: false,
      });
    } catch (error) {
      return freezeExternalResolution({
        path,
        decision,
        status: error instanceof HostError && error.code === 'stale-revision' ? 'conflict' : 'failed',
        external: 'deleted',
        localDirty,
        error: snapshotFailure(error),
      });
    }
  }
}
