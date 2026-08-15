import { describe, expect, it, vi } from 'vitest';
import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../documents/DocumentSession';
import { MemoryHost } from '../host/MemoryHost';
import { EditorStore } from '../store/EditorStore';
import {
  DesktopCommandBridge,
  EditorDesktopCommandController,
  type DesktopCommandId,
  type DesktopEvent,
} from './DesktopCommandBridge';

describe('DesktopCommandBridge', () => {
  it('validates stable native menu events and stops dispatching after disposal', async () => {
    const source = new FakeDesktopEvents();
    const commands: DesktopCommandId[] = [];
    const bridge = new DesktopCommandBridge(source, { execute: (command) => { commands.push(command); } });
    const disposable = await bridge.start();

    await source.emit('uxml://menu-command', { commandId: 'edit.undo' });
    await source.emit('uxml://menu-command', { commandId: 'unknown.command' });
    await source.emit('uxml://menu-command', { commandId: 'edit.redo', injected: true });
    await source.emit('uxml://menu-command', null);
    expect(commands).toEqual(['edit.undo']);

    disposable.dispose();
    await source.emit('uxml://menu-command', { commandId: 'edit.redo' });
    expect(commands).toEqual(['edit.undo']);
    expect(source.listenerCount('uxml://menu-command')).toBe(0);
  });

  it('reports rejected command promises without rejecting the native event callback', async () => {
    const source = new FakeDesktopEvents();
    const failure = new Error('save failed');
    const errors: unknown[] = [];
    const BridgeWithErrors = DesktopCommandBridge as unknown as new (
      events: FakeDesktopEvents,
      executor: { execute(command: DesktopCommandId): Promise<void> },
      errors: { report(error: unknown): void },
    ) => DesktopCommandBridge;
    const bridge = new BridgeWithErrors(
      source,
      { execute: async () => { throw failure; } },
      { report: (error) => { errors.push(error); } },
    );
    await bridge.start();

    await expect(source.emit('uxml://menu-command', { commandId: 'file.save' })).resolves.toBeUndefined();
    expect(errors).toEqual([failure]);
  });

  it('routes open, undo, redo, zoom, and pane commands through current store semantics', async () => {
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': '<UXML />' } }],
    });
    const chooseProject = vi.spyOn(host, 'chooseProject');
    const session = openSession();
    session.history.execute({
      id: 'rename-control',
      label: 'Rename control',
      patchesByFile: new Map([['Assets/UI/Main.uxml', [{ start: 7, end: 13, replacement: 'Label' }]]]),
    });
    const store = new EditorStore({ host, session });
    const controller = new EditorDesktopCommandController(store);

    await controller.execute('file.open-project');
    await Promise.resolve();
    expect(chooseProject).toHaveBeenCalledTimes(1);

    await controller.execute('edit.undo');
    expect(session.snapshot().files.get('Assets/UI/Main.uxml')?.text).toBe('<UXML><Button /></UXML>');
    await controller.execute('edit.redo');
    expect(session.snapshot().files.get('Assets/UI/Main.uxml')?.text).toBe('<UXML><Label /></UXML>');

    await controller.execute('view.zoom-in');
    expect(store.getSnapshot().zoom).toBe(1.1);
    await controller.execute('view.zoom-out');
    expect(store.getSnapshot().zoom).toBe(1);
    await controller.execute('view.pane-source');
    expect(store.getSnapshot().activePanel).toBe('source');
    await controller.execute('view.pane-inspector');
    expect(store.getSnapshot().activePanel).toBe('inspector');
  });

  it('exposes narrow file-command hooks for Task 16 without implementing file workflow logic', async () => {
    const calls: string[] = [];
    const controller = new EditorDesktopCommandController(new EditorStore(), {
      save: async () => { calls.push('save'); },
      saveAll: async () => { calls.push('save-all'); },
      closeProject: async () => { calls.push('close-project'); },
    });

    await controller.execute('file.save');
    await controller.execute('file.save-all');
    await controller.execute('file.close-project');
    expect(calls).toEqual(['save', 'save-all', 'close-project']);
  });
});

class FakeDesktopEvents {
  private readonly listeners = new Map<string, Set<(event: DesktopEvent<unknown>) => void | Promise<void>>>();

  readonly listen = async (
    eventName: string,
    listener: (event: DesktopEvent<unknown>) => void | Promise<void>,
  ): Promise<() => void> => {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => { listeners.delete(listener); };
  };

  async emit(eventName: string, payload: unknown): Promise<void> {
    for (const listener of [...(this.listeners.get(eventName) ?? [])]) await listener({ payload });
  }

  listenerCount(eventName: string): number {
    return this.listeners.get(eventName)?.size ?? 0;
  }
}

function openSession(): DocumentSession {
  return DocumentSession.open(
    new Map([['Assets/UI/Main.uxml', '<UXML><Button /></UXML>']]),
    'Assets/UI/Main.uxml',
    new UxmlPreviewAdapter(),
  );
}
