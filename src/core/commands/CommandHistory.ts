import type { CommitResult, DocumentSession } from '../documents/DocumentSession';
import { copyEditorTransaction, type EditorTransaction } from './EditorTransaction';

interface HistoryEntry {
  readonly forward: readonly EditorTransaction[];
  readonly inverse: readonly EditorTransaction[];
  readonly coalesceKey?: string;
}

export class CommandHistory {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private replayed: readonly EditorTransaction[] = Object.freeze([]);
  private coalescingAllowed = true;

  constructor(private readonly session: DocumentSession) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get replayLog(): readonly EditorTransaction[] { return Object.freeze(this.replayed.map(copyEditorTransaction)); }

  execute(transaction: EditorTransaction): CommitResult {
    const result = this.session.commit(transaction);
    const forward = copyEditorTransaction(result.forward);
    const inverse = copyEditorTransaction(result.inverse);
    const previous = this.undoStack[this.undoStack.length - 1];
    if (this.coalescingAllowed && canCoalesce(previous, forward)) {
      this.undoStack[this.undoStack.length - 1] = {
        forward: Object.freeze([...previous.forward, forward]),
        inverse: Object.freeze([inverse, ...previous.inverse]),
        coalesceKey: forward.coalesceKey,
      };
    } else {
      this.undoStack.push({ forward: Object.freeze([forward]), inverse: Object.freeze([inverse]), coalesceKey: forward.coalesceKey });
    }
    this.redoStack.length = 0;
    this.coalescingAllowed = true;
    return result;
  }

  undo(): readonly CommitResult[] | null {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return null;
    const results = this.session.commitSequence(entry.inverse);
    this.undoStack.pop();
    this.redoStack.push(entry);
    this.coalescingAllowed = false;
    return results;
  }

  redo(): readonly CommitResult[] | null {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) return null;
    const results = this.session.commitSequence(entry.forward);
    this.redoStack.pop();
    this.undoStack.push(entry);
    this.coalescingAllowed = false;
    return results;
  }

  replay(transactions: readonly EditorTransaction[]): readonly CommitResult[] {
    const results: CommitResult[] = [];
    const log: EditorTransaction[] = [];
    for (const transaction of transactions) {
      const result = this.execute(transaction);
      results.push(result);
      log.push(copyEditorTransaction(result.forward));
    }
    this.replayed = Object.freeze(log);
    return Object.freeze(results);
  }
}

function canCoalesce(previous: HistoryEntry | undefined, transaction: EditorTransaction): boolean {
  return previous !== undefined
    && transaction.coalesceKey !== undefined
    && transaction.coalesceKey.length > 0
    && previous.coalesceKey === transaction.coalesceKey;
}
