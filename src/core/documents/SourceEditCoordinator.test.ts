import { describe, expect, it } from 'vitest';
import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import type { CommitResult } from './DocumentSession';
import { DocumentSession } from './DocumentSession';
import {
  SourceEditCoordinator,
  type SourceEditScheduledTask,
  type SourceEditScheduler,
} from './SourceEditCoordinator';

const entryPath = 'Assets/UI/Main.uxml';
const sheetPath = 'Assets/UI/Main.uss';
const originalUxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:Label name="title" text="Original" />
</ui:UXML>\n`;

describe('SourceEditCoordinator', () => {
  it('publishes an immediate draft and commits debounced whole-buffer edits as one coalesced history entry', () => {
    const scheduler = new ManualScheduler();
    const accepted: CommitResult[] = [];
    const session = openSession();
    const coordinator = new SourceEditCoordinator(session, {
      scheduler,
      onAccepted: (result) => accepted.push(result),
    });
    const firstEdit = originalUxml.replace('Original', 'First');

    coordinator.replace(firstEdit);

    expect(coordinator.getSnapshot().drafts.get(entryPath)).toBe(firstEdit);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(originalUxml);
    scheduler.advanceBy(249);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(originalUxml);

    scheduler.advanceBy(1);

    expect(session.snapshot().files.get(entryPath)?.text).toBe(firstEdit);
    expect(session.snapshot().files.get(sheetPath)?.text).toBe('.title { color: red; }\r\n');
    expect(accepted[0].forward.patchesByFile.get(entryPath)).toEqual([{
      start: 0,
      end: originalUxml.length,
      replacement: firstEdit,
    }]);
    expect(session.history.undoDepth).toBe(1);

    const secondEdit = firstEdit.replace('First', 'Second');
    coordinator.replace(secondEdit);
    scheduler.advanceBy(250);

    expect(session.snapshot().files.get(entryPath)?.text).toBe(secondEdit);
    expect(session.history.undoDepth).toBe(1);
    session.history.undo();
    expect(session.snapshot().files.get(entryPath)?.text).toBe(originalUxml);
  });

  it('keeps malformed source editable without history and restores ready authority after correction', () => {
    const scheduler = new ManualScheduler();
    const accepted: CommitResult[] = [];
    const session = openSession();
    const coordinator = new SourceEditCoordinator(session, {
      scheduler,
      onAccepted: (result) => accepted.push(result),
    });
    const lastGoodDocument = session.document;
    const malformed = '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button';

    coordinator.replace(malformed);
    scheduler.advanceBy(250);

    expect(coordinator.getSnapshot()).toMatchObject({ status: 'stale' });
    expect(coordinator.getSnapshot().previewDocument).toBe(lastGoodDocument);
    expect(coordinator.getSnapshot().drafts.get(entryPath)).toBe(malformed);
    expect(coordinator.getSnapshot().diagnostics).toContainEqual(expect.objectContaining({
      kind: 'malformed',
      source: expect.objectContaining({ path: entryPath }),
    }));
    expect(session.document).toBe(lastGoodDocument);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(originalUxml);
    expect(session.history.undoDepth).toBe(0);
    expect(accepted).toHaveLength(0);

    const corrected = originalUxml.replace('Original', 'Corrected');
    coordinator.replace(corrected);
    scheduler.advanceBy(250);

    expect(coordinator.getSnapshot()).toMatchObject({ status: 'ready', diagnostics: [] });
    expect(coordinator.getSnapshot().previewDocument).toBe(session.document);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(corrected);
    expect(session.document).not.toBe(lastGoodDocument);
    expect(session.history.undoDepth).toBe(1);
    expect(accepted).toHaveLength(1);
  });

  it('preserves independent file drafts and activates an exact source span', () => {
    const scheduler = new ManualScheduler();
    const coordinator = new SourceEditCoordinator(openSession(), { scheduler });
    const uxmlDraft = originalUxml.replace('Original', 'Draft');
    const ussDraft = '.title { color: blue; }\r\n';

    coordinator.replace(uxmlDraft);
    expect(coordinator.activate(sheetPath, { start: 17, end: 21 })).toBe(true);
    coordinator.replace(ussDraft);
    expect(coordinator.activate(entryPath, { start: 45, end: 50 })).toBe(true);

    expect(coordinator.getSnapshot()).toMatchObject({
      activePath: entryPath,
      activeSpan: { path: entryPath, start: 45, end: 50 },
    });
    expect(coordinator.getSnapshot().drafts.get(entryPath)).toBe(uxmlDraft);
    expect(coordinator.getSnapshot().drafts.get(sheetPath)).toBe(ussDraft);
    expect(coordinator.activate('Assets/UI/Missing.uss', { start: 0, end: 1 })).toBe(false);
    expect(coordinator.getSnapshot().activePath).toBe(entryPath);
  });

  it('reconciles clean files from current session authority without replacing a dirty draft', () => {
    const scheduler = new ManualScheduler();
    const session = openSession();
    const coordinator = new SourceEditCoordinator(session, { scheduler });
    const externallyEdited = originalUxml.replace('Original', 'External');
    replaceAuthoritative(session, externallyEdited, 'external-1');

    coordinator.reconcile();

    expect(coordinator.getSnapshot().drafts.get(entryPath)).toBe(externallyEdited);

    const localDraft = externallyEdited.replace('External', 'Local draft');
    coordinator.replace(localDraft);
    const newerAuthority = externallyEdited.replace('External', 'New authority');
    replaceAuthoritative(session, newerAuthority, 'external-2');
    coordinator.reconcile();

    expect(coordinator.getSnapshot().drafts.get(entryPath)).toBe(localDraft);
  });

  it('disposes pending work and ignores stale callbacks from a non-cancelling scheduler', () => {
    const scheduler = new LeakyScheduler();
    const session = openSession();
    const coordinator = new SourceEditCoordinator(session, { scheduler });
    const listenerCalls: string[] = [];
    coordinator.subscribe(() => listenerCalls.push(coordinator.getSnapshot().drafts.get(entryPath) ?? ''));

    coordinator.replace(originalUxml.replace('Original', 'Never commit'));
    expect(listenerCalls).toHaveLength(1);
    coordinator.dispose();
    scheduler.flush();

    expect(session.snapshot().files.get(entryPath)?.text).toBe(originalUxml);
    expect(session.history.undoDepth).toBe(0);
    expect(listenerCalls).toHaveLength(1);
  });

  it('reports the malformed draft together with the other diagnostics it earns, located in the draft', () => {
    const scheduler = new ManualScheduler();
    const linkedUxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="Main.uss" />
  <ui:Label name="title" text="Original" />
</ui:UXML>\n`;
    const session = DocumentSession.open(new Map([
      [entryPath, linkedUxml],
      [sheetPath, '.title { color: red; }\r\n'],
    ]), entryPath, new UxmlPreviewAdapter());
    const coordinator = new SourceEditCoordinator(session, { scheduler });
    const draft = '.title { color red; }\r\n.other { colr: blue; }\r\n';

    expect(coordinator.activate(sheetPath)).toBe(true);
    coordinator.replace(draft);
    scheduler.advanceBy(250);

    const snapshot = coordinator.getSnapshot();
    expect(snapshot.status).toBe('stale');
    expect(snapshot.draftDiagnosticPaths).toEqual(new Set([sheetPath]));
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(
      expect.arrayContaining(['malformed', 'unsupported-property']),
    );
    const unknown = snapshot.diagnostics.find((diagnostic) => diagnostic.kind === 'unsupported-property')!;
    expect(unknown.message).toContain('colr');
    expect(draft.slice(unknown.source!.start, unknown.source!.end)).toBe('colr: blue');
  });

  it('clears stale feedback when a malformed draft is reverted to current authority', () => {
    const scheduler = new ManualScheduler();
    const session = openSession();
    const coordinator = new SourceEditCoordinator(session, { scheduler });

    coordinator.replace('<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button');
    scheduler.advanceBy(250);
    expect(coordinator.getSnapshot().status).toBe('stale');

    coordinator.replace(originalUxml);
    scheduler.advanceBy(250);

    expect(coordinator.getSnapshot()).toMatchObject({ status: 'ready', diagnostics: [] });
    expect(session.history.undoDepth).toBe(0);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(originalUxml);
  });
});

function openSession(): DocumentSession {
  return DocumentSession.open(new Map([
    [entryPath, originalUxml],
    [sheetPath, '.title { color: red; }\r\n'],
  ]), entryPath, new UxmlPreviewAdapter());
}

function replaceAuthoritative(session: DocumentSession, text: string, id: string): void {
  const current = session.snapshot().files.get(entryPath)!.text;
  session.history.execute({
    id,
    label: 'External edit',
    patchesByFile: new Map([[entryPath, [{ start: 0, end: current.length, replacement: text }]]]),
  });
}

class ManualScheduler implements SourceEditScheduler {
  private now = 0;
  private sequence = 0;
  private readonly tasks: Array<{
    readonly id: number;
    readonly due: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];

  schedule(delayMs: number, callback: () => void): SourceEditScheduledTask {
    const task = { id: this.sequence += 1, due: this.now + delayMs, callback, cancelled: false };
    this.tasks.push(task);
    return Object.freeze({ cancel: () => { task.cancelled = true; } });
  }

  advanceBy(milliseconds: number): void {
    this.now += milliseconds;
    for (const task of this.tasks
      .filter((candidate) => !candidate.cancelled && candidate.due <= this.now)
      .sort((left, right) => left.due - right.due || left.id - right.id)) {
      task.cancelled = true;
      task.callback();
    }
  }
}

class LeakyScheduler implements SourceEditScheduler {
  private readonly callbacks: Array<() => void> = [];

  schedule(_delayMs: number, callback: () => void): SourceEditScheduledTask {
    this.callbacks.push(callback);
    return Object.freeze({ cancel: () => undefined });
  }

  flush(): void {
    for (const callback of this.callbacks) callback();
  }
}
