import { describe, expect, it } from 'vitest';
import { createTauriRuntimeBindings, type RawTauriRuntimePorts } from './TauriRuntime';

const TEST_COMMAND_AUTHORITY = Object.freeze({});

describe('createTauriRuntimeBindings', () => {
  it('preserves one explicit command authority across separate binding wrappers', () => {
    const commandAuthority = Object.freeze({ transport: 'tauri' });
    const raw = {
      commandAuthority,
      invoke: async () => null,
      listen: async () => () => undefined,
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    } as RawTauriRuntimePorts & { readonly commandAuthority: object };

    const first = createTauriRuntimeBindings(raw);
    const second = createTauriRuntimeBindings(raw);

    expect((first.desktop as unknown as { commandAuthority: object }).commandAuthority)
      .toBe(commandAuthority);
    expect((second.desktop as unknown as { commandAuthority: object }).commandAuthority)
      .toBe(commandAuthority);
  });

  it('resolves an exact close lease and publishes exact native file-command availability', async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    const runtime = createTauriRuntimeBindings({
      commandAuthority: TEST_COMMAND_AUTHORITY,
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
    const lifecycleGeneration = `lifecycle:v1:${'1'.repeat(16)}`;

    await (runtime.desktop.window as unknown as {
      resolveClose(lease: string, generation: string, action: string): Promise<void>;
      setLifecycleReady(generation: string, ready: boolean): Promise<void>;
    }).resolveClose(lease, lifecycleGeneration, 'close');
    await (runtime.desktop.window as unknown as {
      setLifecycleReady(generation: string, ready: boolean): Promise<void>;
    }).setLifecycleReady(lifecycleGeneration, true);
    await (runtime.desktop as unknown as {
      menu: { setFileWorkflowEnabled(generation: string, availability: typeof FILE_AVAILABILITY): Promise<void> };
    }).menu.setFileWorkflowEnabled(`workflow:v1:${'1'.repeat(16)}`, FILE_AVAILABILITY);

    expect(calls).toEqual([
      { command: 'desktop_resolve_close', payload: { request: { lease, lifecycleGeneration, action: 'close' } } },
      { command: 'desktop_set_lifecycle_ready', payload: { request: { lifecycleGeneration, ready: true } } },
      {
        command: 'desktop_set_file_workflow_enabled',
        payload: {
          request: {
            workflowGeneration: `workflow:v1:${'1'.repeat(16)}`,
            availability: FILE_AVAILABILITY,
          },
        },
      },
    ]);
  });
  it('shares injected invoke/listen/timers with TauriHost and resolves close through native authority', async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    const raw: RawTauriRuntimePorts = {
      commandAuthority: TEST_COMMAND_AUTHORITY,
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
    const lifecycleGeneration = `lifecycle:v1:${'2'.repeat(16)}`;
    await runtime.desktop.window.resolveClose(lease, lifecycleGeneration, 'close');

    expect(calls).toEqual([
      { command: 'host_choose_project', payload: undefined },
      { command: 'desktop_confirm_close', payload: undefined },
      { command: 'desktop_resolve_close', payload: { request: { lease, lifecycleGeneration, action: 'close' } } },
    ]);
  });

  it.each([null, 'yes', {}, 'SAVE'])('rejects malformed close decisions from untrusted IPC: %j', async (decision) => {
    const runtime = createTauriRuntimeBindings({
      commandAuthority: TEST_COMMAND_AUTHORITY,
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
      commandAuthority: TEST_COMMAND_AUTHORITY,
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
      `lifecycle:v1:${'3'.repeat(16)}`,
      'close',
    )).rejects.toThrow('returned unexpected data');
  });

  it('uses no separable authorization or revocation command when native close resolution fails', async () => {
    const commands: string[] = [];
    const runtime = createTauriRuntimeBindings({
      commandAuthority: TEST_COMMAND_AUTHORITY,
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
      `lifecycle:v1:${'4'.repeat(16)}`,
      'close',
    )).rejects.toThrow('native close failed');
    expect(commands).toEqual(['desktop_resolve_close']);
  });

  it('rejects malformed lifecycle and workflow generations before native invocation', async () => {
    const commands: string[] = [];
    const runtime = createTauriRuntimeBindings({
      commandAuthority: TEST_COMMAND_AUTHORITY,
      invoke: async (command) => { commands.push(command); return null; },
      listen: async () => () => undefined,
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });

    await expect(runtime.desktop.window.setLifecycleReady('lifecycle:v1:SHORT', true))
      .rejects.toThrow('lifecycle generation is malformed');
    await expect((runtime.desktop.menu as unknown as {
      setFileWorkflowEnabled(generation: string, availability: typeof FILE_AVAILABILITY): Promise<void>;
    }).setFileWorkflowEnabled('workflow:v1:SHORT', FILE_AVAILABILITY))
      .rejects.toThrow('workflow generation is malformed');
    expect(commands).toEqual([]);
  });

  it.each([
    {},
    { ...FILE_AVAILABILITY, 'file.save-all': 'yes' },
    { ...FILE_AVAILABILITY, 'file.save-as': true },
    { 'file.open-project': true, 'file.save': false, 'file.save-all': false },
  ])('rejects malformed native file availability before invocation: %j', async (availability) => {
    const commands: string[] = [];
    const runtime = createTauriRuntimeBindings({
      commandAuthority: TEST_COMMAND_AUTHORITY,
      invoke: async (command) => { commands.push(command); return null; },
      listen: async () => () => undefined,
      timers: {
        now: () => 0,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
      },
    });

    await expect((runtime.desktop.menu as unknown as {
      setFileWorkflowEnabled(generation: string, availability: unknown): Promise<void>;
    }).setFileWorkflowEnabled(`workflow:v1:${'1'.repeat(16)}`, availability))
      .rejects.toThrow('availability is malformed');
    expect(commands).toEqual([]);
  });
});

const FILE_AVAILABILITY = Object.freeze({
  'file.open-project': true,
  'file.save': false,
  'file.save-all': false,
  'file.close-project': false,
});
