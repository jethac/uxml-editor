import { copyEditorTransaction } from '../commands/EditorTransaction';
import type { DocumentSession, DocumentSnapshot } from '../documents/DocumentSession';
import {
  serializeSnapshot,
  serializedFilePathsEqual,
  validateRecordChain,
  type SerializedJournal,
} from './RecoveryJournalCodec';
import {
  RecoveryJournalError,
  type RecoveryOutcome,
} from './RecoveryJournalContracts';

export function noRecoveryOutcome(): RecoveryOutcome {
  return freezeRecoveryOutcome({ status: 'none', recordCount: 0, transactionIds: [] });
}

export function replayRecoveryJournal(
  session: DocumentSession,
  journal: SerializedJournal,
): RecoveryOutcome {
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
  return freezeRecoveryOutcome({
    status: 'recovered',
    recordCount: transactions.length,
    transactionIds: replayTransactions.map((transaction) => transaction.id),
  });
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

function freezeRecoveryOutcome(outcome: RecoveryOutcome): RecoveryOutcome {
  return Object.freeze({
    status: outcome.status,
    recordCount: outcome.recordCount,
    transactionIds: Object.freeze([...outcome.transactionIds]),
  });
}
