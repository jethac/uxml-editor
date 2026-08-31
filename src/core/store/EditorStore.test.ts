import { describe, expect, it, vi } from 'vitest';
import { EDITOR_DIAGNOSTIC_KINDS } from '../adapter/types';
import type { EditorDiagnostic, EditorNodeId } from '../adapter/types';
import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../documents/DocumentSession';
import { MemoryHost } from '../host/MemoryHost';
import {
  DEFAULT_PANE_DIMENSIONS,
  DEFAULT_VIEWPORT,
  EDITOR_LAYOUT_STORAGE_KEY,
  PANE_LIMITS,
  type EditorLayoutStorage,
} from './EditorLayoutStorage';
import { EditorStore, EditorStoreError } from './EditorStore';

class MemoryLayoutStorage implements EditorLayoutStorage {
  readonly values = new Map<string, string>();
  readonly writes: { key: string; value: string }[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes.push({ key, value });
  }
}

describe('EditorStore snapshots', () => {
  it('publishes one stable deeply frozen snapshot until semantic state changes', () => {
    const store = new EditorStore();
    const first = store.getSnapshot();

    expect(store.getSnapshot()).toBe(first);
    expect(first).toMatchObject({
      session: null,
      host: null,
      selection: [],
      diagnostics: [],
      viewport: DEFAULT_VIEWPORT,
      panes: DEFAULT_PANE_DIMENSIONS,
      activeTool: 'select',
      activePanel: 'hierarchy',
      zoom: 1,
      previewState: 'edit',
      commands: {
        openProject: false,
        undo: false,
        redo: false,
        zoomIn: true,
        zoomOut: true,
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.selection)).toBe(true);
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
    expect(Object.isFrozen(first.viewport)).toBe(true);
    expect(Object.isFrozen(first.panes)).toBe(true);
    expect(Object.isFrozen(first.commands)).toBe(true);

    store.dispatch({ type: 'viewport/set', width: 1920, height: 1080 });
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot().viewport).toEqual({ width: 1920, height: 1080 });
  });

  it('copies selection and diagnostics at dispatch boundaries', () => {
    const store = new EditorStore();
    const selection = ['node-a'] as EditorNodeId[];
    const diagnostic: {
      origin: 'render';
      severity: 'warning';
      kind: 'asset-unresolved';
      message: string;
      source: { path: string; start: number; end: number };
    } = {
      origin: 'render',
      severity: 'warning',
      kind: 'asset-unresolved',
      message: 'Missing texture',
      source: { path: 'Assets/UI/Main.uxml', start: 10, end: 20 },
    };
    const diagnostics: EditorDiagnostic[] = [diagnostic];

    store.dispatch({ type: 'selection/set', selection });
    store.dispatch({ type: 'diagnostics/set', diagnostics });
    selection.push('node-b' as EditorNodeId);
    diagnostic.message = 'Changed outside the store';
    diagnostic.source.start = 99;

    expect(store.getSnapshot().selection).toEqual(['node-a']);
    expect(store.getSnapshot().diagnostics).toEqual([{
      origin: 'render',
      severity: 'warning',
      kind: 'asset-unresolved',
      message: 'Missing texture',
      source: { path: 'Assets/UI/Main.uxml', start: 10, end: 20 },
    }]);
    expect(Object.isFrozen(store.getSnapshot().diagnostics[0])).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().diagnostics[0].source)).toBe(true);
  });

  it('accepts every diagnostic kind the adapter can produce', () => {
    const store = new EditorStore();
    const diagnostics: EditorDiagnostic[] = EDITOR_DIAGNOSTIC_KINDS.map((kind) => ({
      origin: 'parse',
      severity: 'warning',
      kind,
      message: `${kind} happened`,
    }));

    store.dispatch({ type: 'diagnostics/set', diagnostics });

    expect(store.getSnapshot().diagnostics.map((diagnostic) => diagnostic.kind))
      .toEqual([...EDITOR_DIAGNOSTIC_KINDS]);
    expect(() => store.dispatch({
      type: 'diagnostics/set',
      diagnostics: [{ origin: 'parse', severity: 'warning', kind: 'not-a-kind', message: 'x' } as unknown as EditorDiagnostic],
    })).toThrow(EditorStoreError);
  });

  it('validates, derives, and deeply freezes deterministic project asset metadata', () => {
    const paths = [
      'Assets/UI/Icon.png',
      'Assets/Resources/Icons/Save.png',
      'Packages/com.example.ui/Resources/Themes/Dark.asset',
    ];
    const store = new EditorStore({ projectAssets: paths });
    paths[0] = 'Assets/changed.png';

    expect(store.getSnapshot().projectAssets).toEqual([
      { path: 'Assets/UI/Icon.png' },
      { path: 'Assets/Resources/Icons/Save.png', resourceKey: 'Icons/Save' },
      { path: 'Packages/com.example.ui/Resources/Themes/Dark.asset', resourceKey: 'Themes/Dark' },
    ]);
    expect(Object.isFrozen(store.getSnapshot().projectAssets)).toBe(true);
    expect(store.getSnapshot().projectAssets.every(Object.isFrozen)).toBe(true);
  });

  it('allows noncolliding path assets and preserves exact derived resource formatting', () => {
    const store = new EditorStore({ projectAssets: [
      'Assets/First/Icon.png',
      'Assets/Second/Icon.png',
      'Assets/First/Resources/Icons/Open.png',
      'Assets/Second/Resources/Icons/Save.asset',
    ] });

    expect(store.getSnapshot().projectAssets).toEqual([
      { path: 'Assets/First/Icon.png' },
      { path: 'Assets/Second/Icon.png' },
      { path: 'Assets/First/Resources/Icons/Open.png', resourceKey: 'Icons/Open' },
      { path: 'Assets/Second/Resources/Icons/Save.asset', resourceKey: 'Icons/Save' },
    ]);
  });

  it.each([
    [
      'Assets/One/Resources/Icons/Save.png',
      'Packages/com.example.ui/Resources/Icons/Save.asset',
      'Icons/Save',
    ],
    [
      'Assets/Resources/Themes/Dark.png',
      'Assets/Resources/Themes/Dark.asset',
      'Themes/Dark',
    ],
  ])('rejects ambiguous logical resource keys for %s and %s', (first, second, resourceKey) => {
    let message = '';
    try {
      new EditorStore({ projectAssets: [first, second] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(`Ambiguous project resource key "${resourceKey}"`);
    expect(message).toContain(first);
    expect(message).toContain(second);
    expect(message).not.toMatch(/[A-Za-z]:\\/);
  });

  it('replaces project assets through a validated action and clears them with authority replacement', () => {
    const first = openSession();
    const second = openSession();
    const store = new EditorStore({ session: first, projectAssets: ['Assets/Resources/Old.asset'] });

    store.dispatch({ type: 'project-assets/set', paths: ['Assets/Resources/New.asset', 'Assets/UI/New.png'] });
    expect(store.getSnapshot().projectAssets).toEqual([
      { path: 'Assets/Resources/New.asset', resourceKey: 'New' },
      { path: 'Assets/UI/New.png' },
    ]);

    store.dispatch({ type: 'context/set', session: second, host: null });
    expect(store.getSnapshot().projectAssets).toEqual([]);
    expect(() => store.dispatch({ type: 'project-assets/set', paths: ['../outside.png'] })).toThrow(EditorStoreError);
    expect(store.getSnapshot().projectAssets).toEqual([]);
  });

  it.each([
    { projectAssets: ['../outside.png'] },
    { projectAssets: ['Assets/UI/no-extension'] },
    { projectAssets: ['Assets/UI/unsafe"name.png'] },
    { projectAssets: ['Assets/UI/Icon.png', 'Assets/UI/Icon.png'] },
  ])('rejects malformed project asset options before publishing a snapshot: $projectAssets', ({ projectAssets }) => {
    expect(() => new EditorStore({ projectAssets })).toThrow(EditorStoreError);
  });
});

describe('EditorStore subscriptions', () => {
  it('keeps duplicate subscriptions independent and preserves thrown undefined', () => {
    const store = new EditorStore();
    const listener = vi.fn();
    const unsubscribeFirst = store.subscribe(listener);
    const unsubscribeSecond = store.subscribe(listener);
    store.dispatch({ type: 'zoom/set', zoom: 1.25 });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    store.dispatch({ type: 'zoom/set', zoom: 1.5 });
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribeSecond();

    let followingListenerCalled = false;
    store.subscribe(() => { throw undefined; });
    store.subscribe(() => { followingListenerCalled = true; });
    let threw = false;
    try {
      store.dispatch({ type: 'zoom/set', zoom: 1.75 });
    } catch (error) {
      threw = true;
      expect(error).toBeUndefined();
    }
    expect(threw).toBe(true);
    expect(followingListenerCalled).toBe(true);
  });

  it('notifies current listeners once and makes unsubscribe idempotent', () => {
    const store = new EditorStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.dispatch({ type: 'zoom/set', zoom: 1.25 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();
    store.dispatch({ type: 'zoom/set', zoom: 1.5 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('preserves the snapshot and skips notification for semantic no-op actions', () => {
    const store = new EditorStore({ viewport: { width: 1366, height: 768 } });
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    store.dispatch({ type: 'viewport/set', width: 1366, height: 768 });
    store.dispatch({ type: 'zoom/set', zoom: 1 });
    store.dispatch({ type: 'selection/set', selection: [] });
    store.dispatch({ type: 'diagnostics/set', diagnostics: [] });

    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('queues reentrant dispatch until every listener observes the current snapshot', () => {
    const store = new EditorStore();
    const observations: string[] = [];

    store.subscribe(() => {
      const zoom = store.getSnapshot().zoom;
      observations.push(`first:${zoom}`);
      if (zoom === 1.25) store.dispatch({ type: 'zoom/set', zoom: 1.5 });
    });
    store.subscribe(() => {
      observations.push(`second:${store.getSnapshot().zoom}`);
    });

    store.dispatch({ type: 'zoom/set', zoom: 1.25 });

    expect(observations).toEqual([
      'first:1.25',
      'second:1.25',
      'first:1.5',
      'second:1.5',
    ]);
  });

  it('uses a listener snapshot when subscriptions change during notification', () => {
    const store = new EditorStore();
    const observations: string[] = [];
    let unsubscribeSecond: () => void = () => undefined;

    store.subscribe(() => {
      observations.push('first');
      unsubscribeSecond();
    });
    unsubscribeSecond = store.subscribe(() => {
      observations.push('second');
    });

    store.dispatch({ type: 'zoom/set', zoom: 1.25 });
    store.dispatch({ type: 'zoom/set', zoom: 1.5 });

    expect(observations).toEqual(['first', 'second', 'first']);
  });
});

describe('EditorStore validation and pane persistence', () => {
  it.each([
    null,
    {},
    { type: 'viewport/set', width: Number.NaN, height: 768 },
    { type: 'viewport/set', width: 720, height: 0 },
    { type: 'panes/resize', pane: 'center', size: 200, persist: false },
    { type: 'panes/resize', pane: 'left', size: Number.POSITIVE_INFINITY, persist: false },
    { type: 'zoom/set', zoom: 'large' },
    { type: 'preview/set', state: 'running' },
    { type: 'tool/set', tool: 'paint' },
    { type: 'panel/set', panel: 'assets' },
    {
      type: 'context/set',
      host: null,
      session: {
        entryPath: 'Assets/UI/Main.uxml',
        snapshot: () => ({}),
        setSelection: () => undefined,
        selectedNodeIds: [],
        diagnostics: [],
        history: { canUndo: true, canRedo: false },
      },
    },
  ])('rejects malformed action input %#', (action) => {
    const store = new EditorStore();
    expect(() => store.dispatch(action as never)).toThrow(EditorStoreError);
  });

  it('clamps pane movement to the exported desktop limits', () => {
    const store = new EditorStore();

    store.dispatch({ type: 'panes/resize', pane: 'left', size: 20, persist: false });
    store.dispatch({ type: 'panes/resize', pane: 'right', size: 900, persist: false });
    store.dispatch({ type: 'panes/resize', pane: 'bottom', size: 220, persist: false });

    expect(store.getSnapshot().panes).toEqual({
      left: PANE_LIMITS.left.min,
      right: PANE_LIMITS.right.max,
      bottom: 220,
    });
  });

  it('persists the final clamped pane dimensions with the versioned UI-layout schema', () => {
    const storage = new MemoryLayoutStorage();
    const store = new EditorStore({ storage });

    store.dispatch({ type: 'panes/resize', pane: 'left', size: 312, persist: false });
    expect(storage.writes).toHaveLength(0);

    store.dispatch({ type: 'panes/resize', pane: 'left', size: 312, persist: true });

    expect(storage.writes).toEqual([{
      key: EDITOR_LAYOUT_STORAGE_KEY,
      value: JSON.stringify({ version: 1, panes: { left: 312, right: 280, bottom: 180 } }),
    }]);
  });

  it('restores and clamps finite pane dimensions from UI storage', () => {
    const storage = new MemoryLayoutStorage();
    storage.values.set(EDITOR_LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 1,
      panes: { left: -50, right: 999, bottom: 144 },
    }));

    const store = new EditorStore({ storage });

    expect(store.getSnapshot().panes).toEqual({ left: 160, right: 480, bottom: 144 });
  });

  it.each([
    '{bad json',
    JSON.stringify({ version: 2, panes: DEFAULT_PANE_DIMENSIONS }),
    JSON.stringify({ version: 1, panes: { left: '240', right: 280, bottom: 180 } }),
    '{"version":1,"panes":{"left":1e309,"right":280,"bottom":180}}',
    JSON.stringify({ version: 1, panes: { left: 240, right: null, bottom: 180 } }),
  ])('falls back to defaults for corrupt or incompatible layout data: %s', (serialized) => {
    const storage = new MemoryLayoutStorage();
    storage.values.set(EDITOR_LAYOUT_STORAGE_KEY, serialized);

    expect(new EditorStore({ storage }).getSnapshot().panes).toEqual(DEFAULT_PANE_DIMENSIONS);
  });

  it('falls back when storage reads throw and keeps state usable when writes throw', () => {
    const storage: EditorLayoutStorage = {
      getItem: () => { throw new Error('blocked read'); },
      setItem: () => { throw new Error('blocked write'); },
    };
    const store = new EditorStore({ storage });

    expect(store.getSnapshot().panes).toEqual(DEFAULT_PANE_DIMENSIONS);
    expect(() => store.dispatch({
      type: 'panes/resize',
      pane: 'bottom',
      size: 260,
      persist: true,
    })).not.toThrow();
    expect(store.getSnapshot().panes.bottom).toBe(260);
  });
});

describe('EditorStore command state', () => {
  it('derives open, undo, and redo availability from host and session references', () => {
    const host = new MemoryHost();
    const session = openSession();
    const store = new EditorStore();

    store.dispatch({ type: 'context/set', host, session });
    expect(store.getSnapshot().host).toBe(host);
    expect(store.getSnapshot().session).toBe(session);
    expect(store.getSnapshot().commands).toMatchObject({ openProject: true, undo: false, redo: false });

    session.history.execute({
      id: 'rename-control',
      label: 'Rename control',
      patchesByFile: new Map([['Assets/UI/Main.uxml', [{ start: 7, end: 13, replacement: 'Label' }]]]),
    });
    store.dispatch({ type: 'session/sync' });
    expect(store.getSnapshot().commands).toMatchObject({ openProject: true, undo: true, redo: false });

    store.dispatch({ type: 'command/undo' });
    expect(session.snapshot().files.get('Assets/UI/Main.uxml')?.text).toBe('<UXML><Button /></UXML>');
    expect(store.getSnapshot().commands).toMatchObject({ openProject: true, undo: false, redo: true });

    store.dispatch({ type: 'command/redo' });
    expect(session.snapshot().files.get('Assets/UI/Main.uxml')?.text).toBe('<UXML><Label /></UXML>');
    expect(store.getSnapshot().commands).toMatchObject({ openProject: true, undo: true, redo: false });
  });

  it('syncs immutable session selection and diagnostics without storing the document graph', () => {
    const session = openSession('<UXML><UnknownControl /></UXML>');
    const selected = session.document.root.children[0].id;
    const locator = session.locatorFor(selected)!;
    session.setSelection([locator]);
    const store = new EditorStore({ session });

    expect(store.getSnapshot().session).toBe(session);
    expect(store.getSnapshot()).not.toHaveProperty('document');
    expect(store.getSnapshot().selection).toEqual([selected]);
    expect(store.getSnapshot().selection).not.toBe(session.selectedNodeIds);
    expect(store.getSnapshot().diagnostics).toEqual(session.diagnostics);
    expect(store.getSnapshot().diagnostics).not.toBe(session.diagnostics);
  });

  it('clears active state when the same authored name resolves to a different qualified tag', () => {
    const source = '<UXML><Button name="target"></Button></UXML>';
    const session = openSession(source);
    const target = session.document.root.children[0];
    const locator = session.locatorFor(target.id)!;
    const store = new EditorStore({ session });
    store.dispatch({ type: 'active-states/toggle', locator, state: 'hover' });
    expect(store.getSnapshot().activeStates).toHaveLength(1);

    const start = source.indexOf('Button');
    session.history.execute({
      id: 'replace-tag',
      label: 'Replace tag',
      patchesByFile: new Map([['Assets/UI/Main.uxml', [
        { start, end: start + 'Button'.length, replacement: 'Label' },
        { start: source.lastIndexOf('Button'), end: source.lastIndexOf('Button') + 'Button'.length, replacement: 'Label' },
      ]]]),
    });
    store.dispatch({ type: 'session/sync' });

    expect(store.getSnapshot().activeStates).toEqual([]);
  });

  it('invokes host project selection only when the command is available', async () => {
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': '<UXML />' } }],
    });
    const chooseProject = vi.spyOn(host, 'chooseProject');
    const store = new EditorStore();

    store.dispatch({ type: 'command/open-project' });
    expect(chooseProject).not.toHaveBeenCalled();

    store.dispatch({ type: 'context/set', host, session: null });
    store.dispatch({ type: 'command/open-project' });
    await Promise.resolve();
    expect(chooseProject).toHaveBeenCalledTimes(1);
  });
});

function openSession(source = '<UXML><Button /></UXML>'): DocumentSession {
  return DocumentSession.open(
    new Map([['Assets/UI/Main.uxml', source]]),
    'Assets/UI/Main.uxml',
    new UxmlPreviewAdapter(),
  );
}
