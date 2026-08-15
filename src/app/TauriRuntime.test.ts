import { describe, expect, it } from 'vitest';
import { createTauriRuntimeBindings, type RawTauriRuntimePorts } from './TauriRuntime';

describe('createTauriRuntimeBindings', () => {
  it('resolves an exact close lease with one native command and exposes file-workflow menu enablement', async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    const runtime = createTauriRuntimeBindings({
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        return null;
      },
      listen: async () => () => undefined,
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });
    const lease = `close:v1:${'a'.repeat(16)}`;

    await (runtime.desktop.window as unknown as {
      resolveClose(lease: string, action: string): Promise<void>;
      setLifecycleReady(ready: boolean): Promise<void>;
    }).resolveClose(lease, 'close');
    await (runtime.desktop.window as unknown as {
      setLifecycleReady(ready: boolean): Promise<void>;
    }).setLifecycleReady(true);
    await (runtime.desktop as unknown as {
      menu: { setFileWorkflowEnabled(enabled: boolean): Promise<void> };
    }).menu.setFileWorkflowEnabled(true);

    expect(calls).toEqual([
      { command: 'desktop_resolve_close', payload: { request: { lease, action: 'close' } } },
      { command: 'desktop_set_lifecycle_ready', payload: { request: { ready: true } } },
      { command: 'desktop_set_file_workflow_enabled', payload: { request: { enabled: true } } },
    ]);
  });
  it('shares injected invoke/listen/timers with TauriHost and resolves close through native authority', async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    const raw: RawTauriRuntimePorts = {
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'desktop_confirm_close') return 'discard';
        if (command === 'desktop_resolve_close') return null;
        if (command === 'host_choose_project') return null;
        throw new Error(`Unexpected command: ${command}`);
      },
      listen: async () => () => undefined,
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
    const lease = `close:v1:${'b'.repeat(16)}`;
    await runtime.desktop.window.resolveClose(lease, 'close');

    expect(calls).toEqual([
      { command: 'host_choose_project', payload: undefined },
      { command: 'desktop_confirm_close', payload: undefined },
      { command: 'desktop_resolve_close', payload: { request: { lease, action: 'close' } } },
    ]);
  });

  it.each([null, 'yes', {}, 'SAVE'])('rejects malformed close decisions from untrusted IPC: %j', async (decision) => {
    const runtime = createTauriRuntimeBindings({
      invoke: async () => decision,
      listen: async () => () => undefined,
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });

    await expect(runtime.desktop.confirm.confirmClose()).rejects.toThrow('malformed close decision');
  });

  it('rejects an unexpected native close resolution result', async () => {
    const runtime = createTauriRuntimeBindings({
      invoke: async () => ({ authorized: true }),
      listen: async () => () => undefined,
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });

    await expect(runtime.desktop.window.resolveClose(
      `close:v1:${'c'.repeat(16)}`,
      'close',
    )).rejects.toThrow('returned unexpected data');
  });

  it('uses no separable authorization or revocation command when native close resolution fails', async () => {
    const commands: string[] = [];
    const runtime = createTauriRuntimeBindings({
      invoke: async (command) => {
        commands.push(command);
        throw new Error('native close failed');
      },
      listen: async () => () => undefined,
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });

    await expect(runtime.desktop.window.resolveClose(
      `close:v1:${'d'.repeat(16)}`,
      'close',
    )).rejects.toThrow('native close failed');
    expect(commands).toEqual(['desktop_resolve_close']);
  });
});
