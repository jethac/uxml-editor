import { describe, expect, it } from 'vitest';
import {
  DesktopLifecycleController,
  type CloseChoice,
  type DesktopEvent,
  type DocumentStateLease,
  type DirtyState,
  type SaveBeforeCloseResult,
} from './DesktopLifecycleController';

describe('DesktopLifecycleController', () => {
  it('publishes readiness only after listening and withdraws it on disposal', async () => {
    const events = new FakeDesktopEvents();
    const readiness: boolean[] = [];
    const window = {
      setLifecycleReady: async (ready: boolean) => { readiness.push(ready); },
      resolveClose: async () => undefined,
    };
    const controller = new DesktopLifecycleController({
      events,
      state: fixedState('clean'),
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window,
    });

    const disposable = await controller.start();
    expect(events.listenerCount('uxml://close-requested')).toBe(1);
    expect(readiness).toEqual([true]);

    disposable.dispose();
    await disposable.completion;
    expect(readiness).toEqual([true, false]);
    expect(events.listenerCount('uxml://close-requested')).toBe(0);
  });

  it('holds one validated native lease through dirty evaluation and resolves it atomically', async () => {
    const lease = `close:v1:${'a'.repeat(16)}`;
    const events = new FakeDesktopEvents();
    const observations: Array<readonly [string, string]> = [];
    const controller = new DesktopLifecycleController({
      events,
      state: {
        acquire: (observed) => {
          observations.push([observed, 'acquire']);
          return stateLease(1, 'clean');
        },
        finalValidate: (observed) => {
          observations.push([String(observed.generation), 'validate']);
          return true;
        },
        release: (observed) => { observations.push([String(observed.generation), 'release']); },
      },
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: { setLifecycleReady: async () => undefined, resolveClose: async (...args: unknown[]) => {
        observations.push([String(args[0] ?? '<missing>'), String(args[1] ?? '<missing>')]);
      } },
    });
    await controller.start();

    await events.emit('uxml://close-requested', { lease });

    expect(observations).toEqual([
      [lease, 'acquire'],
      ['1', 'validate'],
      [lease, 'close'],
      ['1', 'release'],
    ]);
  });

  it('resolves cancellation natively so a later close generation can proceed', async () => {
    const lease = `close:v1:${'b'.repeat(16)}`;
    const events = new FakeDesktopEvents();
    const resolutions: unknown[][] = [];
    const controller = new DesktopLifecycleController({
      events,
      state: fixedState('dirty'),
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: { setLifecycleReady: async () => undefined, resolveClose: async (...args: unknown[]) => { resolutions.push(args); } },
    });
    await controller.start();

    await events.emit('uxml://close-requested', { lease });

    expect(resolutions).toEqual([[lease, 'cancel']]);
  });
  it('closes clean windows without prompting or saving', async () => {
    const fixture = createFixture({ dirty: 'clean' });
    const disposable = await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', CLOSE_REQUEST);

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

    await fixture.events.emit('uxml://close-requested', CLOSE_REQUEST);

    expect(fixture.confirmCalls).toBe(1);
    expect(fixture.saveCalls).toBe(expectedSaves);
    expect(fixture.closeCalls).toBe(expectedCloses);
  });

  it('prevents close when Task 16 has not bound dirty ownership for an open session', async () => {
    const fixture = createFixture({ dirty: 'unknown' });
    await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', CLOSE_REQUEST);

    expect(fixture.confirmCalls).toBe(0);
    expect(fixture.saveCalls).toBe(0);
    expect(fixture.closeCalls).toBe(0);
  });

  it('rechecks dirty state after save and refuses a close raced by another edit', async () => {
    const dirtyStates: DirtyState[] = ['dirty', 'dirty'];
    const fixture = createFixture({ dirty: () => dirtyStates.shift() ?? 'dirty', choice: 'save', save: 'saved' });
    await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', CLOSE_REQUEST);

    expect(fixture.saveCalls).toBe(1);
    expect(fixture.closeCalls).toBe(0);
  });

  it('cancels when an edit arrives after a clean decision but before native resolution', async () => {
    let edited = false;
    const events = new FakeDesktopEvents();
    const resolutions: string[] = [];
    const controller = new DesktopLifecycleController({
      events,
      state: {
        acquire: () => {
          queueMicrotask(() => { edited = true; });
          return stateLease(0, 'clean');
        },
        finalValidate: () => !edited,
        release: () => undefined,
      },
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: { setLifecycleReady: async () => undefined, resolveClose: async (_lease, resolution) => { resolutions.push(resolution); } },
    });
    await controller.start();

    await events.emit('uxml://close-requested', CLOSE_REQUEST);

    expect(edited).toBe(true);
    expect(resolutions).toEqual(['cancel']);
  });

  it('cancels when an edit arrives after Discard but before native resolution', async () => {
    let edited = false;
    const events = new FakeDesktopEvents();
    const resolutions: string[] = [];
    const controller = new DesktopLifecycleController({
      events,
      state: {
        acquire: () => stateLease(0, 'dirty'),
        finalValidate: () => !edited,
        release: () => undefined,
      },
      confirm: { confirmClose: () => {
        queueMicrotask(() => { edited = true; });
        return 'discard';
      } },
      save: { saveBeforeClose: () => 'cancelled' },
      window: { setLifecycleReady: async () => undefined, resolveClose: async (_lease, resolution) => { resolutions.push(resolution); } },
    });
    await controller.start();

    await events.emit('uxml://close-requested', CLOSE_REQUEST);

    expect(edited).toBe(true);
    expect(resolutions).toEqual(['cancel']);
  });

  it('cancels when an edit arrives after the post-save clean decision', async () => {
    let dirty: DirtyState = 'dirty';
    let edited = false;
    const events = new FakeDesktopEvents();
    const resolutions: string[] = [];
    const controller = new DesktopLifecycleController({
      events,
      state: {
        acquire: () => stateLease(0, dirty),
        finalValidate: () => !edited,
        release: () => undefined,
      },
      confirm: { confirmClose: () => 'save' },
      save: { saveBeforeClose: () => {
        dirty = 'clean';
        queueMicrotask(() => { dirty = 'dirty'; edited = true; });
        return 'saved';
      } },
      window: { setLifecycleReady: async () => undefined, resolveClose: async (_lease, resolution) => { resolutions.push(resolution); } },
    });
    await controller.start();

    await events.emit('uxml://close-requested', CLOSE_REQUEST);

    expect(dirty).toBe('dirty');
    expect(resolutions).toEqual(['cancel']);
  });

  it('coalesces reentrant native close requests and never opens duplicate confirmation dialogs', async () => {
    let resolveChoice: ((choice: CloseChoice) => void) | undefined;
    const choice = new Promise<CloseChoice>((resolve) => { resolveChoice = resolve; });
    const fixture = createFixture({ dirty: 'dirty', choice: () => choice });
    await fixture.controller.start();

    const first = fixture.events.emit('uxml://close-requested', CLOSE_REQUEST);
    const second = fixture.events.emit('uxml://close-requested', CLOSE_REQUEST);
    for (let attempt = 0; attempt < 4 && fixture.confirmCalls === 0; attempt += 1) {
      await Promise.resolve();
    }
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

    await fixture.events.emit('uxml://close-requested', CLOSE_REQUEST);
    expect(fixture.closeCalls).toBe(0);
    await fixture.events.emit('uxml://close-requested', CLOSE_REQUEST);
    expect(fixture.closeCalls).toBe(1);

    disposable.dispose();
    disposable.dispose();
    await fixture.events.emit('uxml://close-requested', CLOSE_REQUEST);
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
  let generation = 0;
  const controller = new DesktopLifecycleController({
    events,
    state: {
      acquire: async () => stateLease(
        generation,
        await (typeof options.dirty === 'function'
          ? options.dirty()
          : savedClean && options.dirty === 'dirty' ? 'clean' : options.dirty),
      ),
      finalValidate: async (lease) => {
        if (lease.generation !== generation) return false;
        if (!savedClean) return true;
        if (typeof options.dirty !== 'function') return true;
        return await options.dirty() === 'clean';
      },
      release: async () => undefined,
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
    window: { setLifecycleReady: async () => undefined, resolveClose: async (_lease, resolution) => {
      if (resolution === 'close') closeCalls += 1;
    } },
  });
  return {
    controller,
    events,
    get confirmCalls() { return confirmCalls; },
    get saveCalls() { return saveCalls; },
    get closeCalls() { return closeCalls; },
  };
}

function stateLease(generation: number, dirtyState: DirtyState): DocumentStateLease {
  return Object.freeze({ generation, dirtyState });
}

function fixedState(dirtyState: DirtyState) {
  return Object.freeze({
    acquire: () => stateLease(0, dirtyState),
    finalValidate: () => true,
    release: () => undefined,
  });
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

const CLOSE_REQUEST = Object.freeze({ lease: `close:v1:${'c'.repeat(16)}` });
