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
      setLifecycleReady: async (_generation: string, ready: boolean) => { readiness.push(ready); },
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

  it('does not let stale startup completion or disposal withdraw a newer lifecycle generation', async () => {
    const events = new FakeDesktopEvents();
    let releaseOldReady!: () => void;
    const oldReadyBlocked = new Promise<void>((resolve) => { releaseOldReady = resolve; });
    let readyCalls = 0;
    let newestGeneration = -1;
    let nativeReady = false;
    const setLifecycleReady = async (...args: unknown[]) => {
      const generation = args.length === 2
        ? Number.parseInt(String(args[0]).slice('lifecycle:v1:'.length), 16)
        : 0;
      const ready = Boolean(args.at(-1));
      readyCalls += 1;
      if (ready && readyCalls === 1) await oldReadyBlocked;
      if (generation < newestGeneration) return;
      if (ready) newestGeneration = generation;
      nativeReady = ready;
    };
    const ports = () => ({
      events,
      state: fixedState('clean'),
      confirm: { confirmClose: () => 'cancel' as const },
      save: { saveBeforeClose: () => 'cancelled' as const },
      window: { setLifecycleReady, resolveClose: async () => undefined },
    });
    const oldController = new DesktopLifecycleController(ports());
    const newController = new DesktopLifecycleController(ports());

    const oldStart = oldController.start();
    await Promise.resolve();
    const current = await newController.start();
    expect(nativeReady).toBe(true);
    releaseOldReady();
    const stale = await oldStart;
    stale.dispose();
    await stale.completion;

    expect(nativeReady).toBe(true);
    current.dispose();
  });

  it('withdraws its exact generation when readiness startup reports failure', async () => {
    const events = new FakeDesktopEvents();
    const readiness: Array<readonly [string, boolean]> = [];
    let calls = 0;
    const controller = new DesktopLifecycleController({
      events,
      state: fixedState('clean'),
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: {
        setLifecycleReady: async (generation, ready) => {
          readiness.push([generation, ready]);
          calls += 1;
          if (calls === 1) throw new Error('readiness response lost');
        },
        resolveClose: async () => undefined,
      },
    });

    await expect(controller.start()).rejects.toThrow('readiness response lost');

    expect(readiness).toEqual([
      [controller.lifecycleGeneration, true],
      [controller.lifecycleGeneration, false],
    ]);
    expect(events.listenerCount('uxml://close-requested')).toBe(0);
  });

  it('retains a startup listener when readiness withdrawal also fails and exposes retry', async () => {
    const events = new FakeDesktopEvents();
    let calls = 0;
    const controller = new DesktopLifecycleController({
      events,
      state: fixedState('clean'),
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: {
        setLifecycleReady: async () => {
          calls += 1;
          if (calls <= 2) throw new Error(calls === 1 ? 'ready response lost' : 'withdrawal failed');
        },
        resolveClose: async () => undefined,
      },
    });

    const failure = await controller.start().then(
      () => undefined,
      (error: unknown) => error as { retry?: () => Promise<unknown> },
    );

    expect(failure?.retry).toBeTypeOf('function');
    expect(events.listenerCount('uxml://close-requested')).toBe(1);
    await expect(failure?.retry?.()).resolves.toMatchObject({ status: 'disposed' });
    expect(events.listenerCount('uxml://close-requested')).toBe(0);
  });

  it('holds one validated native lease through dirty evaluation and resolves it atomically', async () => {
    const lease = `close:v1:${'a'.repeat(16)}`;
    const events = new FakeDesktopEvents();
    const observations: Array<readonly [string, string]> = [];
    const controller = new DesktopLifecycleController({
      events,
      state: {
        runExclusive: async (observed, operation) => {
          observations.push([observed, 'acquire']);
          await operation(stateLease(1, 'clean'));
          observations.push(['1', 'release']);
        },
        finalValidate: (observed) => {
          observations.push([String(observed.generation), 'validate']);
          return true;
        },
      },
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: { setLifecycleReady: async () => undefined, resolveClose: async (observedLease, _generation, resolution) => {
        observations.push([observedLease, resolution]);
      } },
    });
    await controller.start();

    await events.emit('uxml://close-requested', closeRequest(controller, lease));

    expect(observations).toEqual([
      [lease, 'acquire'],
      ['1', 'validate'],
      [lease, 'close'],
      ['1', 'release'],
    ]);
  });

  it('keeps native close resolution inside the owner exclusive edit scope', async () => {
    const events = new FakeDesktopEvents();
    let exclusive = false;
    let validated = false;
    let nativeStarted!: () => void;
    const nativePending = new Promise<void>((resolve) => { nativeStarted = resolve; });
    let releaseNative!: () => void;
    const nativeResolution = new Promise<void>((resolve) => { releaseNative = resolve; });
    const state = {
      finalValidate: () => { validated = true; return true; },
      runExclusive: async (
        _lease: string,
        operation: (lease: DocumentStateLease) => Promise<void>,
      ) => {
        exclusive = true;
        try {
          await operation(stateLease(7, 'clean'));
        } finally {
          exclusive = false;
        }
      },
    };
    const controller = new DesktopLifecycleController({
      events,
      state,
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: {
        setLifecycleReady: async () => undefined,
        resolveClose: async () => {
          nativeStarted();
          await nativeResolution;
        },
      },
    });
    await controller.start();

    const close = events.emit('uxml://close-requested', closeRequest(controller));
    await nativePending;
    const editWasAccepted = !exclusive;

    expect(validated).toBe(true);
    expect(editWasAccepted).toBe(false);
    releaseNative();
    await close;
    expect(exclusive).toBe(false);
  });

  it('reports failed native resolution and abandons the exact lease for a later close', async () => {
    const events = new FakeDesktopEvents();
    const errors: unknown[] = [];
    const abandoned: string[] = [];
    const controller = new DesktopLifecycleController({
      events,
      state: fixedState('clean'),
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: {
        setLifecycleReady: async () => undefined,
        resolveClose: async () => { throw new Error('resolution transport failed'); },
        abandonClose: async (lease: string) => { abandoned.push(lease); },
      },
      errors: { report: (error: unknown) => { errors.push(error); } },
    } as ConstructorParameters<typeof DesktopLifecycleController>[0]);
    await controller.start();

    await events.emit('uxml://close-requested', closeRequest(controller));

    expect(errors).toHaveLength(1);
    expect(abandoned).toEqual([CLOSE_LEASE]);
  });

  it('retries the exact redelivered lease after both resolution transports fail', async () => {
    const events = new FakeDesktopEvents();
    const errors: unknown[] = [];
    let resolveAttempts = 0;
    let abandonAttempts = 0;
    const controller = new DesktopLifecycleController({
      events,
      state: fixedState('clean'),
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: {
        setLifecycleReady: async () => undefined,
        resolveClose: async () => {
          resolveAttempts += 1;
          if (resolveAttempts === 1) throw new Error('resolution transport failed');
        },
        abandonClose: async () => {
          abandonAttempts += 1;
          throw new Error('abandon transport failed');
        },
      },
      errors: { report: (error) => { errors.push(error); } },
    });
    await controller.start();
    const request = closeRequest(controller);

    await events.emit('uxml://close-requested', request);
    await events.emit('uxml://close-requested', request);

    expect(resolveAttempts).toBe(2);
    expect(abandonAttempts).toBe(1);
    expect(errors).toHaveLength(2);
  });

  it('keeps close delivery live after withdrawal failure and exposes an exact retry', async () => {
    const events = new FakeDesktopEvents();
    const errors: unknown[] = [];
    let withdrawalAttempts = 0;
    const controller = new DesktopLifecycleController({
      events,
      state: fixedState('clean'),
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: {
        setLifecycleReady: async (_generation, ready) => {
          if (!ready) {
            withdrawalAttempts += 1;
            if (withdrawalAttempts === 1) throw new Error('withdrawal transport failed');
          }
        },
        resolveClose: async () => undefined,
      },
      errors: { report: (error) => { errors.push(error); } },
    });
    const disposable = await controller.start() as Awaited<ReturnType<typeof controller.start>> & {
      retry(): Promise<Readonly<{ status: 'disposed' | 'failed' }>>;
    };

    disposable.dispose();
    await expect(disposable.completion).resolves.toMatchObject({ status: 'failed' });
    expect(events.listenerCount('uxml://close-requested')).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { retry?: unknown }).retry).toBeTypeOf('function');

    await expect((errors[0] as { retry(): Promise<unknown> }).retry()).resolves.toMatchObject({ status: 'disposed' });
    expect(events.listenerCount('uxml://close-requested')).toBe(0);
    expect(withdrawalAttempts).toBe(2);
  });

  it('keeps a failed old withdrawal inert beside a newer generation and retries without withdrawing it', async () => {
    const events = new FakeDesktopEvents();
    const errors: unknown[] = [];
    const resolutions: string[] = [];
    let currentGeneration = '';
    let oldGeneration = '';
    let failOldWithdrawal = true;
    const ports = () => ({
      events,
      state: fixedState('clean'),
      confirm: { confirmClose: () => 'cancel' as const },
      save: { saveBeforeClose: () => 'cancelled' as const },
      window: {
        setLifecycleReady: async (generation: string, ready: boolean) => {
          if (ready) currentGeneration = generation;
          else if (generation === oldGeneration && failOldWithdrawal) {
            failOldWithdrawal = false;
            throw new Error('old withdrawal response lost');
          } else if (generation === currentGeneration) {
            currentGeneration = '';
          }
        },
        resolveClose: async (_lease: string, generation: string) => { resolutions.push(generation); },
      },
      errors: { report: (error: unknown) => { errors.push(error); } },
    });
    const oldController = new DesktopLifecycleController(ports());
    oldGeneration = oldController.lifecycleGeneration;
    const oldDisposable = await oldController.start();
    const currentController = new DesktopLifecycleController(ports());
    const currentDisposable = await currentController.start();

    oldDisposable.dispose();
    await expect(oldDisposable.completion).resolves.toMatchObject({ status: 'failed' });
    expect(currentGeneration).toBe(currentController.lifecycleGeneration);

    await events.emit('uxml://close-requested', closeRequest(currentController));
    expect(resolutions).toEqual([currentController.lifecycleGeneration]);
    expect(events.listenerCount('uxml://close-requested')).toBe(2);
    expect(errors).toHaveLength(1);
    await (errors[0] as { retry(): Promise<unknown> }).retry();
    expect(currentGeneration).toBe(currentController.lifecycleGeneration);
    expect(events.listenerCount('uxml://close-requested')).toBe(1);
    currentDisposable.dispose();
  });

  it('lets an error sink request withdrawal retry immediately without reusing the failed attempt', async () => {
    const events = new FakeDesktopEvents();
    let attempts = 0;
    let immediateRetry: Promise<unknown> | undefined;
    const controller = new DesktopLifecycleController({
      events,
      state: fixedState('clean'),
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: {
        setLifecycleReady: async (_generation, ready) => {
          if (!ready) {
            attempts += 1;
            if (attempts === 1) throw new Error('withdrawal failed');
          }
        },
        resolveClose: async () => undefined,
      },
      errors: {
        report: (error) => {
          immediateRetry = (error as { retry(): Promise<unknown> }).retry();
        },
      },
    });
    const disposable = await controller.start();

    disposable.dispose();
    for (let attempt = 0; attempt < 4 && immediateRetry === undefined; attempt += 1) {
      await Promise.resolve();
    }
    await expect(immediateRetry).resolves.toMatchObject({ status: 'disposed' });

    expect(attempts).toBe(2);
    expect(events.listenerCount('uxml://close-requested')).toBe(0);
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

    await events.emit('uxml://close-requested', closeRequest(controller, lease));

    expect(resolutions).toEqual([[lease, controller.lifecycleGeneration, 'cancel']]);
  });
  it('closes clean windows without prompting or saving', async () => {
    const fixture = createFixture({ dirty: 'clean' });
    const disposable = await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', closeRequest(fixture.controller));

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

    await fixture.events.emit('uxml://close-requested', closeRequest(fixture.controller));

    expect(fixture.confirmCalls).toBe(1);
    expect(fixture.saveCalls).toBe(expectedSaves);
    expect(fixture.closeCalls).toBe(expectedCloses);
  });

  it('prevents close when Task 16 has not bound dirty ownership for an open session', async () => {
    const fixture = createFixture({ dirty: 'unknown' });
    await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', closeRequest(fixture.controller));

    expect(fixture.confirmCalls).toBe(0);
    expect(fixture.saveCalls).toBe(0);
    expect(fixture.closeCalls).toBe(0);
  });

  it('rechecks dirty state after save and refuses a close raced by another edit', async () => {
    const dirtyStates: DirtyState[] = ['dirty', 'dirty'];
    const fixture = createFixture({ dirty: () => dirtyStates.shift() ?? 'dirty', choice: 'save', save: 'saved' });
    await fixture.controller.start();

    await fixture.events.emit('uxml://close-requested', closeRequest(fixture.controller));

    expect(fixture.saveCalls).toBe(1);
    expect(fixture.closeCalls).toBe(0);
  });

  it('cancels when an edit is admitted before the exclusive close snapshot', async () => {
    let edited = false;
    const events = new FakeDesktopEvents();
    const resolutions: string[] = [];
    const controller = new DesktopLifecycleController({
      events,
      state: {
        runExclusive: async (_nativeLease, operation) => {
          queueMicrotask(() => { edited = true; });
          await Promise.resolve();
          await operation(stateLease(0, 'clean'));
        },
        finalValidate: () => !edited,
      },
      confirm: { confirmClose: () => 'cancel' },
      save: { saveBeforeClose: () => 'cancelled' },
      window: { setLifecycleReady: async () => undefined, resolveClose: async (_lease, _generation, resolution) => { resolutions.push(resolution); } },
    });
    await controller.start();

    await events.emit('uxml://close-requested', closeRequest(controller));

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
        runExclusive: async (_nativeLease, operation) => operation(stateLease(0, 'dirty')),
        finalValidate: () => !edited,
      },
      confirm: { confirmClose: () => {
        queueMicrotask(() => { edited = true; });
        return 'discard';
      } },
      save: { saveBeforeClose: () => 'cancelled' },
      window: { setLifecycleReady: async () => undefined, resolveClose: async (_lease, _generation, resolution) => { resolutions.push(resolution); } },
    });
    await controller.start();

    await events.emit('uxml://close-requested', closeRequest(controller));

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
        runExclusive: async (_nativeLease, operation) => operation(stateLease(0, dirty)),
        finalValidate: () => !edited,
      },
      confirm: { confirmClose: () => 'save' },
      save: { saveBeforeClose: () => {
        dirty = 'clean';
        queueMicrotask(() => { dirty = 'dirty'; edited = true; });
        return 'saved';
      } },
      window: { setLifecycleReady: async () => undefined, resolveClose: async (_lease, _generation, resolution) => { resolutions.push(resolution); } },
    });
    await controller.start();

    await events.emit('uxml://close-requested', closeRequest(controller));

    expect(dirty).toBe('dirty');
    expect(resolutions).toEqual(['cancel']);
  });

  it('coalesces reentrant native close requests and never opens duplicate confirmation dialogs', async () => {
    let resolveChoice: ((choice: CloseChoice) => void) | undefined;
    const choice = new Promise<CloseChoice>((resolve) => { resolveChoice = resolve; });
    const fixture = createFixture({ dirty: 'dirty', choice: () => choice });
    await fixture.controller.start();

    const first = fixture.events.emit('uxml://close-requested', closeRequest(fixture.controller));
    const second = fixture.events.emit('uxml://close-requested', closeRequest(fixture.controller));
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

    await fixture.events.emit('uxml://close-requested', closeRequest(fixture.controller));
    expect(fixture.closeCalls).toBe(0);
    await fixture.events.emit('uxml://close-requested', closeRequest(fixture.controller));
    expect(fixture.closeCalls).toBe(1);

    disposable.dispose();
    disposable.dispose();
    await fixture.events.emit('uxml://close-requested', closeRequest(fixture.controller));
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
      runExclusive: async (_nativeLease, operation) => operation(stateLease(
          generation,
          await (typeof options.dirty === 'function'
            ? options.dirty()
            : savedClean && options.dirty === 'dirty' ? 'clean' : options.dirty),
        )),
      finalValidate: async (lease) => {
        if (lease.generation !== generation) return false;
        if (!savedClean) return true;
        if (typeof options.dirty !== 'function') return true;
        return await options.dirty() === 'clean';
      },
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
    window: { setLifecycleReady: async () => undefined, resolveClose: async (_lease, _generation, resolution) => {
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
    runExclusive: async (_nativeLease: string, operation: (lease: DocumentStateLease) => void | Promise<void>) => {
      await operation(stateLease(0, dirtyState));
    },
    finalValidate: () => true,
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

const CLOSE_LEASE = `close:v1:${'c'.repeat(16)}`;

function closeRequest(controller: DesktopLifecycleController, lease = CLOSE_LEASE) {
  return Object.freeze({
    lease,
    lifecycleGeneration: controller.lifecycleGeneration,
  });
}
