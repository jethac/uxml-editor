import { describe, expect, it, vi } from 'vitest';
import { DocumentSession } from '../documents/DocumentSession';
import { MemoryHost } from '../host/MemoryHost';
import { PersistenceTestAdapter } from '../persistence/persistenceTestSupport';
import { CommandRegistry, EDITOR_COMMAND_IDS, type EditorFileCommandPort } from './CommandRegistry';
import { EditorStore } from './EditorStore';
import commandDefinitions from './CommandDefinitions.json';

describe('CommandRegistry', () => {
  it('defines the complete stable editor command surface once', () => {
    const { registry } = fixture();

    expect(registry.getSnapshot().commands.map(({ id }) => id)).toEqual(EDITOR_COMMAND_IDS);
    expect(registry.command('file.save')).toMatchObject({ label: 'Save', category: 'File' });
    expect(registry.command('edit.duplicate')).toMatchObject({ label: 'Duplicate', category: 'Edit' });
    expect(registry.command('view.pane-diagnostics')).toMatchObject({ label: 'Show Diagnostics', category: 'View' });
  });

  it('uses native Windows and macOS shortcut conventions from the same definitions', () => {
    const windows = fixture('windows').registry;
    const mac = fixture('mac').registry;

    expect(windows.command('file.save').shortcut).toBe('Ctrl+S');
    expect(mac.command('file.save').shortcut).toBe('Meta+S');
    expect(windows.command('edit.redo').shortcut).toBe('Ctrl+Y');
    expect(mac.command('edit.redo').shortcut).toBe('Meta+Shift+Z');
    expect(windows.command('edit.delete').shortcut).toBe('Delete');
    expect(mac.command('edit.delete').shortcut).toBe('Backspace');
  });

  it('uses the shared declarative identity, label, section, and platform accelerator metadata', () => {
    const windows = fixture('windows').registry;
    const mac = fixture('mac').registry;

    expect(windows.getSnapshot().commands.map((command) => ({
      id: command.id,
      label: command.label,
      section: command.category,
      accelerator: command.shortcut,
    }))).toEqual(commandDefinitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      section: definition.section,
      accelerator: definition.windowsAccelerator,
    })));
    expect(mac.getSnapshot().commands.map((command) => command.shortcut))
      .toEqual(commandDefinitions.map((definition) => definition.macAccelerator));
    expect(commandDefinitions.find(({ id }) => id === 'file.save-as')?.windowsAccelerator)
      .not.toBe(commandDefinitions.find(({ id }) => id === 'file.save-all')?.windowsAccelerator);
  });

  it('derives availability and refuses unavailable actions without removing definitions', async () => {
    const { registry, file } = fixture();

    expect(registry.command('file.save').enabled).toBe(false);
    expect(registry.command('edit.undo').enabled).toBe(false);
    expect(await registry.execute('file.save')).toEqual({ status: 'unavailable' });
    expect(file.save).not.toHaveBeenCalled();
    expect(registry.getSnapshot().commands).toHaveLength(EDITOR_COMMAND_IDS.length);
  });

  it('derives every file command from explicit workflow capabilities', () => {
    const { registry, file } = fixture();
    const snapshot = file.getSnapshot();
    vi.spyOn(file, 'getSnapshot').mockReturnValue(Object.freeze({
      ...snapshot,
      capabilities: unavailableFileCapabilities(),
    }) as ReturnType<EditorFileCommandPort['getSnapshot']>);

    expect(registry.command('file.new-project').enabled).toBe(false);
    expect(registry.command('file.open-project').enabled).toBe(false);
    expect(registry.command('file.save').enabled).toBe(false);
    expect(registry.command('file.close-project').enabled).toBe(false);
  });

  it('contains rejected execution and reports it through the configured command error boundary', async () => {
    const { store, file } = fixture();
    const failure = new Error('injected open failure');
    file.openProject = vi.fn().mockRejectedValue(failure);
    const report = vi.fn();
    const registry = new CommandRegistry({
      store,
      file,
      platform: 'windows',
      errors: { report },
    });

    await expect(registry.execute('file.open-project')).resolves.toEqual({
      status: 'failed',
      error: failure,
    });
    expect(report).toHaveBeenCalledWith(registry.command('file.open-project'), failure);
  });

  it('routes file, history, zoom, diagnostics, and pane actions through registered definitions', async () => {
    const { registry, store, file } = fixture();
    const session = DocumentSession.open(
      new Map([['Assets/Main.uxml', '<UXML />']]),
      'Assets/Main.uxml',
      new PersistenceTestAdapter(),
    );
    session.history.execute({
      id: 'edit',
      label: 'Edit',
      patchesByFile: new Map([['Assets/Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    store.dispatch({ type: 'context/set', session, host: store.getSnapshot().host });

    expect(await registry.execute('file.save')).toEqual({ status: 'executed' });
    expect(file.save).toHaveBeenCalledTimes(1);
    await registry.execute('edit.undo');
    expect(session.history.canRedo).toBe(true);
    await registry.execute('view.zoom-in');
    expect(store.getSnapshot().zoom).toBe(1.1);
    await registry.execute('view.pane-diagnostics');
    expect(store.getSnapshot().activePanel).toBe('diagnostics');
  });

  it('keeps duplicate snapshot subscriptions independent', () => {
    const { registry, store } = fixture();
    const listener = vi.fn();
    const unsubscribeFirst = registry.subscribe(listener);
    const unsubscribeSecond = registry.subscribe(listener);

    store.dispatch({ type: 'zoom/set', zoom: 1.1 });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribeFirst();
    store.dispatch({ type: 'zoom/set', zoom: 1.2 });
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribeSecond();
  });
});

function fixture(platform: 'windows' | 'mac' = 'windows') {
  const host = new MemoryHost();
  const store = new EditorStore({ host, viewport: { width: 1280, height: 720 } });
  const save = vi.fn<() => void>();
  const file: EditorFileCommandPort & { readonly save: typeof save } = {
    newProject: vi.fn(),
    openProject: vi.fn(),
    openRecent: vi.fn(),
    save,
    saveAs: vi.fn(),
    saveAll: vi.fn(),
    closeProject: vi.fn(),
    reopenProject: vi.fn(),
    reloadProject: vi.fn(),
    getSnapshot: () => Object.freeze({
      projectName: store.getSnapshot().session === null ? null : 'Project',
      dirtyState: 'clean' as const,
      recentProjects: Object.freeze([]),
      canReopen: false,
      canReload: false,
      capabilities: Object.freeze({
        newProject: true,
        openProject: true,
        openRecent: false,
        save: store.getSnapshot().session !== null,
        saveAs: store.getSnapshot().session !== null,
        saveAll: store.getSnapshot().session !== null,
        closeProject: store.getSnapshot().session !== null,
        reopenProject: false,
        reloadProject: false,
      }),
    }),
    subscribe: () => () => undefined,
  };
  return {
    store,
    file,
    registry: new CommandRegistry({ store, file, platform, errors: { report: vi.fn() } }),
  };
}

function unavailableFileCapabilities() {
  return Object.freeze({
    newProject: false,
    openProject: false,
    openRecent: false,
    save: false,
    saveAs: false,
    saveAll: false,
    closeProject: false,
    reopenProject: false,
    reloadProject: false,
  });
}
