import { describe, expect, it } from 'vitest';
import {
  DesktopLifecycleController,
  type CloseChoice,
  type DesktopEvent,
  type DirtyState,
  type SaveBeforeCloseResult,
} from './DesktopLifecycleController';

describe('DesktopLifecycleController', () => {
  it('closes clean windows without prompting or saving', async () => {
    const fixture = createFixture({ dirty: 'clean' });
    const disposable = await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', null);

    expect(fixture.confirmCalls).toBe(0);
    expect(fixture.saveCalls).toBe(0);
    expect(fixture.closeCalls).toBe(1);
    disposable.dispose();
  });

  it.each([
    { choice: 'discard' as const, save: 'cancelled' as const, expectedSaves: 0, expectedCloses: 1 },
    { choice: 'cancel' as const, save: 'saved' as const, expectedSaves: 0, expectedCloses: 0 },
    { choice: 'save' as const, save: 'saved' as const, expectedSaves: 1, expectedCloses: 1 },
    { choice: 'save' as const, save: 'cancelled' as const, expectedSaves: 1, expectedCloses: 0 },
    { choice: 'save' as const, save: 'failed' as const, expectedSaves: 1, expectedCloses: 0 },
  ])('honors a dirty $choice choice with $save save result', async ({ choice, save, expectedSaves, expectedCloses }) => {
    const fixture = createFixture({ dirty: 'dirty', choice, save });
    await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', null);

    expect(fixture.confirmCalls).toBe(1);
    expect(fixture.saveCalls).toBe(expectedSaves);
    expect(fixture.closeCalls).toBe(expectedCloses);
  });

  it('prevents close when Task 16 has not bound dirty ownership for an open session', async () => {
    const fixture = createFixture({ dirty: 'unknown' });
    await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', null);

    expect(fixture.confirmCalls).toBe(0);
    expect(fixture.saveCalls).toBe(0);
    expect(fixture.closeCalls).toBe(0);
  });

  it('rechecks dirty state after save and refuses a close raced by another edit', async () => {
    const dirtyStates: DirtyState[] = ['dirty', 'dirty'];
    const fixture = createFixture({ dirty: () => dirtyStates.shift() ?? 'dirty', choice: 'save', save: 'saved' });
    await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', null);

    expect(fixture.saveCalls).toBe(1);
    expect(fixture.closeCalls).toBe(0);
  });

  it('coalesces reentrant native close requests and never opens duplicate confirmation dialogs', async () => {
    let resolveChoice: ((choice: CloseChoice) => void) | undefined;
    const choice = new Promise<CloseChoice>((resolve) => { resolveChoice = resolve; });
    const fixture = createFixture({ dirty: 'dirty', choice: () => choice });
    await fixture.controller.start();

    const first = fixture.events.emit('uxml://close-requested', null);
    const second = fixture.events.emit('uxml://close-requested', null);
    await Promise.resolve();
    expect(fixture.confirmCalls).toBe(1);
    resolveChoice!('discard');
    await Promise.all([first, second]);
    expect(fixture.closeCalls).toBe(1);
  });

  it('contains save exceptions, allows a later retry, and disposes listeners idempotently', async () => {
    let attempt = 0;
    const fixture = createFixture({
      dirty: 'dirty',
      choice: 'save',
      save: async (): Promise<SaveBeforeCloseResult> => {
        attempt += 1;
        if (attempt === 1) throw new Error('disk full');
        return 'saved';
      },
    });
    const disposable = await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', null);
    expect(fixture.closeCalls).toBe(0);
    await fixture.events.emit('uxml://close-requested', null);
    expect(fixture.closeCalls).toBe(1);

    disposable.dispose();
    disposable.dispose();
    await fixture.events.emit('uxml://close-requested', null);
    expect(fixture.closeCalls).toBe(1);
    expect(fixture.events.listenerCount('uxml://close-requested')).toBe(0);
  });
});

type FixtureOptions = Readonly<{
  dirty: DirtyState | (() => DirtyState | Promise<DirtyState>);
  choice?: CloseChoice | (() => CloseChoice | Promise<CloseChoice>);
  save?: SaveBeforeCloseResult | (() => SaveBeforeCloseResult | Promise<SaveBeforeCloseResult>);
}>;

function createFixture(options: FixtureOptions) {
  const events = new FakeDesktopEvents();
  let confirmCalls = 0;
  let saveCalls = 0;
  let closeCalls = 0;
  let savedClean = false;
  const controller = new DesktopLifecycleController({
    events,
    dirty: {
      getDirtyState: async () => typeof options.dirty === 'function'
        ? options.dirty()
        : savedClean && options.dirty === 'dirty' ? 'clean' : options.dirty,
    },
    confirm: {
      confirmClose: async () => {
        confirmCalls += 1;
        return typeof options.choice === 'function' ? options.choice() : options.choice ?? 'cancel';
      },
    },
    save: {
      saveBeforeClose: async () => {
        saveCalls += 1;
        const result = await (typeof options.save === 'function' ? options.save() : options.save ?? 'cancelled');
        savedClean = result === 'saved';
        return result;
      },
    },
    window: { close: async () => { closeCalls += 1; } },
  });
  return {
    controller,
    events,
    get confirmCalls() { return confirmCalls; },
    get saveCalls() { return saveCalls; },
    get closeCalls() { return closeCalls; },
  };
}

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
