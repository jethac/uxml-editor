import type { DocumentSession } from '../documents/DocumentSession';
import {
  HostError,
  snapshotProjectRoot,
  type FileReadResult,
  type Disposable,
  type HostPort,
  type ProjectRoot,
} from '../host/HostPort';
import { ExternalChangeCoordinator } from './ExternalChangeCoordinator';
import { localChangedFailure, snapshotFailure } from './PersistenceOutcomes';
import { RecoveryLifecycle } from './RecoveryLifecycle';
import { comparePaths, sessionMatches } from './SessionPersistenceSnapshot';
import { SavedFileRegistry } from './SavedFileRegistry';
import type {
  ExternalChangeDecision,
  ExternalChangeListener,
  ExternalChangeOutcome,
  ExternalResolutionOutcome,
  RecoveryCleanup,
  RecoveryCleanupRetryOutcome,
  SaveFailure,
  SaveFileOutcome,
  SaveOutcome,
  SaveStatus,
} from './SaveCoordinatorContracts';

export type * from './SaveCoordinatorContracts';

export class SaveCoordinator {
  private readonly root: ProjectRoot;
  private readonly saved: SavedFileRegistry;
  private readonly recovery: RecoveryLifecycle;
  private readonly external: ExternalChangeCoordinator;

  constructor(
    private readonly host: HostPort,
    root: ProjectRoot,
    initialFiles: readonly FileReadResult[],
    recoveryCleanup?: RecoveryCleanup,
  ) {
    this.root = snapshotProjectRoot(root);
    this.saved = new SavedFileRegistry(this.root, initialFiles);
    this.recovery = new RecoveryLifecycle(recoveryCleanup, this.saved);
    this.external = new ExternalChangeCoordinator(this.host, this.root, this.saved, this.recovery);
  }

  async save(session: DocumentSession, path = session.entryPath): Promise<SaveOutcome> {
    const generation = session.generation;
    const snapshot = session.snapshot();
    const file = snapshot.files.get(path);
    const baseline = this.saved.get(path);
    if (file && baseline && file.text === baseline.text) {
      return this.recovery.finish(session, {
        status: 'noop',
        files: [{ path, status: 'noop', revision: baseline.revision }],
        dirtyPaths: this.dirtyPaths(session),
        recovery: 'not-requested',
      });
    }
    if (!file || !baseline) throw new Error(`Save baseline is missing for ${path}.`);
    const preparationError = await this.recovery.prepareSave(session, generation, snapshot);
    if (preparationError !== null) {
      const recoveryError = preparationError.code === 'local-changed'
        ? await this.recovery.replan(session)
        : preparationError;
      return this.recovery.finish(session, {
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
        const recoveryError = await this.recovery.replan(session);
        return this.recovery.finish(session, {
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
      this.saved.publish(path, file.text, revision);
      let dirtyPaths = this.dirtyPaths(session);
      const recoveryError = dirtyPaths.length > 0 && session.generation !== generation
        ? await this.recovery.replan(session)
        : null;
      dirtyPaths = this.dirtyPaths(session);
      return this.recovery.finish(session, {
        status: dirtyPaths.length === 0 ? 'saved' : 'partial',
        files: [{ path, status: 'saved', revision }],
        dirtyPaths,
        recovery: recoveryError === null ? 'not-requested' : 'failed',
        ...(recoveryError === null ? {} : { recoveryError }),
      });
    } catch (error) {
      const conflict = error instanceof HostError && (error.code === 'stale-revision' || error.code === 'not-found');
      return this.recovery.finish(session, {
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

    const preparationError = await this.recovery.prepareSave(session, generation, snapshot);
    if (preparationError !== null) {
      const recoveryError = preparationError.code === 'local-changed'
        ? await this.recovery.replan(session)
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
      return this.recovery.finish(session, {
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
          recoveryReplanError = await this.recovery.replan(session);
          terminalStatus = 'conflict';
          files.push({ path, status: 'conflict', error: localChangedFailure('save', path) });
          stopped = true;
          continue;
        }
        if (disk.text !== baseline.text) {
          throw new HostError('stale-revision', `File changed before replacement: ${path}`);
        }
        const revision = await this.host.replaceTextAtomically(baseline.path, disk.revision, file.text);
        this.saved.publish(path, file.text, revision);
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
        ? await this.recovery.replan(session)
        : null
    );
    dirtyPaths = this.dirtyPaths(session);
    return this.recovery.finish(session, {
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
    return this.external.process(session, candidatePaths);
  }

  async resolveExternalChange(
    session: DocumentSession,
    candidatePath: string,
    decision: ExternalChangeDecision,
  ): Promise<ExternalResolutionOutcome> {
    return this.external.resolve(session, candidatePath, decision);
  }

  async watch(
    session: () => DocumentSession,
    listener: ExternalChangeListener,
    debounceMs = 50,
  ): Promise<Disposable> {
    return this.external.watch(session, listener, debounceMs);
  }

  dirtyPaths(session: DocumentSession): readonly string[] {
    return this.saved.dirtyPaths(session);
  }

  async retryRecoveryCleanup(session: DocumentSession): Promise<RecoveryCleanupRetryOutcome> {
    return this.recovery.retryCleanup(session);
  }

}
