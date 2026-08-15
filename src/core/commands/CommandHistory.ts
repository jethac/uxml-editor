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
  private readonly listeners = new Map<number, (results: readonly CommitResult[]) => void>();
  private nextListenerId = 1;

  constructor(private readonly session: DocumentSession) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoDepth(): number { return this.undoStack.length; }
  get replayLog(): readonly EditorTransaction[] { return Object.freeze(this.replayed.map(copyEditorTransaction)); }

  subscribe(listener: (results: readonly CommitResult[]) => void): () => void {
    const id = this.nextListenerId++;
    this.listeners.set(id, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(id);
    };
  }

  execute(transaction: EditorTransaction): CommitResult {
    const result = this.session.commit(transaction);
    this.recordSuccessfulExecution(result);
    this.notify(Object.freeze([result]));
    return result;
  }

  private recordSuccessfulExecution(result: CommitResult): void {
    const forward = result.forward;
    const inverse = result.inverse;
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
  }

  undo(): readonly CommitResult[] | null {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return null;
    const results = this.session.commitSequence(entry.inverse);
    this.undoStack.pop();
    this.redoStack.push(entry);
    this.coalescingAllowed = false;
    this.notify(results);
    return results;
  }

  redo(): readonly CommitResult[] | null {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) return null;
    const results = this.session.commitSequence(entry.forward);
    this.redoStack.pop();
    this.undoStack.push(entry);
    this.coalescingAllowed = false;
    this.notify(results);
    return results;
  }

  replay(transactions: readonly EditorTransaction[]): readonly CommitResult[] {
    const normalized = Object.freeze(transactions.map(copyEditorTransaction));
    const results = this.session.commitSequence(normalized);
    results.forEach((result) => this.recordSuccessfulExecution(result));
    this.replayed = Object.freeze(results.map((result) => result.forward));
    this.notify(results);
    return results;
  }

  private notify(results: readonly CommitResult[]): void {
    let listenerError: unknown;
    let listenerThrew = false;
    for (const listener of [...this.listeners.values()]) {
      try {
        listener(results);
      } catch (error) {
        if (!listenerThrew) listenerError = error;
        listenerThrew = true;
      }
    }
    if (listenerThrew) throw listenerError;
  }
}

function canCoalesce(previous: HistoryEntry | undefined, transaction: EditorTransaction): boolean {
  return previous !== undefined
    && transaction.coalesceKey !== undefined
    && transaction.coalesceKey.length > 0
    && previous.coalesceKey === transaction.coalesceKey;
}
