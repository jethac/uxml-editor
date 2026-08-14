import { describe, expect, it } from 'vitest';
import { CommandHistory } from './CommandHistory';
import { DocumentSession } from '../documents/DocumentSession';
import type { EditorElement, EditorNodeId, ParsedPreviewDocument, ProjectParseInput, UxmlPreviewPort } from '../adapter/types';
import type { SourcePatch } from './SourcePatch';

const entryPath = 'Main.uxml';
const sheetPath = 'Main.uss';

describe('CommandHistory', () => {
  it('undoes every file byte-for-byte and deterministically redoes it', () => {
    const session = openSession();
    const before = session.snapshot();
    session.history.execute(edit('both', 'Change both files', new Map([
      [entryPath, [{ start: 26, end: 30, replacement: 'Start' }]],
      [sheetPath, [{ start: 15, end: 18, replacement: 'blue' }]],
    ])));
    const after = session.snapshot();

    session.history.undo();
    expect(session.snapshot()).toEqual(before);
    session.history.redo();
    expect(session.snapshot()).toEqual(after);
  });

  it('replays a readonly transaction sequence into an equivalent fresh session and exposes a copy-safe log', () => {
    const original = openSession();
    const transactions = [
      edit('first', 'First', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Start' }]]])),
      edit('second', 'Second', new Map([[sheetPath, [{ start: 15, end: 18, replacement: 'blue' }]]])),
    ] as const;
    transactions.forEach((item) => original.history.execute(item));
    const replayed = openSession();

    const results = replayed.history.replay(transactions);
    const log = replayed.history.replayLog;
    expect(() => (log[0].patchesByFile as Map<string, readonly SourcePatch[]>).clear()).toThrow();

    expect(results).toHaveLength(2);
    expect(replayed.snapshot()).toEqual(original.snapshot());
    expect(replayed.history.replayLog[0].patchesByFile.size).toBe(1);
    expect(Object.isFrozen(results)).toBe(true);
  });

  it('clears redo when a successful new execute branches history', () => {
    const session = openSession();
    session.history.execute(edit('first', 'First', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Start' }]]])));
    session.history.undo();
    expect(session.history.canRedo).toBe(true);

    session.history.execute(edit('branch', 'Branch', new Map([[sheetPath, [{ start: 15, end: 18, replacement: 'green' }]]])));

    expect(session.history.canRedo).toBe(false);
  });

  it('applies transaction selectionAfter and restores exact pre/post selection through undo and redo', () => {
    const session = openSession();
    const before = session.locatorFor('button' as EditorNodeId)!;
    const after = session.locatorFor('root' as EditorNodeId)!;
    session.setSelection([before]);

    session.history.execute({
      ...edit('select-root', 'Select root', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Start' }]]])),
      selectionAfter: [after],
    });
    expect(session.selection).toEqual([after]);
    expect(session.selectedNodeIds).toEqual(['root']);

    session.history.undo();
    expect(session.selection).toEqual([before]);
    expect(session.selectedNodeIds).toEqual(['button']);

    session.history.redo();
    expect(session.selection).toEqual([after]);
    expect(session.selectedNodeIds).toEqual(['root']);
  });

  it('coalesces only adjacent successful commands with the same explicit key and respects undo barriers', () => {
    const session = openSession();
    const first = edit('drag-1', 'Drag', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Step' }]]]), 'drag:button');
    const second = edit('drag-2', 'Drag', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Stop' }]]]), 'drag:button');
    session.history.execute(first);
    session.history.execute(second);

    session.history.undo();
    expect(session.snapshot().files.get(entryPath)?.text).toContain('Play');
    expect(session.history.canUndo).toBe(false);
    session.history.redo();
    session.history.execute(edit('drag-3', 'Drag', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Go!!' }]]]), 'drag:button'));
    session.history.undo();
    expect(session.snapshot().files.get(entryPath)?.text).toContain('Stop');
  });

  it('does not coalesce missing or nonmatching keys', () => {
    const withoutKey = openSession();
    withoutKey.history.execute(edit('one', 'One', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'One!' }]]])));
    withoutKey.history.execute(edit('two', 'Two', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Two!' }]]])));
    withoutKey.history.undo();
    expect(withoutKey.snapshot().files.get(entryPath)?.text).toContain('One!');

    const differentKeys = openSession();
    differentKeys.history.execute(edit('one', 'One', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'One!' }]]]), 'one'));
    differentKeys.history.execute(edit('two', 'Two', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Two!' }]]]), 'two'));
    differentKeys.history.undo();
    expect(differentKeys.snapshot().files.get(entryPath)?.text).toContain('One!');
  });

  it('snapshots transaction maps, patches, selection locators, and its explicit coalesce key at execute time', () => {
    const session = openSession();
    const patch = { start: 26, end: 30, replacement: 'Start' };
    const patches = [patch];
    const patchesByFile = new Map<string, readonly SourcePatch[]>([[entryPath, patches]]);
    const selectionAfter = [{ qualifiedTag: 'Button', childPath: [0], ancestorTags: ['UXML'], attributeHints: [] }];
    const input = { id: 'mutable', label: 'Mutable', patchesByFile, selectionAfter, coalesceKey: 'text' };

    const result = session.history.execute(input);
    patch.replacement = 'Broken';
    patchesByFile.clear();
    selectionAfter[0].qualifiedTag = 'Label';

    expect(result.forward.patchesByFile.get(entryPath)).toEqual([{ start: 26, end: 30, replacement: 'Start' }]);
    expect(result.forward.selectionAfter?.[0].qualifiedTag).toBe('Button');
    expect(result.forward.coalesceKey).toBe('text');
    expect(Object.isFrozen(result.forward.patchesByFile.get(entryPath)?.[0])).toBe(true);
  });

  it('leaves both session and history unchanged when execution validation fails', () => {
    const session = openSession();
    const before = session.snapshot();

    expect(() => session.history.execute(edit('invalid', 'Invalid', new Map([
      [entryPath, [{ start: 99, end: 100, replacement: 'x' }]],
    ])))).toThrow();

    expect(session.snapshot()).toEqual(before);
    expect(session.history.canUndo).toBe(false);
    expect(session.history.canRedo).toBe(false);
  });

  it('keeps undo and redo stacks intact when reparsing either history direction fails', () => {
    const adapter = new SimpleAdapter();
    const session = openSession(adapter);
    const change = edit('first', 'First', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Start' }]]]));
    session.history.execute(change);
    const afterExecute = session.snapshot();
    adapter.failWhenSourceIncludes = 'Play';

    expect(() => session.history.undo()).toThrow(/parse/i);
    expect(session.snapshot()).toEqual(afterExecute);
    expect(session.history.canUndo).toBe(true);
    expect(session.history.canRedo).toBe(false);

    adapter.failWhenSourceIncludes = undefined;
    session.history.undo();
    const afterUndo = session.snapshot();
    adapter.failWhenSourceIncludes = 'Start';
    expect(() => session.history.redo()).toThrow(/parse/i);
    expect(session.snapshot()).toEqual(afterUndo);
    expect(session.history.canUndo).toBe(false);
    expect(session.history.canRedo).toBe(true);
  });

  it('rolls back every coalesced undo or redo step when its second reparse fails', () => {
    const adapter = new SimpleAdapter();
    const session = openSession(adapter);
    session.history.execute(edit('drag-1', 'Drag', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Step' }]]]), 'drag'));
    session.history.execute(edit('drag-2', 'Drag', new Map([[entryPath, [{ start: 26, end: 30, replacement: 'Stop' }]]]), 'drag'));
    const afterExecute = session.snapshot();
    adapter.failWhenSourceIncludes = 'Play';

    expect(() => session.history.undo()).toThrow(/parse/i);
    expect(session.snapshot()).toEqual(afterExecute);
    expect(session.history.canUndo).toBe(true);
    expect(session.history.canRedo).toBe(false);

    adapter.failWhenSourceIncludes = undefined;
    session.history.undo();
    const afterUndo = session.snapshot();
    adapter.failWhenSourceIncludes = 'Stop';

    expect(() => session.history.redo()).toThrow(/parse/i);
    expect(session.snapshot()).toEqual(afterUndo);
    expect(session.history.canUndo).toBe(false);
    expect(session.history.canRedo).toBe(true);
  });
});

function openSession(adapter = new SimpleAdapter()): DocumentSession {
  return DocumentSession.open(new Map([
    [entryPath, '<UXML><Button name="play">Play</Button></UXML>'],
    [sheetPath, '.button { color: red; }'],
  ]), entryPath, adapter);
}

function edit(id: string, label: string, patchesByFile: ReadonlyMap<string, readonly SourcePatch[]>, coalesceKey?: string) {
  return { id, label, patchesByFile, ...(coalesceKey === undefined ? {} : { coalesceKey }) };
}

class SimpleAdapter implements UxmlPreviewPort {
  failWhenSourceIncludes: string | undefined;

  parseProject(input: ProjectParseInput): ParsedPreviewDocument {
    if (this.failWhenSourceIncludes !== undefined && input.uxml.includes(this.failWhenSourceIncludes)) {
      throw new Error('Parse failed for history direction.');
    }
    const root: EditorElement = Object.freeze({
      id: 'root' as EditorNodeId,
      name: 'UXML',
      source: Object.freeze({ path: input.uxmlPath, start: 0, end: input.uxml.length }),
      attributes: Object.freeze([]),
      children: Object.freeze([Object.freeze({
        id: 'button' as EditorNodeId,
        name: 'Button',
        source: Object.freeze({ path: input.uxmlPath, start: 6, end: input.uxml.length - 7 }),
        attributes: Object.freeze([Object.freeze({ name: 'name', value: 'play', source: Object.freeze({ path: input.uxmlPath, start: 14, end: 25 }) })]),
        children: Object.freeze([]),
      })]),
    });
    return { source: { ...input, stylesheets: new Map(input.stylesheets) }, root, diagnostics: [], originsBySheet: [] };
  }
  serializeEntry(): never { throw new Error('Not used.'); }
  render(): Promise<never> { return Promise.reject(new Error('Not used.')); }
  explain(): null { return null; }
}
