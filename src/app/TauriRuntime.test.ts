import { describe, expect, it } from 'vitest';
import { createTauriRuntimeBindings, type RawTauriRuntimePorts } from './TauriRuntime';

describe('createTauriRuntimeBindings', () => {
  it('shares injected invoke/listen/timers with TauriHost and authorizes native close before window close', async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    let windowCloses = 0;
    const raw: RawTauriRuntimePorts = {
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'desktop_confirm_close') return 'discard';
        if (command === 'desktop_authorize_close') return null;
        if (command === 'host_choose_project') return null;
        throw new Error(`Unexpected command: ${command}`);
      },
      listen: async () => () => undefined,
      window: { close: async () => { windowCloses += 1; } },
      timers: {
        now: () => 42,
        setTimeout: () => 7,
        clearTimeout: () => undefined,
      },
    };
    const runtime = createTauriRuntimeBindings(raw);

    expect(runtime.host.now()).toBe(42);
    await expect(runtime.host.chooseProject()).resolves.toBeNull();
    await expect(runtime.desktop.confirm.confirmClose()).resolves.toBe('discard');
    await runtime.desktop.window.close();

    expect(windowCloses).toBe(1);
    expect(calls).toEqual([
      { command: 'host_choose_project', payload: undefined },
      { command: 'desktop_confirm_close', payload: undefined },
      { command: 'desktop_authorize_close', payload: undefined },
    ]);
  });

  it.each([null, 'yes', {}, 'SAVE'])('rejects malformed close decisions from untrusted IPC: %j', async (decision) => {
    const runtime = createTauriRuntimeBindings({
      invoke: async () => decision,
      listen: async () => () => undefined,
      window: { close: async () => undefined },
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });

    await expect(runtime.desktop.confirm.confirmClose()).rejects.toThrow('malformed close decision');
  });

  it('does not close the window when native authorization fails or returns unexpected data', async () => {
    let windowCloses = 0;
    const runtime = createTauriRuntimeBindings({
      invoke: async () => ({ authorized: true }),
      listen: async () => () => undefined,
      window: { close: async () => { windowCloses += 1; } },
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });

    await expect(runtime.desktop.window.close()).rejects.toThrow('unexpected authorization result');
    expect(windowCloses).toBe(0);
  });

  it('revokes one-shot native authorization when the window close call fails', async () => {
    const commands: string[] = [];
    const runtime = createTauriRuntimeBindings({
      invoke: async (command) => {
        commands.push(command);
        return null;
      },
      listen: async () => () => undefined,
      window: { close: async () => { throw new Error('native close failed'); } },
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });

    await expect(runtime.desktop.window.close()).rejects.toThrow('native close failed');
    expect(commands).toEqual(['desktop_authorize_close', 'desktop_revoke_close_authorization']);
  });
});
