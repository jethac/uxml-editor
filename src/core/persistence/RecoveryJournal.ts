import type { CommitResult, DocumentSession, DocumentSnapshot } from '../documents/DocumentSession';
import type { ElementLocator } from '../documents/ElementLocator';
import { copyEditorTransaction, type EditorTransaction } from '../commands/EditorTransaction';
import { applyPatches, type SourcePatch } from '../commands/SourcePatch';
import {
  normalizeRelativePath,
  snapshotProjectRoot,
  type HostPort,
  type ProjectRoot,
} from '../host/HostPort';

const JOURNAL_VERSION = 1;

interface SerializedFile {
  readonly path: string;
  readonly text: string;
}

interface SerializedPatchFile {
  readonly path: string;
  readonly patches: readonly SourcePatch[];
}

interface SerializedTransaction {
  readonly id: string;
  readonly label: string;
  readonly patches: readonly SerializedPatchFile[];
  readonly selectionAfter?: readonly ElementLocator[];
  readonly coalesceKey?: string;
}

interface SerializedRecord {
  readonly sequence: number;
  readonly transaction: SerializedTransaction;
  readonly after: readonly SerializedFile[];
}

interface SerializedJournal {
  readonly version: number;
  readonly compaction: number;
  readonly projectId: string;
  readonly entryPath: string;
  readonly base: readonly SerializedFile[];
  readonly records: readonly SerializedRecord[];
  readonly prepared: SerializedPreparedSave | null;
}

interface SerializedPreparedSave {
  readonly sequence: number;
  readonly files: readonly SerializedFile[];
}

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
  | 'stale-base'
  | 'invalid-record'
  | 'unsafe-path'
  | 'replay-failed'
  | 'append-discontinuity'
  | 'record-too-large'
  | 'cleanup-failed';

export class RecoveryJournalError extends Error {
  constructor(readonly code: RecoveryJournalErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RecoveryJournalError';
  }
}

export class RecoveryJournal {
  private readonly root: ProjectRoot;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(private readonly host: HostPort, root: ProjectRoot, options: RecoveryJournalOptions = {}) {
    this.root = snapshotProjectRoot(root);
    this.maxEntries = positiveSafeInteger(options.maxEntries ?? 128, 'maxEntries');
    this.maxBytes = positiveSafeInteger(options.maxBytes ?? 4 * 1024 * 1024, 'maxBytes');
  }

  async prepareSave(input: RecoverySavePreparation): Promise<void> {
    const entryPath = normalizeRelativePath(input.entryPath);
    const base = serializeTextFiles(input.baseFiles);
    const target = serializeTextFiles(input.targetFiles);
    if (!base.some((file) => file.path === entryPath) || !serializedFilePathsEqual(base, target)) {
      throw new RecoveryJournalError('append-discontinuity', 'Recovery save checkpoint files do not match the open session.');
    }
    const dirtyPaths = Object.freeze([...new Set(input.dirtyPaths.map(normalizeRelativePath))].sort(comparePaths));
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
    await this.host.writeRecovery(this.root.id, this.encodeBounded(next));
  }

  async appendCommitted(result: CommitResult): Promise<void> {
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
        {
          sequence: journal.records.length + 1,
          transaction,
          after,
        },
      ],
      prepared: journal.prepared,
    };
    await this.host.writeRecovery(this.root.id, this.encodeBounded(next));
  }

  async recover(session: DocumentSession): Promise<RecoveryOutcome> {
    const stored = await this.host.readRecovery(this.root.id);
    if (stored === null) return freezeOutcome({ status: 'none', recordCount: 0, transactionIds: [] });
    const journal = parseStoredJournal(stored);
    if (journal.projectId !== this.root.id || journal.entryPath !== session.entryPath) {
      throw new RecoveryJournalError('project-mismatch', 'Recovery journal does not match the opened project session.');
    }
    const transactions = validateRecordChain(journal);
    const convergedThrough = recoveryConvergence(session.snapshot(), journal);
    const replayTransactions = transactions.map((transaction, index) => copyEditorTransaction({
      ...transaction,
      patchesByFile: new Map([...transaction.patchesByFile]
        .filter(([path]) => (convergedThrough.get(path) ?? 0) < index + 1)),
    }));
    try {
      session.history.replay(replayTransactions);
    } catch (error) {
      throw new RecoveryJournalError('replay-failed', 'Recovery replay failed atomically.', error);
    }
    return freezeOutcome({
      status: 'recovered',
      recordCount: transactions.length,
      transactionIds: replayTransactions.map((transaction) => transaction.id),
    });
  }

  async clear(): Promise<void> {
    try {
      await this.host.clearRecovery(this.root.id);
    } catch (error) {
      throw new RecoveryJournalError('cleanup-failed', 'Recovery journal cleanup failed.', error);
    }
  }

  private encodeBounded(journal: SerializedJournal): string {
    validateRecordChain(journal);
    let candidate = journal.records.length > this.maxEntries ? compactJournal(journal) : journal;
    let encoded = JSON.stringify(candidate);
    if (utf8ByteLength(encoded) > this.maxBytes) {
      candidate = candidate === journal ? compactJournal(journal) : candidate;
      encoded = JSON.stringify(candidate);
    }
    if (candidate.records.length > this.maxEntries || utf8ByteLength(encoded) > this.maxBytes) {
      throw new RecoveryJournalError('record-too-large', 'Recovery record exceeds the configured journal bounds.');
    }
    validateRecordChain(candidate);
    return encoded;
  }
}

function serializeSnapshot(snapshot: DocumentSnapshot): readonly SerializedFile[] {
  return Object.freeze([...snapshot.files]
    .map(([path, buffer]) => Object.freeze({ path: normalizeRelativePath(path), text: buffer.text }))
    .sort((left, right) => comparePaths(left.path, right.path)));
}

function serializeTextFiles(files: ReadonlyMap<string, string>): readonly SerializedFile[] {
  return Object.freeze([...files]
    .map(([path, text]) => Object.freeze({ path: normalizeRelativePath(path), text }))
    .sort((left, right) => comparePaths(left.path, right.path)));
}

function serializeTransaction(transaction: EditorTransaction): SerializedTransaction {
  return Object.freeze({
    id: transaction.id,
    label: transaction.label,
    patches: Object.freeze([...transaction.patchesByFile]
      .map(([path, patches]) => Object.freeze({
        path: normalizeRelativePath(path),
        patches: Object.freeze(patches.map((patch) => Object.freeze({ ...patch }))),
      }))
      .sort((left, right) => comparePaths(left.path, right.path))),
    ...(transaction.selectionAfter === undefined ? {} : { selectionAfter: transaction.selectionAfter }),
    ...(transaction.coalesceKey === undefined ? {} : { coalesceKey: transaction.coalesceKey }),
  });
}

function deserializeTransaction(transaction: SerializedTransaction): EditorTransaction {
  return copyEditorTransaction({
    id: transaction.id,
    label: transaction.label,
    patchesByFile: new Map(transaction.patches.map((entry) => [entry.path, entry.patches])),
    ...(transaction.selectionAfter === undefined ? {} : { selectionAfter: transaction.selectionAfter }),
    ...(transaction.coalesceKey === undefined ? {} : { coalesceKey: transaction.coalesceKey }),
  });
}

function parseStoredJournal(stored: string): SerializedJournal {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch (error) {
    throw new RecoveryJournalError('corrupt-journal', 'Recovery journal JSON is truncated or invalid.', error);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RecoveryJournalError('corrupt-journal', 'Recovery journal must be an object.');
  }
  const journal = value as Partial<SerializedJournal>;
  if (typeof journal.version === 'number' && journal.version !== JOURNAL_VERSION) {
    throw new RecoveryJournalError('version-mismatch', `Unsupported recovery journal version: ${journal.version}`);
  }
  if (journal.version !== JOURNAL_VERSION
    || !Number.isSafeInteger(journal.compaction) || (journal.compaction as number) < 0
    || typeof journal.projectId !== 'string' || journal.projectId.length === 0
    || !Array.isArray(journal.base) || !Array.isArray(journal.records)) {
    throw new RecoveryJournalError('corrupt-journal', 'Recovery journal schema is invalid.');
  }
  assertExactKeys(journal, ['version', 'compaction', 'projectId', 'entryPath', 'base', 'records', 'prepared'], 'corrupt-journal');
  const entryPath = validateSafePath(journal.entryPath, 'entryPath');
  const base = validateFiles(journal.base, 'base');
  const records = Object.freeze(journal.records.map((record, index) => {
    if (!isRecord(record)) throw invalidRecord(`Record ${index + 1} must be an object.`);
    assertExactKeys(record, ['sequence', 'transaction', 'after'], 'invalid-record');
    if (record.sequence !== index + 1) throw invalidRecord(`Record ${index + 1} has an invalid sequence.`);
    const transaction = validateTransaction(record.transaction, index + 1);
    return Object.freeze({
      sequence: index + 1,
      transaction,
      after: validateFiles(record.after, `records[${index}].after`),
    });
  }));
  const prepared = validatePreparedSave(journal.prepared, records);
  return Object.freeze({
    version: JOURNAL_VERSION,
    compaction: journal.compaction as number,
    projectId: journal.projectId,
    entryPath,
    base,
    records,
    prepared,
  });
}

function validatePreparedSave(
  value: unknown,
  records: readonly SerializedRecord[],
): SerializedPreparedSave | null {
  if (value === null) return null;
  if (!isRecord(value)) throw invalidRecord('prepared must be an object or null.');
  assertExactKeys(value, ['sequence', 'files'], 'invalid-record');
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || (value.sequence as number) > records.length) {
    throw invalidRecord('prepared has an invalid sequence.');
  }
  const files = validateFiles(value.files, 'prepared.files');
  const checkpoint = records[(value.sequence as number) - 1]!.after;
  for (const file of files) {
    if (!checkpoint.some((candidate) => candidate.path === file.path && candidate.text === file.text)) {
      throw invalidRecord(`prepared file ${file.path} does not match its checkpoint sequence.`);
    }
  }
  return Object.freeze({ sequence: value.sequence as number, files });
}

function validateFiles(value: unknown, field: string): readonly SerializedFile[] {
  if (!Array.isArray(value)) throw invalidRecord(`${field} must be an array.`);
  let previous: string | undefined;
  return Object.freeze(value.map((file, index) => {
    if (!isRecord(file)) throw invalidRecord(`${field}[${index}] must be an object.`);
    assertExactKeys(file, ['path', 'text'], 'invalid-record');
    const path = validateSafePath(file.path, `${field}[${index}].path`);
    if (typeof file.text !== 'string') throw invalidRecord(`${field}[${index}].text must be a string.`);
    if (previous !== undefined && comparePaths(previous, path) >= 0) {
      throw invalidRecord(`${field} paths must be unique and canonically sorted.`);
    }
    previous = path;
    return Object.freeze({ path, text: file.text });
  }));
}

function validateTransaction(value: unknown, sequence: number): SerializedTransaction {
  if (!isRecord(value)) throw invalidRecord(`Record ${sequence} transaction must be an object.`);
  assertExactKeys(value, ['id', 'label', 'patches', 'selectionAfter', 'coalesceKey'], 'invalid-record', true);
  if (typeof value.id !== 'string' || value.id.length === 0) throw invalidRecord(`Record ${sequence} has an invalid transaction id.`);
  if (typeof value.label !== 'string' || value.label.length === 0) throw invalidRecord(`Record ${sequence} has an invalid transaction label.`);
  if (!Array.isArray(value.patches)) throw invalidRecord(`Record ${sequence} patches must be an array.`);
  if (value.coalesceKey !== undefined && (typeof value.coalesceKey !== 'string' || value.coalesceKey.length === 0)) {
    throw invalidRecord(`Record ${sequence} has an invalid coalesce key.`);
  }
  let previousPath: string | undefined;
  const patches = Object.freeze(value.patches.map((entry, fileIndex) => {
    if (!isRecord(entry)) throw invalidRecord(`Record ${sequence} patch file ${fileIndex} must be an object.`);
    assertExactKeys(entry, ['path', 'patches'], 'invalid-record');
    const path = validateSafePath(entry.path, `records[${sequence - 1}].transaction.patches[${fileIndex}].path`);
    if (previousPath !== undefined && comparePaths(previousPath, path) >= 0) {
      throw invalidRecord(`Record ${sequence} patch paths must be unique and canonically sorted.`);
    }
    previousPath = path;
    if (!Array.isArray(entry.patches)) throw invalidRecord(`Record ${sequence} patches for ${path} must be an array.`);
    return Object.freeze({
      path,
      patches: Object.freeze(entry.patches.map((patch, patchIndex) => validatePatch(patch, sequence, path, patchIndex))),
    });
  }));
  const selectionAfter = value.selectionAfter === undefined
    ? undefined
    : validateSelection(value.selectionAfter, sequence);
  return Object.freeze({
    id: value.id,
    label: value.label,
    patches,
    ...(selectionAfter === undefined ? {} : { selectionAfter }),
    ...(value.coalesceKey === undefined ? {} : { coalesceKey: value.coalesceKey }),
  });
}

function validatePatch(value: unknown, sequence: number, path: string, index: number): SourcePatch {
  if (!isRecord(value)) throw invalidRecord(`Record ${sequence} patch ${index} for ${path} must be an object.`);
  assertExactKeys(value, ['start', 'end', 'replacement'], 'invalid-record');
  if (!Number.isSafeInteger(value.start) || (value.start as number) < 0
    || !Number.isSafeInteger(value.end) || (value.end as number) < (value.start as number)
    || typeof value.replacement !== 'string') {
    throw invalidRecord(`Record ${sequence} patch ${index} for ${path} has invalid fields.`);
  }
  return Object.freeze({ start: value.start as number, end: value.end as number, replacement: value.replacement });
}

function validateSelection(value: unknown, sequence: number): readonly ElementLocator[] {
  if (!Array.isArray(value)) throw invalidRecord(`Record ${sequence} selectionAfter must be an array.`);
  return Object.freeze(value.map((locator, index) => validateLocator(locator, sequence, index)));
}

function validateLocator(value: unknown, sequence: number, index: number): ElementLocator {
  if (!isRecord(value)) throw invalidRecord(`Record ${sequence} locator ${index} must be an object.`);
  assertExactKeys(value, ['qualifiedTag', 'childPath', 'ancestorTags', 'attributeHints', 'authoredName'], 'invalid-record', true);
  if (typeof value.qualifiedTag !== 'string' || value.qualifiedTag.length === 0
    || !Array.isArray(value.childPath) || !value.childPath.every((part) => Number.isSafeInteger(part) && part >= 0)
    || !Array.isArray(value.ancestorTags) || !value.ancestorTags.every((tag) => typeof tag === 'string' && tag.length > 0)
    || !Array.isArray(value.attributeHints)) {
    throw invalidRecord(`Record ${sequence} locator ${index} has invalid fields.`);
  }
  if (value.authoredName !== undefined && (typeof value.authoredName !== 'string' || value.authoredName.length === 0)) {
    throw invalidRecord(`Record ${sequence} locator ${index} has an invalid authored name.`);
  }
  const attributeHints = Object.freeze(value.attributeHints.map((hint, hintIndex) => {
    if (!isRecord(hint)) throw invalidRecord(`Record ${sequence} locator ${index} hint ${hintIndex} must be an object.`);
    assertExactKeys(hint, ['name', 'value'], 'invalid-record');
    if (typeof hint.name !== 'string' || hint.name.length === 0 || typeof hint.value !== 'string') {
      throw invalidRecord(`Record ${sequence} locator ${index} hint ${hintIndex} has invalid fields.`);
    }
    return Object.freeze({ name: hint.name, value: hint.value });
  }));
  return Object.freeze({
    qualifiedTag: value.qualifiedTag,
    childPath: Object.freeze([...(value.childPath as number[])]),
    ancestorTags: Object.freeze([...(value.ancestorTags as string[])]),
    attributeHints,
    ...(value.authoredName === undefined ? {} : { authoredName: value.authoredName }),
  });
}

function validateSafePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidRecord(`${field} must be a nonempty string.`);
  try {
    const normalized = normalizeRelativePath(value);
    if (normalized !== value) throw new Error('Path is not canonical.');
    return normalized;
  } catch (error) {
    throw new RecoveryJournalError('unsafe-path', `Recovery journal contains an unsafe path in ${field}.`, error);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: 'corrupt-journal' | 'invalid-record',
  optionalAllowed = false,
): void {
  const keys = Object.keys(value);
  const required = optionalAllowed ? allowed.filter((key) => !['selectionAfter', 'coalesceKey', 'authoredName'].includes(key)) : allowed;
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new RecoveryJournalError(code, 'Recovery journal object fields are invalid.');
  }
}

function invalidRecord(message: string): RecoveryJournalError {
  return new RecoveryJournalError('invalid-record', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializedFilesEqual(left: readonly SerializedFile[], right: readonly SerializedFile[]): boolean {
  return left.length === right.length
    && left.every((file, index) => file.path === right[index]?.path && file.text === right[index]?.text);
}

function serializedFilePathsEqual(left: readonly SerializedFile[], right: readonly SerializedFile[]): boolean {
  return left.length === right.length && left.every((file, index) => file.path === right[index]?.path);
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recoveryConvergence(
  snapshot: DocumentSnapshot,
  journal: SerializedJournal,
): ReadonlyMap<string, number> {
  const current = serializeSnapshot(snapshot);
  if (!serializedFilePathsEqual(current, journal.base)) {
    throw new RecoveryJournalError('stale-base', 'Recovery journal base is stale.');
  }
  const prepared = new Map(journal.prepared?.files.map((file) => [file.path, file.text]) ?? []);
  const converged = new Map<string, number>();
  for (let index = 0; index < current.length; index += 1) {
    const file = current[index]!;
    if (file.text === journal.base[index]!.text) continue;
    if (journal.prepared !== null && prepared.get(file.path) === file.text) {
      converged.set(file.path, journal.prepared.sequence);
      continue;
    }
    throw new RecoveryJournalError('stale-base', 'Recovery journal base is stale.');
  }
  return converged;
}

function validateRecordChain(journal: SerializedJournal): readonly EditorTransaction[] {
  let files = new Map(journal.base.map((file) => [file.path, file.text]));
  if (!files.has(journal.entryPath)) throw invalidRecord('Recovery base does not contain its entry path.');
  const transactions: EditorTransaction[] = [];
  for (const record of journal.records) {
    const transaction = deserializeTransaction(record.transaction);
    const next = new Map(files);
    try {
      for (const [path, patches] of transaction.patchesByFile) {
        const text = next.get(path);
        if (text === undefined) throw new Error(`Missing patched file ${path}.`);
        next.set(path, applyPatches(text, patches));
      }
    } catch (error) {
      throw new RecoveryJournalError('invalid-record', `Recovery record ${record.sequence} contains invalid patches.`, error);
    }
    const after = [...next]
      .map(([path, text]) => ({ path, text }))
      .sort((left, right) => comparePaths(left.path, right.path));
    if (after.length !== record.after.length
      || after.some((file, index) => file.path !== record.after[index]?.path || file.text !== record.after[index]?.text)) {
      throw invalidRecord(`Recovery record ${record.sequence} after snapshot does not match its patches.`);
    }
    files = next;
    transactions.push(transaction);
  }
  return Object.freeze(transactions);
}

function compactJournal(journal: SerializedJournal): SerializedJournal {
  const finalFiles = journal.records.at(-1)?.after ?? journal.base;
  if (journal.prepared !== null) {
    for (const file of journal.prepared.files) {
      if (!finalFiles.some((candidate) => candidate.path === file.path && candidate.text === file.text)) {
        throw new RecoveryJournalError(
          'record-too-large',
          'An active partial-save checkpoint cannot be compacted without losing an exact intermediate state.',
        );
      }
    }
  }
  let selectionAfter: readonly ElementLocator[] | undefined;
  for (const record of journal.records) {
    if (record.transaction.selectionAfter !== undefined) selectionAfter = record.transaction.selectionAfter;
  }
  const patchesByFile = new Map<string, readonly SourcePatch[]>();
  for (let index = 0; index < journal.base.length; index += 1) {
    const before = journal.base[index]!;
    const after = finalFiles[index];
    if (!after || after.path !== before.path) {
      throw invalidRecord('Recovery compaction file sets are inconsistent.');
    }
    if (before.text !== after.text) {
      patchesByFile.set(before.path, Object.freeze([{ start: 0, end: before.text.length, replacement: after.text }]));
    }
  }
  const transaction = serializeTransaction(copyEditorTransaction({
    id: `recovery-compaction:v1:${journal.compaction + 1}`,
    label: 'Recover compacted editor state',
    patchesByFile,
    ...(selectionAfter === undefined ? {} : { selectionAfter }),
  }));
  return Object.freeze({
    version: JOURNAL_VERSION,
    compaction: journal.compaction + 1,
    projectId: journal.projectId,
    entryPath: journal.entryPath,
    base: journal.base,
    records: Object.freeze([{ sequence: 1, transaction, after: finalFiles }]),
    prepared: journal.prepared === null
      ? null
      : Object.freeze({ sequence: 1, files: journal.prepared.files }),
  });
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Recovery journal ${field} must be a positive safe integer.`);
  }
  return value;
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function freezeOutcome(outcome: RecoveryOutcome): RecoveryOutcome {
  return Object.freeze({
    status: outcome.status,
    recordCount: outcome.recordCount,
    transactionIds: Object.freeze([...outcome.transactionIds]),
  });
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
