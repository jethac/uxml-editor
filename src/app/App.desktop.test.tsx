import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UxmlPreviewAdapter } from '../core/adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../core/documents/DocumentSession';
import type { DesktopEvent } from '../core/desktop/DesktopCommandBridge';
import { EditorStore } from '../core/store/EditorStore';
import { App, type AppDesktopPorts, type Task16FileLifecyclePort } from './App';
import type { CloseChoice } from '../core/desktop/DesktopLifecycleController';

describe('App desktop integration', () => {
  it('registers close delivery before any awaited menu startup work', async () => {
    const events = new FakeDesktopEvents();
    let releaseMenu!: () => void;
    const menuBlocked = new Promise<void>((resolve) => { releaseMenu = resolve; });
    const desktop: AppDesktopPorts = {
      commandAuthority: Object.freeze({}),
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: {
        setLifecycleReady: async (generation, ready) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async () => undefined,
        abandonClose: async () => undefined,
      },
      menu: { setFileWorkflowEnabled: async () => menuBlocked },
      errors: { report: () => undefined },
    };
    const rendered = render(<App
      store={new EditorStore({ viewport: { width: 1024, height: 768 } })}
      desktop={desktop}
      task16FileLifecycle={task16Lifecycle()}
    />);

    await act(() => Promise.resolve());
    const closeListenersBeforeMenu = events.listenerCount('uxml://close-requested');
    releaseMenu();
    await listenersReady(events);

    expect(closeListenersBeforeMenu).toBe(1);
    rendered.unmount();
  });

  it('rolls native file workflow back to disabled and reports bridge startup failures', async () => {
    const menuStates: boolean[] = [];
    const errors: unknown[] = [];
    const desktop = {
      commandAuthority: Object.freeze({}),
      events: { listen: async () => { throw new Error('listen failed'); } },
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: { setLifecycleReady: async () => undefined, resolveClose: async () => undefined, abandonClose: async () => undefined },
      menu: { setFileWorkflowEnabled: async (_generation: string, enabled: boolean) => { menuStates.push(enabled); } },
      errors: { report: (error: unknown) => { errors.push(error); } },
    } as unknown as AppDesktopPorts;

    const rendered = render(<App
      store={new EditorStore({ viewport: { width: 1024, height: 768 } })}
      desktop={desktop}
      task16FileLifecycle={task16Lifecycle()}
    />);
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());

    expect(menuStates).toEqual([false]);
    expect(errors).toHaveLength(1);
    rendered.unmount();
  });

  it('enables file workflow only after both listeners are ready and disables it on disposal', async () => {
    const events = new FakeDesktopEvents();
    const menuStates: boolean[] = [];
    const desktop: AppDesktopPorts = {
      commandAuthority: Object.freeze({}),
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: {
        setLifecycleReady: async (generation, ready) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async () => undefined,
        abandonClose: async () => undefined,
      },
      menu: { setFileWorkflowEnabled: async (_generation, enabled) => { menuStates.push(enabled); } },
      errors: { report: () => undefined },
    };
    const rendered = render(<App
      store={new EditorStore({ viewport: { width: 1024, height: 768 } })}
      desktop={desktop}
      task16FileLifecycle={task16Lifecycle()}
    />);
    await listenersReady(events);
    expect(menuStates).toEqual([true]);

    rendered.unmount();
    await act(() => Promise.resolve());
    expect(menuStates).toEqual([true, false]);
  });

  it('keeps functioning command listeners attached when disposal disable fails', async () => {
    const events = new FakeDesktopEvents();
    const errors: unknown[] = [];
    let disableAttempts = 0;
    let saves = 0;
    const desktop: AppDesktopPorts = {
      commandAuthority: Object.freeze({}),
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: {
        setLifecycleReady: async (generation, ready) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async () => undefined,
        abandonClose: async () => undefined,
      },
      menu: {
        setFileWorkflowEnabled: async (_generation, enabled) => {
          if (!enabled) {
            disableAttempts += 1;
            if (disableAttempts === 1) throw new Error('disable failed');
          }
        },
      },
      errors: { report: (error) => { errors.push(error); } },
    };
    const rendered = render(<App
      store={new EditorStore({ viewport: { width: 1024, height: 768 } })}
      desktop={desktop}
      task16FileLifecycle={task16Lifecycle({ save: () => { saves += 1; } })}
    />);
    await listenersReady(events);

    rendered.unmount();
    await act(() => Promise.resolve());

    expect(errors).toHaveLength(1);
    expect(events.listenerCount('uxml://menu-command')).toBe(1);
    await events.emit('uxml://menu-command', { commandId: 'file.save' });
    expect(saves).toBe(1);
    await (errors[0] as { retry(): Promise<void> }).retry();
    expect(events.listenerCount('uxml://menu-command')).toBe(0);
  });

  it('ignores a stale delayed disable after a newer workflow generation is enabled', async () => {
    const events = new FakeDesktopEvents();
    let releaseOldDisable!: () => void;
    const oldDisableBlocked = new Promise<void>((resolve) => { releaseOldDisable = resolve; });
    let disableCalls = 0;
    let latestGeneration = -1;
    let enabled = false;
    const desktop: AppDesktopPorts = {
      commandAuthority: Object.freeze({}),
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: {
        setLifecycleReady: async (generation, ready) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async () => undefined,
        abandonClose: async () => undefined,
      },
      menu: {
        setFileWorkflowEnabled: async (...args: unknown[]) => {
          const generation = args.length === 2
            ? Number.parseInt(String(args[0]).slice('workflow:v1:'.length), 16)
            : 0;
          const requested = Boolean(args.at(-1));
          if (!requested) {
            disableCalls += 1;
            if (disableCalls === 1) await oldDisableBlocked;
          }
          if (generation < latestGeneration) return;
          latestGeneration = generation;
          enabled = requested;
        },
      },
      errors: { report: () => undefined },
    };
    const store = new EditorStore({ viewport: { width: 1024, height: 768 } });
    const rendered = render(<App store={store} desktop={desktop} task16FileLifecycle={task16Lifecycle()} />);
    await listenersReady(events);
    expect(enabled).toBe(true);

    rendered.rerender(<App store={store} desktop={desktop} task16FileLifecycle={task16Lifecycle()} />);
    for (let attempt = 0; attempt < 10 && events.listenerCount('uxml://menu-command') < 1; attempt += 1) {
      await act(() => Promise.resolve());
    }
    releaseOldDisable();
    await act(() => oldDisableBlocked);
    await act(() => Promise.resolve());

    expect(enabled).toBe(true);
    rendered.unmount();
  });

  it('executes file edit and view commands only on the newest listener generation after disable response loss', async () => {
    const events = new FakeDesktopEvents();
    const errors: unknown[] = [];
    let disableAttempts = 0;
    const desktop: AppDesktopPorts = {
      commandAuthority: Object.freeze({}),
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: {
        setLifecycleReady: async (generation, ready) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async () => undefined,
        abandonClose: async () => undefined,
      },
      menu: {
        setFileWorkflowEnabled: async (_generation, enabled) => {
          if (!enabled) {
            disableAttempts += 1;
            if (disableAttempts === 1) throw new Error('disable response lost');
          }
        },
      },
      errors: { report: (error) => { errors.push(error); } },
    };
    const store = new EditorStore({ viewport: { width: 1024, height: 768 } });
    const dispatch = vi.spyOn(store, 'dispatch');
    let oldSaves = 0;
    let currentSaves = 0;
    const oldLifecycle = task16Lifecycle({ save: () => { oldSaves += 1; } });
    const currentLifecycle = task16Lifecycle({ save: () => { currentSaves += 1; } });
    const rendered = render(<App store={store} desktop={desktop} task16FileLifecycle={oldLifecycle} />);
    await listenersReady(events);

    rendered.rerender(<App store={store} desktop={desktop} task16FileLifecycle={currentLifecycle} />);
    for (let attempt = 0; attempt < 12 && events.listenerCount('uxml://menu-command') < 2; attempt += 1) {
      await act(() => Promise.resolve());
    }
    expect(events.listenerCount('uxml://menu-command')).toBe(2);

    await act(() => events.emit('uxml://menu-command', { commandId: 'file.save' }));
    await act(() => events.emit('uxml://menu-command', { commandId: 'edit.undo' }));
    await act(() => events.emit('uxml://menu-command', { commandId: 'view.zoom-in' }));

    expect(oldSaves).toBe(0);
    expect(currentSaves).toBe(1);
    expect(dispatch.mock.calls.filter(([action]) => action.type === 'command/undo')).toHaveLength(1);
    expect(dispatch.mock.calls.filter(([action]) => action.type === 'command/zoom-in')).toHaveLength(1);
    expect(errors).toHaveLength(1);
    rendered.unmount();
  });

  it('never resurrects a retained older listener after its successor retires', async () => {
    const events = new FakeDesktopEvents();
    const errors: unknown[] = [];
    let disableAttempts = 0;
    let oldSaves = 0;
    let currentSaves = 0;
    const desktop: AppDesktopPorts = {
      commandAuthority: Object.freeze({}),
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: {
        setLifecycleReady: async (generation, ready) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async () => undefined,
        abandonClose: async () => undefined,
      },
      menu: {
        setFileWorkflowEnabled: async (_generation, enabled) => {
          if (!enabled) {
            disableAttempts += 1;
            if (disableAttempts === 1) throw new Error('old disable response lost');
          }
        },
      },
      errors: { report: (error) => { errors.push(error); } },
    };
    const store = new EditorStore({ viewport: { width: 1024, height: 768 } });
    const dispatch = vi.spyOn(store, 'dispatch');
    const rendered = render(<App
      store={store}
      desktop={desktop}
      task16FileLifecycle={task16Lifecycle({ save: () => { oldSaves += 1; } })}
    />);
    await listenersReady(events);

    rendered.rerender(<App
      store={store}
      desktop={desktop}
      task16FileLifecycle={task16Lifecycle({ save: () => { currentSaves += 1; } })}
    />);
    for (let attempt = 0; attempt < 12 && events.listenerCount('uxml://menu-command') < 2; attempt += 1) {
      await act(() => Promise.resolve());
    }
    expect(events.listenerCount('uxml://menu-command')).toBe(2);

    rendered.unmount();
    for (let attempt = 0; attempt < 12 && events.listenerCount('uxml://menu-command') !== 1; attempt += 1) {
      await act(() => Promise.resolve());
    }
    expect(events.listenerCount('uxml://menu-command')).toBe(1);
    await act(() => events.emit('uxml://menu-command', { commandId: 'file.save' }));
    await act(() => events.emit('uxml://menu-command', { commandId: 'edit.undo' }));
    await act(() => events.emit('uxml://menu-command', { commandId: 'view.zoom-in' }));

    expect(oldSaves).toBe(0);
    expect(currentSaves).toBe(0);
    expect(dispatch.mock.calls.filter(([action]) => action.type === 'command/undo')).toHaveLength(0);
    expect(dispatch.mock.calls.filter(([action]) => action.type === 'command/zoom-in')).toHaveLength(0);
    expect(errors).toHaveLength(1);
    await (errors[0] as { retry(): Promise<void> }).retry();
    expect(events.listenerCount('uxml://menu-command')).toBe(0);
  });

  it('executes commands once across distinct desktop wrappers sharing one transport authority', async () => {
    const events = new FakeDesktopEvents();
    const commandAuthority = Object.freeze({});
    const desktop = (): AppDesktopPorts => ({
      commandAuthority,
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: {
        setLifecycleReady: async (generation, ready) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async () => undefined,
        abandonClose: async () => undefined,
      },
      menu: { setFileWorkflowEnabled: async () => undefined },
      errors: { report: () => undefined },
    } as AppDesktopPorts);
    const oldStore = new EditorStore({ viewport: { width: 1024, height: 768 } });
    const currentStore = new EditorStore({ viewport: { width: 1024, height: 768 } });
    const oldDispatch = vi.spyOn(oldStore, 'dispatch');
    const currentDispatch = vi.spyOn(currentStore, 'dispatch');
    let oldSaves = 0;
    let currentSaves = 0;
    const old = render(<App
      store={oldStore}
      desktop={desktop()}
      task16FileLifecycle={task16Lifecycle({ save: () => { oldSaves += 1; } })}
    />);
    const current = render(<App
      store={currentStore}
      desktop={desktop()}
      task16FileLifecycle={task16Lifecycle({ save: () => { currentSaves += 1; } })}
    />);
    for (let attempt = 0; attempt < 12 && events.listenerCount('uxml://menu-command') < 2; attempt += 1) {
      await act(() => Promise.resolve());
    }

    await act(() => events.emit('uxml://menu-command', { commandId: 'file.save' }));
    await act(() => events.emit('uxml://menu-command', { commandId: 'edit.undo' }));
    await act(() => events.emit('uxml://menu-command', { commandId: 'view.zoom-in' }));

    expect(oldSaves).toBe(0);
    expect(currentSaves).toBe(1);
    expect(oldDispatch.mock.calls.filter(([action]) => action.type === 'command/undo')).toHaveLength(0);
    expect(oldDispatch.mock.calls.filter(([action]) => action.type === 'command/zoom-in')).toHaveLength(0);
    expect(currentDispatch.mock.calls.filter(([action]) => action.type === 'command/undo')).toHaveLength(1);
    expect(currentDispatch.mock.calls.filter(([action]) => action.type === 'command/zoom-in')).toHaveLength(1);
    old.unmount();
    current.unmount();
  });

  it('does not let a late older listener registration supersede a newer generation', async () => {
    const events = new FakeDesktopEvents();
    const commandAuthority = Object.freeze({});
    let releaseOldMenu!: () => void;
    const oldMenuBlocked = new Promise<void>((resolve) => { releaseOldMenu = resolve; });
    const oldDesktop = {
      commandAuthority,
      events: {
        listen: async (
          eventName: string,
          listener: (event: DesktopEvent<unknown>) => void | Promise<void>,
        ) => {
          if (eventName === 'uxml://menu-command') await oldMenuBlocked;
          return events.listen(eventName, listener);
        },
      },
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: {
        setLifecycleReady: async (generation: string, ready: boolean) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async () => undefined,
        abandonClose: async () => undefined,
      },
      menu: { setFileWorkflowEnabled: async () => undefined },
      errors: { report: () => undefined },
    } as AppDesktopPorts;
    const currentDesktop = { ...oldDesktop, events } as AppDesktopPorts;
    let oldSaves = 0;
    let currentSaves = 0;
    const old = render(<App
      store={new EditorStore({ viewport: { width: 1024, height: 768 } })}
      desktop={oldDesktop}
      task16FileLifecycle={task16Lifecycle({ save: () => { oldSaves += 1; } })}
    />);
    await act(() => Promise.resolve());
    const current = render(<App
      store={new EditorStore({ viewport: { width: 1024, height: 768 } })}
      desktop={currentDesktop}
      task16FileLifecycle={task16Lifecycle({ save: () => { currentSaves += 1; } })}
    />);
    for (let attempt = 0; attempt < 12 && events.listenerCount('uxml://menu-command') < 1; attempt += 1) {
      await act(() => Promise.resolve());
    }
    releaseOldMenu();
    await act(() => oldMenuBlocked);
    for (let attempt = 0; attempt < 12 && events.listenerCount('uxml://menu-command') < 2; attempt += 1) {
      await act(() => Promise.resolve());
    }

    await act(() => events.emit('uxml://menu-command', { commandId: 'file.save' }));

    expect(oldSaves).toBe(0);
    expect(currentSaves).toBe(1);
    old.unmount();
    current.unmount();
  });

  it('mounts current menu commands and clean close handling, then disposes native listeners', async () => {
    const events = new FakeDesktopEvents();
    let closes = 0;
    const desktop: AppDesktopPorts = {
      commandAuthority: Object.freeze({}),
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: {
        setLifecycleReady: async (generation, ready) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async (_lease, _generation, resolution) => { if (resolution === 'close') closes += 1; },
        abandonClose: async () => undefined,
      },
      menu: { setFileWorkflowEnabled: async () => undefined },
      errors: { report: () => undefined },
    };
    const store = new EditorStore({ viewport: { width: 1024, height: 768 } });
    const rendered = render(<App store={store} desktop={desktop} />);
    await listenersReady(events);

    await act(() => events.emit('uxml://menu-command', { commandId: 'view.pane-source' }));
    expect(store.getSnapshot().activePanel).toBe('source');
    await act(() => events.emit('uxml://close-requested', events.closeRequest()));
    expect(closes).toBe(1);

    rendered.unmount();
    await act(() => Promise.resolve());
    expect(events.listenerCount('uxml://menu-command')).toBe(0);
    expect(events.listenerCount('uxml://close-requested')).toBe(0);
  });

  it('uses the explicit Task 16 lifecycle hook and fails closed for an unowned open session', async () => {
    const events = new FakeDesktopEvents();
    let closes = 0;
    const desktop: AppDesktopPorts = {
      commandAuthority: Object.freeze({}),
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'discard' },
      window: {
        setLifecycleReady: async (generation, ready) => { events.setLifecycleReady(generation, ready); },
        resolveClose: async (_lease, _generation, resolution) => { if (resolution === 'close') closes += 1; },
        abandonClose: async () => undefined,
      },
      menu: { setFileWorkflowEnabled: async () => undefined },
      errors: { report: () => undefined },
    };
    const store = new EditorStore({ session: openSession(), viewport: { width: 1024, height: 768 } });
    const rendered = render(<App store={store} desktop={desktop} />);
    await listenersReady(events);

    await act(() => events.emit('uxml://close-requested', events.closeRequest()));
    expect(closes).toBe(0);

    rendered.unmount();
  });
});

class FakeDesktopEvents {
  private readonly listeners = new Map<string, Set<(event: DesktopEvent<unknown>) => void | Promise<void>>>();
  private lifecycleGeneration: string | undefined;

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

  setLifecycleReady(generation: string, ready: boolean): void {
    if (ready) this.lifecycleGeneration = generation;
    else if (this.lifecycleGeneration === generation) this.lifecycleGeneration = undefined;
  }

  closeRequest(): Readonly<{ lease: string; lifecycleGeneration: string }> {
    if (this.lifecycleGeneration === undefined) throw new Error('Lifecycle is not ready.');
    return Object.freeze({ lease: CLOSE_LEASE, lifecycleGeneration: this.lifecycleGeneration });
  }
}

async function listenersReady(events: FakeDesktopEvents): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (events.listenerCount('uxml://menu-command') === 1 && events.listenerCount('uxml://close-requested') === 1) return;
    await act(() => Promise.resolve());
  }
  throw new Error('Desktop listeners did not start.');
}

function openSession(): DocumentSession {
  return DocumentSession.open(
    new Map([['Assets/UI/Main.uxml', '<UXML><Button /></UXML>']]),
    'Assets/UI/Main.uxml',
    new UxmlPreviewAdapter(),
  );
}

const CLOSE_LEASE = `close:v1:${'d'.repeat(16)}`;

function task16Lifecycle(overrides: Partial<Task16FileLifecyclePort> = {}): Task16FileLifecyclePort {
  return Object.freeze({
    runExclusiveCloseState: async (
      _nativeLease: string,
      operation: (lease: Readonly<{ generation: number; dirtyState: 'clean' }>) => void | Promise<void>,
    ) => {
      await operation(Object.freeze({ generation: 0, dirtyState: 'clean' as const }));
    },
    finalValidateCloseState: () => true,
    saveBeforeClose: () => 'saved' as const,
    save: () => undefined,
    saveAll: () => undefined,
    closeProject: () => undefined,
    ...overrides,
  });
}
