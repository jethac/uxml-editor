import type { ElementLocator } from '../documents/ElementLocator';

export interface RecoverySavePreparation {
  readonly entryPath: string;
  readonly baseFiles: ReadonlyMap<string, string>;
  readonly targetFiles: ReadonlyMap<string, string>;
  readonly dirtyPaths: readonly string[];
  readonly selectionAfter: readonly ElementLocator[];
}

export interface RecoveryJournalOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export type RecoveryStatus = 'none' | 'recovered';

export interface RecoveryOutcome {
  readonly status: RecoveryStatus;
  readonly recordCount: number;
  readonly transactionIds: readonly string[];
}

export type RecoveryJournalErrorCode =
  | 'corrupt-journal'
  | 'version-mismatch'
  | 'project-mismatch'
  | 'unsafe-path'
  | 'invalid-record'
  | 'stale-base'
  | 'append-discontinuity'
  | 'record-too-large'
  | 'replay-failed'
  | 'cleanup-failed';

export class RecoveryJournalError extends Error {
  constructor(readonly code: RecoveryJournalErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RecoveryJournalError';
  }
}
