import { ImmutableMap } from '../collections/ImmutableMap';
import type { EditorDiagnostic, EditorSourceSpan, ParsedPreviewDocument } from '../adapter/types';
import { DocumentSession, type CommitResult } from './DocumentSession';

export const SOURCE_EDIT_DEBOUNCE_MS = 250;

export interface SourceEditScheduledTask {
  cancel(): void;
}

export interface SourceEditScheduler {
  schedule(delayMs: number, callback: () => void): SourceEditScheduledTask;
}

export interface SourceEditSnapshot {
  readonly activePath: string;
  readonly activeSpan: EditorSourceSpan | null;
  readonly drafts: ReadonlyMap<string, string>;
  readonly status: 'ready' | 'stale';
  readonly diagnostics: readonly EditorDiagnostic[];
  readonly previewDocument: ParsedPreviewDocument;
}

export interface SourceEditCoordinatorOptions {
  readonly scheduler?: SourceEditScheduler;
  readonly onAccepted?: (result: CommitResult) => void;
}

export class SourceEditCoordinator {
  private readonly scheduler: SourceEditScheduler;
  private readonly onAccepted: ((result: CommitResult) => void) | undefined;
  private readonly drafts = new Map<string, string>();
  private readonly authoritative = new Map<string, string>();
  private readonly feedbackByFile = new Map<string, readonly EditorDiagnostic[]>();
  private readonly scheduled = new Map<string, { readonly revision: number; readonly task: SourceEditScheduledTask }>();
  private readonly listeners = new Set<() => void>();
  private transactionSequence = 0;
  private scheduleRevision = 0;
  private disposed = false;
  private activeSpan: EditorSourceSpan | null = null;
  private previewDocument: ParsedPreviewDocument;
  private snapshot: SourceEditSnapshot;

  constructor(
    private readonly session: DocumentSession,
    options: SourceEditCoordinatorOptions = {},
  ) {
    this.scheduler = options.scheduler ?? timeoutScheduler;
    this.onAccepted = options.onAccepted;
    for (const [path, buffer] of session.snapshot().files) {
      this.drafts.set(path, buffer.text);
      this.authoritative.set(path, buffer.text);
    }
    this.previewDocument = session.document;
    this.snapshot = this.createSnapshot(session.entryPath, 'ready', []);
  }

  getSnapshot = (): SourceEditSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replace(text: string): void {
    if (this.disposed) return;
    const path = this.snapshot.activePath;
    this.drafts.set(path, text);
    this.publish();
    this.scheduled.get(path)?.task.cancel();
    const revision = this.scheduleRevision += 1;
    const task = this.scheduler.schedule(SOURCE_EDIT_DEBOUNCE_MS, () => {
      if (this.disposed || this.scheduled.get(path)?.revision !== revision) return;
      this.scheduled.delete(path);
      this.commit(path, this.drafts.get(path) ?? text);
    });
    this.scheduled.set(path, { revision, task });
  }

  activate(path: string, span?: Readonly<{ start: number; end: number }>): boolean {
    if (this.disposed) return false;
    const text = this.drafts.get(path);
    if (text === undefined || (span !== undefined && !validSpan(span, text.length))) return false;
    this.activeSpan = span === undefined ? null : Object.freeze({ path, start: span.start, end: span.end });
    this.snapshot = this.createSnapshot(path, this.status(), this.feedback());
    this.notify();
    return true;
  }

  reconcile(): void {
    if (this.disposed) return;
    const files = this.session.snapshot().files;
    for (const [path, buffer] of files) {
      if (this.drafts.get(path) === this.authoritative.get(path)) this.drafts.set(path, buffer.text);
      this.authoritative.set(path, buffer.text);
    }
    for (const path of [...this.drafts.keys()]) {
      if (files.has(path)) continue;
      this.drafts.delete(path);
      this.authoritative.delete(path);
      this.feedbackByFile.delete(path);
      this.scheduled.get(path)?.task.cancel();
      this.scheduled.delete(path);
    }
    this.previewDocument = this.session.document;
    if (!this.drafts.has(this.snapshot.activePath)) {
      this.activeSpan = null;
      this.snapshot = this.createSnapshot(this.session.entryPath, this.status(), this.feedback());
      this.notify();
      return;
    }
    this.publish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const scheduled of this.scheduled.values()) scheduled.task.cancel();
    this.scheduled.clear();
    this.listeners.clear();
  }

  private commit(path: string, text: string): void {
    const current = this.session.snapshot().files.get(path);
    if (current === undefined) return;
    if (current.text === text) {
      this.authoritative.set(path, text);
      this.feedbackByFile.delete(path);
      this.previewDocument = this.session.document;
      this.publish();
      return;
    }
    const malformed = this.preflight(path, text);
    if (malformed.length > 0) {
      this.feedbackByFile.set(path, malformed);
      this.publish();
      return;
    }
    const result = this.session.history.execute({
      id: `source-edit:${this.transactionSequence += 1}`,
      label: `Edit ${path}`,
      patchesByFile: new Map([[path, [{ start: 0, end: current.text.length, replacement: text }]]]),
      coalesceKey: `source-edit:${path}`,
    });
    this.authoritative.set(path, text);
    this.feedbackByFile.delete(path);
    this.previewDocument = this.session.document;
    this.publish();
    this.onAccepted?.(result);
  }

  private preflight(path: string, text: string): readonly EditorDiagnostic[] {
    const files = new Map<string, string>();
    for (const [candidatePath, buffer] of this.session.snapshot().files) {
      files.set(candidatePath, candidatePath === path ? text : buffer.text);
    }
    try {
      const candidate = DocumentSession.open(files, this.session.entryPath, this.session.adapter);
      return Object.freeze(candidate.diagnostics
        .filter((diagnostic) => diagnostic.kind === 'malformed')
        .map((diagnostic) => Object.freeze({
          ...diagnostic,
          source: diagnostic.source ?? Object.freeze({ path, start: 0, end: text.length }),
        })));
    } catch (error) {
      return Object.freeze([Object.freeze({
        origin: 'parse' as const,
        severity: 'warning' as const,
        kind: 'malformed' as const,
        message: error instanceof Error ? error.message : 'The source could not be parsed.',
        source: Object.freeze({ path, start: 0, end: text.length }),
      })]);
    }
  }

  private createSnapshot(
    activePath: string,
    status: SourceEditSnapshot['status'],
    diagnostics: readonly EditorDiagnostic[],
  ): SourceEditSnapshot {
    return Object.freeze({
      activePath,
      drafts: new ImmutableMap(this.drafts),
      status,
      diagnostics: Object.freeze([...diagnostics]),
      activeSpan: this.activeSpan,
      previewDocument: this.previewDocument,
    });
  }

  private status(): SourceEditSnapshot['status'] {
    return this.feedbackByFile.size === 0 ? 'ready' : 'stale';
  }

  private feedback(): readonly EditorDiagnostic[] {
    return Object.freeze([...this.feedbackByFile.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, diagnostics]) => diagnostics));
  }

  private publish(): void {
    this.snapshot = this.createSnapshot(this.snapshot.activePath, this.status(), this.feedback());
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const timeoutScheduler: SourceEditScheduler = Object.freeze({
  schedule(delayMs: number, callback: () => void) {
    const handle = setTimeout(callback, delayMs);
    return Object.freeze({ cancel: () => clearTimeout(handle) });
  },
});

function validSpan(span: Readonly<{ start: number; end: number }>, length: number): boolean {
  return Number.isInteger(span.start)
    && Number.isInteger(span.end)
    && span.start >= 0
    && span.end >= span.start
    && span.end <= length;
}
