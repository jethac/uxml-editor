import { describe, expect, it } from 'vitest';
import type { EditorNodeId } from '../adapter/types';
import { projectPath } from '../host/HostPort';
import { MemoryHost } from '../host/MemoryHost';
import { RecoveryJournal } from './RecoveryJournal';
import { openTestSession, PersistenceTestAdapter } from './persistenceTestSupport';

describe('RecoveryJournal', () => {
  it('replays committed transactions in order with exact text, ids, and selection', async () => {
    const original = '<UXML />\r\n';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const journal = new RecoveryJournal(host, root);
    const editing = openTestSession(new Map([['Main.uxml', original]]));
    const rootLocator = editing.locatorFor('root' as EditorNodeId)!;
    const first = editing.commit({
      id: 'transaction-1',
      label: 'First edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
      selectionAfter: [rootLocator],
    });
    await journal.appendCommitted(first);
    const second = editing.commit({
      id: 'transaction-2',
      label: 'Second edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });
    await journal.appendCommitted(second);
    const raw = await host.readRecovery(root.id);
    expect(JSON.parse(raw!).version).toBe(1);

    const restored = openTestSession(new Map([['Main.uxml', original]]));
    const outcome = await journal.recover(restored);

    expect(outcome).toEqual({ status: 'recovered', recordCount: 2, transactionIds: ['transaction-1', 'transaction-2'] });
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe('<UXML   />\r\n');
    expect(restored.history.replayLog.map((transaction) => transaction.id)).toEqual(['transaction-1', 'transaction-2']);
    expect(restored.selection).toEqual([rootLocator]);
    expect(Object.isFrozen(outcome)).toBe(true);
    await expect(host.readText(projectPath(root, '.recovery/journal.json'))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('serializes concurrent committed appends without losing their invocation order', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const journal = new RecoveryJournal(host, root);
    const editing = openTestSession(new Map([['Main.uxml', original]]));
    const first = editing.commit({
      id: 'concurrent-1',
      label: 'First edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const second = editing.commit({
      id: 'concurrent-2',
      label: 'Second edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });

    await Promise.all([journal.appendCommitted(first), journal.appendCommitted(second)]);

    const restored = openTestSession(new Map([['Main.uxml', original]]));
    expect(await journal.recover(restored)).toEqual({
      status: 'recovered',
      recordCount: 2,
      transactionIds: ['concurrent-1', 'concurrent-2'],
    });
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe('<UXML   />');
  });

  it('journals edit, undo, and redo entries in order even when transaction ids repeat', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const journal = new RecoveryJournal(host, root);
    const editing = openTestSession(new Map([['Main.uxml', original]]));
    const locator = editing.locatorFor('root' as EditorNodeId)!;
    const edit = editing.history.execute({
      id: 'repeatable-operation',
      label: 'Edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
      selectionAfter: [locator],
    });
    await journal.appendCommitted(edit);
    const undone = editing.history.undo()!;
    for (const result of undone) await journal.appendCommitted(result);
    const redone = editing.history.redo()!;
    for (const result of redone) await journal.appendCommitted(result);

    const restored = openTestSession(new Map([['Main.uxml', original]]));
    expect(await journal.recover(restored)).toEqual({
      status: 'recovered',
      recordCount: 3,
      transactionIds: ['repeatable-operation', 'repeatable-operation', 'repeatable-operation'],
    });
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe('<UXML  />');
    expect(restored.selection).toEqual([locator]);
    expect(restored.history.replayLog.map((transaction) => transaction.id)).toEqual([
      'repeatable-operation',
      'repeatable-operation',
      'repeatable-operation',
    ]);
  });

  it.each([
    ['truncated JSON', '{', 'corrupt-journal'],
    ['malformed schema', '{"version":1}', 'corrupt-journal'],
    ['unsupported version', '{"version":2,"projectId":"project-a","entryPath":"Main.uxml","base":[],"records":[]}', 'version-mismatch'],
  ])('rejects %s recovery data', async (_case, raw, code) => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    await host.writeRecovery(root.id, raw);
    const journal = new RecoveryJournal(host, root);
    const session = openTestSession(new Map([['Main.uxml', original]]));

    await expect(journal.recover(session)).rejects.toMatchObject({ code });
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(original);
  });

  it.each([
    ['negative patch start', (value: any) => { value.records[0].transaction.patches[0].patches[0].start = -1; }, 'invalid-record'],
    ['non-integer patch end', (value: any) => { value.records[0].transaction.patches[0].patches[0].end = 6.5; }, 'invalid-record'],
    ['non-string patch replacement', (value: any) => { value.records[0].transaction.patches[0].patches[0].replacement = null; }, 'invalid-record'],
    ['missing locator tag', (value: any) => { value.records[0].transaction.selectionAfter[0].qualifiedTag = null; }, 'invalid-record'],
    ['invalid locator child path', (value: any) => { value.records[0].transaction.selectionAfter[0].childPath = [-1]; }, 'invalid-record'],
    ['invalid locator ancestors', (value: any) => { value.records[0].transaction.selectionAfter[0].ancestorTags = [1]; }, 'invalid-record'],
    ['invalid locator hints', (value: any) => { value.records[0].transaction.selectionAfter[0].attributeHints = [{ name: null, value: 'x' }]; }, 'invalid-record'],
    ['invalid locator authored name', (value: any) => { value.records[0].transaction.selectionAfter[0].authoredName = 3; }, 'invalid-record'],
    ['non-sequential record', (value: any) => { value.records[0].sequence = 7; }, 'invalid-record'],
    ['project path escape', (value: any) => { value.records[0].transaction.patches[0].path = '../escape.uxml'; }, 'unsafe-path'],
  ])('rejects %s before replay', async (_case, mutate, code) => {
    const fixture = await storedJournalFixture();
    const value = JSON.parse(fixture.raw);
    mutate(value);
    await fixture.host.writeRecovery(fixture.root.id, JSON.stringify(value));

    await expect(fixture.journal.recover(fixture.restored)).rejects.toMatchObject({ code });
    expect(fixture.restored.snapshot().files.get('Main.uxml')?.text).toBe(fixture.original);
    expect(fixture.restored.history.replayLog).toEqual([]);
  });

  it('rejects a journal whose exact base no longer matches disk source', async () => {
    const fixture = await storedJournalFixture();
    const stale = openTestSession(new Map([['Main.uxml', '<UXML  />']]));

    await expect(fixture.journal.recover(stale)).rejects.toMatchObject({ code: 'stale-base' });
    expect(stale.snapshot().files.get('Main.uxml')?.text).toBe('<UXML  />');
    expect(stale.history.replayLog).toEqual([]);
  });

  it('rejects a record whose stored after snapshot does not match its patches', async () => {
    const fixture = await storedJournalFixture();
    const value = JSON.parse(fixture.raw);
    value.records[0].after[0].text = '<UXML forged="true" />';
    await fixture.host.writeRecovery(fixture.root.id, JSON.stringify(value));

    await expect(fixture.journal.recover(fixture.restored)).rejects.toMatchObject({ code: 'invalid-record' });
    expect(fixture.restored.snapshot().files.get('Main.uxml')?.text).toBe(fixture.original);
    expect(fixture.restored.history.replayLog).toEqual([]);
  });

  it('rolls back every record when replay parsing fails', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const journal = new RecoveryJournal(host, root);
    const editing = openTestSession(new Map([['Main.uxml', original]]));
    const first = editing.commit({
      id: 'transaction-1',
      label: 'First edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    await journal.appendCommitted(first);
    const afterFirst = editing.snapshot().files.get('Main.uxml')!.text;
    const second = editing.commit({
      id: 'transaction-2',
      label: 'Breaking edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 0, end: afterFirst.length, replacement: '<broken />' }]]]),
    });
    await journal.appendCommitted(second);

    const adapter = new PersistenceTestAdapter();
    const restored = openTestSession(new Map([['Main.uxml', original]]), 'Main.uxml', adapter);
    const selection = restored.locatorFor('root' as EditorNodeId)!;
    restored.setSelection([selection]);
    adapter.failWhenSourceIncludes = '<broken';

    await expect(journal.recover(restored)).rejects.toMatchObject({ code: 'replay-failed' });
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe(original);
    expect(restored.selection).toEqual([selection]);
    expect(restored.history.replayLog).toEqual([]);
    expect(restored.history.canUndo).toBe(false);
  });

  it('rejects a committed result that is discontinuous with the stored record chain', async () => {
    const fixture = await storedJournalFixture();
    const other = openTestSession(new Map([['Main.uxml', fixture.original]]));
    const unrelated = other.commit({
      id: 'unrelated',
      label: 'Unrelated edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 5, end: 5, replacement: ' ' }]]]),
    });

    await expect(fixture.journal.appendCommitted(unrelated)).rejects.toMatchObject({ code: 'append-discontinuity' });
    expect(await fixture.host.readRecovery(fixture.root.id)).toBe(fixture.raw);
  });

  it('compacts deterministically at the entry limit while preserving recovered state and selection', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const journal = new RecoveryJournal(host, root, { maxEntries: 2, maxBytes: 64_000 });
    const editing = openTestSession(new Map([['Main.uxml', original]]));
    const locator = editing.locatorFor('root' as EditorNodeId)!;
    for (let index = 0; index < 3; index += 1) {
      const result = editing.commit({
        id: `bounded-${index + 1}`,
        label: `Bounded edit ${index + 1}`,
        patchesByFile: new Map([['Main.uxml', [{ start: 6 + index, end: 6 + index, replacement: ' ' }]]]),
        ...(index === 0 ? { selectionAfter: [locator] } : {}),
      });
      await journal.appendCommitted(result);
    }
    const raw = (await host.readRecovery(root.id))!;
    const stored = JSON.parse(raw);
    expect(stored.records).toHaveLength(1);
    expect(stored.records[0].transaction.id).toBe('recovery-compaction:v1:1');
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(64_000);

    const restored = openTestSession(new Map([['Main.uxml', original]]));
    await journal.recover(restored);
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe('<UXML    />');
    expect(restored.selection).toEqual([locator]);
    restored.history.undo();
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe(original);
    restored.history.redo();
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe('<UXML    />');
  });

  it('rejects one oversized record without writing an unbounded journal', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const journal = new RecoveryJournal(host, root, { maxEntries: 8, maxBytes: 256 });
    const editing = openTestSession(new Map([['Main.uxml', original]]));
    const result = editing.commit({
      id: 'oversized',
      label: 'Oversized edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: 'x'.repeat(2_000) }]]]),
    });

    await expect(journal.appendCommitted(result)).rejects.toMatchObject({ code: 'record-too-large' });
    expect(await host.readRecovery(root.id)).toBeNull();
  });
});

async function storedJournalFixture() {
  const original = '<UXML />';
  const host = new MemoryHost({
    projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
  });
  const root = (await host.chooseProject())!;
  const journal = new RecoveryJournal(host, root);
  const editing = openTestSession(new Map([['Main.uxml', original]]));
  const locator = editing.locatorFor('root' as EditorNodeId)!;
  const result = editing.commit({
    id: 'transaction-1',
    label: 'Edit',
    patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    selectionAfter: [locator],
  });
  await journal.appendCommitted(result);
  return {
    original,
    host,
    root,
    journal,
    raw: (await host.readRecovery(root.id))!,
    restored: openTestSession(new Map([['Main.uxml', original]])),
  };
}
