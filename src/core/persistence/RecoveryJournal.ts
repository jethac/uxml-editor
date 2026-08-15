import { copyEditorTransaction } from '../commands/EditorTransaction';
import type { CommitResult, DocumentSession } from '../documents/DocumentSession';
import {
  normalizeRelativePath,
  snapshotProjectRoot,
  type HostPort,
  type ProjectRoot,
} from '../host/HostPort';
import {
  JOURNAL_VERSION,
  compareRecoveryPaths,
  encodeBoundedJournal,
  parseStoredJournal,
  positiveRecoveryLimit,
  serializeSnapshot,
  serializeTextFiles,
  serializeTransaction,
  serializedFilePathsEqual,
  serializedFilesEqual,
  stringArraysEqual,
  validateRecordChain,
  type SerializedJournal,
} from './RecoveryJournalCodec';
import {
  RecoveryJournalError,
  type RecoveryJournalOptions,
  type RecoveryOutcome,
  type RecoverySavePreparation,
} from './RecoveryJournalContracts';
import { noRecoveryOutcome, replayRecoveryJournal } from './RecoveryJournalReplay';

export { RecoveryJournalError } from './RecoveryJournalContracts';
export type * from './RecoveryJournalContracts';

export class RecoveryJournal {
  private readonly root: ProjectRoot;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly host: HostPort, root: ProjectRoot, options: RecoveryJournalOptions = {}) {
    this.root = snapshotProjectRoot(root);
    this.maxEntries = positiveRecoveryLimit(options.maxEntries ?? 128, 'maxEntries');
    this.maxBytes = positiveRecoveryLimit(options.maxBytes ?? 4 * 1024 * 1024, 'maxBytes');
  }

  async prepareSave(input: RecoverySavePreparation): Promise<void> {
    const entryPath = normalizeRelativePath(input.entryPath);
    const base = serializeTextFiles(input.baseFiles);
    const target = serializeTextFiles(input.targetFiles);
    if (!base.some((file) => file.path === entryPath) || !serializedFilePathsEqual(base, target)) {
      throw new RecoveryJournalError('append-discontinuity', 'Recovery save checkpoint files do not match the open session.');
    }
    const dirtyPaths = Object.freeze([...new Set(input.dirtyPaths.map(normalizeRelativePath))].sort(compareRecoveryPaths));
    const expectedDirty = base
      .filter((file, index) => file.text !== target[index]!.text)
      .map((file) => file.path);
    if (!stringArraysEqual(dirtyPaths, expectedDirty)) {
      throw new RecoveryJournalError('append-discontinuity', 'Recovery save checkpoint dirty paths are inconsistent.');
    }
    const patchesByFile = new Map(dirtyPaths.map((path) => {
      const before = base.find((file) => file.path === path)!;
      const after = target.find((file) => file.path === path)!;
      return [path, Object.freeze([{ start: 0, end: before.text.length, replacement: after.text }])] as const;
    }));
    const transaction = serializeTransaction(copyEditorTransaction({
      id: 'recovery-save-checkpoint:v1',
      label: 'Recover unsaved save checkpoint',
      patchesByFile,
      selectionAfter: input.selectionAfter,
    }));
    const next: SerializedJournal = {
      version: JOURNAL_VERSION,
      compaction: 0,
      projectId: this.root.id,
      entryPath,
      base,
      records: [{ sequence: 1, transaction, after: target }],
      prepared: {
        sequence: 1,
        files: Object.freeze(target.filter((file) => dirtyPaths.includes(file.path))),
      },
    };
    validateRecordChain(next);
    await this.host.writeRecovery(this.root.id, encodeBoundedJournal(next, this.maxEntries, this.maxBytes));
  }

  appendCommitted(result: CommitResult): Promise<void> {
    const queued = this.appendQueue.then(() => this.appendCommittedSerialized(result));
    this.appendQueue = queued.catch(() => undefined);
    return queued;
  }

  async recover(session: DocumentSession): Promise<RecoveryOutcome> {
    const stored = await this.host.readRecovery(this.root.id);
    if (stored === null) return noRecoveryOutcome();
    const journal = parseStoredJournal(stored);
    if (journal.projectId !== this.root.id || journal.entryPath !== session.entryPath) {
      throw new RecoveryJournalError('project-mismatch', 'Recovery journal does not match the opened project session.');
    }
    return replayRecoveryJournal(session, journal);
  }

  async clear(): Promise<void> {
    try {
      await this.host.clearRecovery(this.root.id);
    } catch (error) {
      throw new RecoveryJournalError('cleanup-failed', 'Recovery journal cleanup failed.', error);
    }
  }

  private async appendCommittedSerialized(result: CommitResult): Promise<void> {
    const transaction = serializeTransaction(copyEditorTransaction(result.forward));
    const before = serializeSnapshot(result.before);
    const after = serializeSnapshot(result.after);
    const stored = await this.host.readRecovery(this.root.id);
    const journal: SerializedJournal = stored === null
      ? {
        version: JOURNAL_VERSION,
        compaction: 0,
        projectId: this.root.id,
        entryPath: normalizeRelativePath(result.before.entryPath),
        base: before,
        records: [],
        prepared: null,
      }
      : parseStoredJournal(stored);
    if (journal.projectId !== this.root.id || journal.entryPath !== normalizeRelativePath(result.before.entryPath)) {
      throw new RecoveryJournalError('append-discontinuity', 'Committed result does not match the stored journal project.');
    }
    validateRecordChain(journal);
    const expectedBefore = journal.records.at(-1)?.after ?? journal.base;
    if (!serializedFilesEqual(expectedBefore, before)) {
      throw new RecoveryJournalError('append-discontinuity', 'Committed result is discontinuous with the stored journal.');
    }
    validateRecordChain({
      version: JOURNAL_VERSION,
      compaction: journal.compaction,
      projectId: this.root.id,
      entryPath: journal.entryPath,
      base: before,
      records: [{ sequence: 1, transaction, after }],
      prepared: null,
    });
    const next: SerializedJournal = {
      version: JOURNAL_VERSION,
      compaction: journal.compaction,
      projectId: this.root.id,
      entryPath: journal.entryPath,
      base: journal.base,
      records: [
        ...journal.records,
        { sequence: journal.records.length + 1, transaction, after },
      ],
      prepared: journal.prepared,
    };
    await this.host.writeRecovery(this.root.id, encodeBoundedJournal(next, this.maxEntries, this.maxBytes));
  }
}
