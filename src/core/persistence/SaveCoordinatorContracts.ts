import type { ElementLocator } from '../documents/ElementLocator';
import type { FileRevision } from '../host/HostPort';

export type SaveFileStatus = 'noop' | 'saved' | 'conflict' | 'failed' | 'skipped';
export type SaveStatus = 'noop' | 'saved' | 'partial' | 'conflict' | 'failed';
export type RecoveryCleanupStatus = 'not-requested' | 'cleared' | 'retained' | 'failed';

export interface SaveFailure {
  readonly code: string;
  readonly message: string;
}

export interface SaveFileOutcome {
  readonly path: string;
  readonly status: SaveFileStatus;
  readonly revision?: FileRevision;
  readonly error?: SaveFailure;
}

export interface SaveWriteState {
  readonly writtenPaths: readonly string[];
  readonly pendingPaths: readonly string[];
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
  readonly status: 'not-pending' | 'blocked' | 'cleared' | 'retained' | 'failed';
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
