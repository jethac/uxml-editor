import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UxmlPreviewAdapter } from '../core/adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../core/documents/DocumentSession';
import type { DesktopEvent } from '../core/desktop/DesktopCommandBridge';
import { EditorStore } from '../core/store/EditorStore';
import { App, type AppDesktopPorts } from './App';
import type { CloseChoice } from '../core/desktop/DesktopLifecycleController';

describe('App desktop integration', () => {
  it('keeps native file workflow disabled when unbound and reports bridge startup failures', async () => {
    const menuStates: boolean[] = [];
    const errors: unknown[] = [];
    const desktop = {
      events: { listen: async () => { throw new Error('listen failed'); } },
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: { resolveClose: async () => undefined },
      menu: { setFileWorkflowEnabled: async (enabled: boolean) => { menuStates.push(enabled); } },
      errors: { report: (error: unknown) => { errors.push(error); } },
    } as unknown as AppDesktopPorts;

    const rendered = render(<App
      store={new EditorStore({ viewport: { width: 1024, height: 768 } })}
      desktop={desktop}
    />);
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());

    expect(menuStates).toEqual([false]);
    expect(errors).toHaveLength(1);
    rendered.unmount();
  });
  it('mounts current menu commands and clean close handling, then disposes native listeners', async () => {
    const events = new FakeDesktopEvents();
    let closes = 0;
    const desktop: AppDesktopPorts = {
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'cancel' },
      window: { resolveClose: async (_lease, resolution) => { if (resolution === 'close') closes += 1; } },
      menu: { setFileWorkflowEnabled: async () => undefined },
      errors: { report: () => undefined },
    };
    const store = new EditorStore({ viewport: { width: 1024, height: 768 } });
    const rendered = render(<App store={store} desktop={desktop} />);
    await listenersReady(events);

    await act(() => events.emit('uxml://menu-command', { commandId: 'view.pane-source' }));
    expect(store.getSnapshot().activePanel).toBe('source');
    await act(() => events.emit('uxml://close-requested', CLOSE_REQUEST));
    expect(closes).toBe(1);

    rendered.unmount();
    expect(events.listenerCount('uxml://menu-command')).toBe(0);
    expect(events.listenerCount('uxml://close-requested')).toBe(0);
  });

  it('uses the explicit Task 16 lifecycle hook and fails closed for an unowned open session', async () => {
    const events = new FakeDesktopEvents();
    let closes = 0;
    const desktop: AppDesktopPorts = {
      events,
      confirm: { confirmClose: async (): Promise<CloseChoice> => 'discard' },
      window: { resolveClose: async (_lease, resolution) => { if (resolution === 'close') closes += 1; } },
      menu: { setFileWorkflowEnabled: async () => undefined },
      errors: { report: () => undefined },
    };
    const store = new EditorStore({ session: openSession(), viewport: { width: 1024, height: 768 } });
    const rendered = render(<App store={store} desktop={desktop} />);
    await listenersReady(events);

    await act(() => events.emit('uxml://close-requested', CLOSE_REQUEST));
    expect(closes).toBe(0);

    rendered.unmount();
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

const CLOSE_REQUEST = Object.freeze({ lease: `close:v1:${'d'.repeat(16)}` });
