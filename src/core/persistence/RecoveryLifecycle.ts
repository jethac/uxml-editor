import type { DocumentSession } from '../documents/DocumentSession';
import type { FileReadResult } from '../host/HostPort';
import {
  freezeCleanupRetry,
  freezeSaveOutcome,
  localChangedFailure,
  recoveryUnsupportedFailure,
  snapshotFailure,
} from './PersistenceOutcomes';
import type {
  RecoveryCleanup,
  RecoveryCleanupRetryOutcome,
  SaveFailure,
  SaveOutcome,
} from './SaveCoordinatorContracts';
import { SavedFileRegistry } from './SavedFileRegistry';
import { comparePaths, snapshotFilesMatch } from './SessionPersistenceSnapshot';

export class RecoveryLifecycle {
  private cleanupPending = false;

  constructor(
    private readonly cleanup: RecoveryCleanup | undefined,
    private readonly saved: SavedFileRegistry,
  ) {}

  async prepareSave(
    session: DocumentSession,
    generation: number,
    snapshot: ReturnType<DocumentSession['snapshot']>,
  ): Promise<SaveFailure | null> {
    const dirtyPaths = Object.freeze([...snapshot.files]
      .filter(([path, buffer]) => this.saved.get(path)?.text !== buffer.text)
      .map(([path]) => path)
      .sort(comparePaths));
    if (dirtyPaths.length === 0) return null;
    if (typeof this.cleanup?.prepareSave !== 'function') return recoveryUnsupportedFailure();
    const targetFiles = snapshotTextFiles(snapshot);
    try {
      await this.cleanup.prepareSave({
        entryPath: snapshot.entryPath,
        baseFiles: this.saved.baseTextFiles(),
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

  async prepareOverwrite(
    session: DocumentSession,
    generation: number,
    snapshot: ReturnType<DocumentSession['snapshot']>,
    path: string,
    pending: FileReadResult,
  ): Promise<SaveFailure | null> {
    if (typeof this.cleanup?.prepareSave !== 'function') return recoveryUnsupportedFailure();
    const baseFiles = this.saved.baseTextFiles(new Map([[path, pending.text]]));
    const targetFiles = snapshotTextFiles(snapshot);
    const dirtyPaths = Object.freeze([...targetFiles]
      .filter(([savedPath, text]) => baseFiles.get(savedPath) !== text)
      .map(([savedPath]) => savedPath)
      .sort(comparePaths));
    try {
      await this.cleanup.prepareSave({
        entryPath: snapshot.entryPath,
        baseFiles,
        targetFiles,
        dirtyPaths,
        selectionAfter: session.selection,
      });
    } catch {
      return Object.freeze({
        code: 'recovery-prepare-failed',
        message: 'Recovery state could not be persisted before overwrite.',
      });
    }
    if (session.generation !== generation || !snapshotFilesMatch(session, snapshot)) {
      return localChangedFailure('overwrite', path);
    }
    return null;
  }

  async replan(session: DocumentSession): Promise<SaveFailure | null> {
    if (typeof this.cleanup?.prepareSave !== 'function') return null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generation = session.generation;
      const snapshot = session.snapshot();
      const error = await this.prepareSave(session, generation, snapshot);
      if (error === null || error.code !== 'local-changed') return error;
    }
    return Object.freeze({
      code: 'local-changed',
      message: 'Local source kept changing while recovery was being replanned.',
    });
  }

  async retryCleanup(session: DocumentSession): Promise<RecoveryCleanupRetryOutcome> {
    if (!this.cleanupPending || !this.cleanup) {
      return freezeCleanupRetry({ status: 'not-pending', recoveryRequired: false });
    }
    if (this.saved.dirtyPaths(session).length > 0) {
      return freezeCleanupRetry({ status: 'blocked', recoveryRequired: true });
    }
    const generation = session.generation;
    const snapshot = session.snapshot();
    try {
      await this.cleanup.clear();
      this.cleanupPending = false;
      if (session.generation !== generation || !snapshotFilesMatch(session, snapshot)) {
        const dirtyPaths = this.saved.dirtyPaths(session);
        if (dirtyPaths.length > 0) {
          const recoveryError = await this.replan(session);
          this.cleanupPending = recoveryError !== null;
          return recoveryError === null
            ? freezeCleanupRetry({ status: 'retained', recoveryRequired: true })
            : freezeCleanupRetry({ status: 'failed', recoveryRequired: true, error: recoveryError });
        }
      }
      return freezeCleanupRetry({ status: 'cleared', recoveryRequired: false });
    } catch (error) {
      this.cleanupPending = true;
      if ((session.generation !== generation || !snapshotFilesMatch(session, snapshot))
        && this.saved.dirtyPaths(session).length > 0) {
        await this.replan(session);
      }
      return freezeCleanupRetry({ status: 'failed', recoveryRequired: true, error: snapshotFailure(error) });
    }
  }

  async finish(session: DocumentSession, outcome: Omit<SaveOutcome, 'recoveryRequired'>): Promise<SaveOutcome> {
    const shouldClear = this.cleanup !== undefined
      && outcome.dirtyPaths.length === 0
      && (outcome.status === 'saved' || this.cleanupPending);
    if (!shouldClear) return freezeSaveOutcome(outcome, this.cleanupPending);
    const generation = session.generation;
    try {
      await this.cleanup.clear();
      this.cleanupPending = false;
      let dirtyPaths = this.saved.dirtyPaths(session);
      if (session.generation !== generation && dirtyPaths.length > 0) {
        const recoveryError = typeof this.cleanup.prepareSave === 'function'
          ? await this.replan(session)
          : Object.freeze({
            code: 'recovery-prepare-failed',
            message: 'Recovery state could not be restored after cleanup raced with a local edit.',
          });
        dirtyPaths = this.saved.dirtyPaths(session);
        this.cleanupPending = recoveryError !== null;
        const wroteAny = outcome.files.some((file) => file.status === 'saved');
        return freezeSaveOutcome({
          ...outcome,
          status: wroteAny ? 'partial' : 'conflict',
          dirtyPaths,
          recovery: recoveryError === null ? 'retained' : 'failed',
          ...(recoveryError === null ? { recoveryError: undefined } : { recoveryError }),
        }, this.cleanupPending);
      }
      return freezeSaveOutcome({ ...outcome, recovery: 'cleared' });
    } catch (error) {
      this.cleanupPending = true;
      let dirtyPaths = this.saved.dirtyPaths(session);
      if (session.generation !== generation && dirtyPaths.length > 0
        && typeof this.cleanup.prepareSave === 'function') {
        await this.replan(session);
        dirtyPaths = this.saved.dirtyPaths(session);
        const wroteAny = outcome.files.some((file) => file.status === 'saved');
        return freezeSaveOutcome({
          ...outcome,
          status: wroteAny ? 'partial' : 'conflict',
          dirtyPaths,
          recovery: 'failed',
          recoveryError: snapshotFailure(error),
        }, true);
      }
      return freezeSaveOutcome({ ...outcome, recovery: 'failed', recoveryError: snapshotFailure(error) });
    }
  }
}

function snapshotTextFiles(
  snapshot: ReturnType<DocumentSession['snapshot']>,
): ReadonlyMap<string, string> {
  return new Map([...snapshot.files]
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([path, buffer]) => [path, buffer.text]));
}
