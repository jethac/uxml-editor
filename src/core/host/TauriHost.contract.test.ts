import { describe, expect, it } from 'vitest';
import {
  HostError,
  fileRevision,
  projectId,
  projectPath,
  type FileChangeEvent,
  type HostPort,
  type ProjectRoot,
} from './HostPort';
import { MemoryHost } from './MemoryHost';
import { TauriHost, type TauriEvent, type TauriHostPorts } from './TauriHost';

interface HostContractHarness {
  readonly host: HostPort;
  readonly expectedProjectName: string;
  externalWrite(relativePath: string, text: string): Promise<void>;
  externalDelete(relativePath: string): Promise<void>;
  failNextReplace(): void;
  advanceTime(milliseconds: number): Promise<void>;
  queueConfirmation(confirmed: boolean): void;
}

describeHostContract('MemoryHost', () => {
  const host = new MemoryHost({
    initialTime: 1_000,
    projects: [{
      id: 'project-a',
      name: 'Chosen Project',
      files: {
        'Assets/Zeta.uss': '.zeta {}\n',
        'Assets/UI/Main.uxml': '<UXML label="日本語">\r\n</UXML>\r\n',
        'Assets/Alpha.uss': '.alpha {}\n',
      },
    }],
  });
  let root: ProjectRoot;
  return {
    host,
    expectedProjectName: 'Chosen Project',
    externalWrite: async (path, text) => {
      root ??= (await host.chooseProject())!;
      await host.externalWrite(projectPath(root, path), text);
    },
    externalDelete: async (path) => {
      root ??= (await host.chooseProject())!;
      await host.externalDelete(projectPath(root, path));
    },
    failNextReplace: () => host.injectFailure({ operation: 'replace', phase: 'during' }),
    advanceTime: (milliseconds) => host.advanceTime(milliseconds),
    queueConfirmation: (confirmed) => host.queueConfirmation(confirmed),
  };
});

describeHostContract('TauriHost(fake bridge)', () => {
  const timers = new FakeTimers(1_000);
  const bridge = new FakeTauriBridge(() => timers.now());
  return {
    host: new TauriHost({ ...bridge.ports, timers }),
    expectedProjectName: 'Chosen Project',
    externalWrite: (path, text) => bridge.externalWrite(path, text),
    externalDelete: (path) => bridge.externalDelete(path),
    failNextReplace: () => { bridge.replaceFailure = true; },
    advanceTime: (milliseconds) => timers.advance(milliseconds),
    queueConfirmation: (confirmed) => bridge.confirmations.push(confirmed),
  };
});

function describeHostContract(name: string, createHarness: () => HostContractHarness): void {
  describe(name, () => {
    it('preserves exact CRLF and Unicode text and returns immutable snapshots', async () => {
      const { host, expectedProjectName } = createHarness();
      const root = await host.chooseProject();

      expect(root).toEqual({ id: 'project-a', name: expectedProjectName });
      expect(Object.isFrozen(root)).toBe(true);
      const read = await host.readText(projectPath(root!, 'Assets/UI/./Main.uxml'));
      expect(read.text).toBe('<UXML label="日本語">\r\n</UXML>\r\n');
      expect(read.path).toEqual({ projectId: 'project-a', relativePath: 'Assets/UI/Main.uxml' });
      expect(read.revision).toMatch(/^[a-z0-9-]+:v1:/);
      expect(Object.isFrozen(read)).toBe(true);
      expect(Object.isFrozen(read.path)).toBe(true);
    });

    it('enumerates one grant deterministically and rejects foreign roots and unsafe paths', async () => {
      const { host } = createHarness();
      const root = (await host.chooseProject())!;

      const enumeration = await host.enumerateFiles(root);
      expect(enumeration).toEqual({
        status: 'supported',
        files: [
          { projectId: 'project-a', relativePath: 'Assets/Alpha.uss' },
          { projectId: 'project-a', relativePath: 'Assets/UI/Main.uxml' },
          { projectId: 'project-a', relativePath: 'Assets/Zeta.uss' },
        ],
      });
      expect(Object.isFrozen(enumeration)).toBe(true);
      if (enumeration.status === 'supported') {
        expect(Object.isFrozen(enumeration.files)).toBe(true);
        expect(enumeration.files.every(Object.isFrozen)).toBe(true);
      }
      await expect(host.enumerateFiles({ id: projectId('other'), name: 'Other' }))
        .rejects.toMatchObject({ code: 'root-not-granted' });
      expect(() => projectPath(root, '../outside.uxml')).toThrow(expect.objectContaining({ code: 'invalid-path' }));
      expect(() => projectPath(root, 'C:\\outside.uxml')).toThrow(expect.objectContaining({ code: 'invalid-path' }));
      expect(() => projectPath(root, 'file:///outside.uxml')).toThrow(expect.objectContaining({ code: 'invalid-path' }));
    });

    it('compares content revisions and leaves the original intact on replacement failure', async () => {
      const harness = createHarness();
      const root = (await harness.host.chooseProject())!;
      const path = projectPath(root, 'Assets/UI/Main.uxml');
      const original = await harness.host.readText(path);

      const revision = await harness.host.replaceTextAtomically(path, original.revision, '<UXML />\n');
      expect(revision).not.toBe(original.revision);
      await expect(harness.host.replaceTextAtomically(path, original.revision, 'stale'))
        .rejects.toMatchObject({ code: 'stale-revision' });
      expect((await harness.host.readText(path)).text).toBe('<UXML />\n');

      const beforeFailure = await harness.host.readText(path);
      harness.failNextReplace();
      await expect(harness.host.replaceTextAtomically(path, beforeFailure.revision, 'must-not-commit'))
        .rejects.toMatchObject({ code: 'replace-failed' });
      expect(await harness.host.readText(path)).toEqual(beforeFailure);
    });

    it('delivers revision-aware project events until disposal and isolates project ids', async () => {
      const harness = createHarness();
      const root = (await harness.host.chooseProject())!;
      const events: FileChangeEvent[] = [];
      const watch = await harness.host.watch(root, async (event) => { events.push(event); });

      await harness.externalWrite('Assets/UI/Main.uxml', '<UXML changed="true" />');
      await harness.externalDelete('Assets/Zeta.uss');
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: 'changed',
        path: { projectId: 'project-a', relativePath: 'Assets/UI/Main.uxml' },
      });
      expect(events[1]).toEqual({
        kind: 'deleted',
        path: { projectId: 'project-a', relativePath: 'Assets/Zeta.uss' },
      });
      expect(events.every((event) => Object.isFrozen(event) && Object.isFrozen(event.path))).toBe(true);

      watch.dispose();
      await harness.externalWrite('Assets/UI/Main.uxml', '<UXML after="dispose" />');
      expect(events).toHaveLength(2);
    });

    it('stores exact recovery data and newest-first deduplicated recent snapshots', async () => {
      const harness = createHarness();
      const root = (await harness.host.chooseProject())!;
      const journal = '{"version":1,"text":"日本語\\r\\n"}\r\n';

      await harness.host.writeRecovery(root.id, journal);
      expect(await harness.host.readRecovery(root.id)).toBe(journal);
      await harness.host.clearRecovery(root.id);
      expect(await harness.host.readRecovery(root.id)).toBeNull();

      await harness.host.rememberRecentProject(root);
      await harness.advanceTime(5);
      const second = Object.freeze({ id: projectId('project-b'), name: 'Second' });
      if (harness.host instanceof MemoryHost) {
        // MemoryHost intentionally requires grants for file operations, not recent metadata.
      }
      await harness.host.rememberRecentProject(second);
      await harness.advanceTime(5);
      await harness.host.rememberRecentProject(root);
      const recent = await harness.host.listRecentProjects();
      expect(recent).toEqual([
        { root: { id: 'project-a', name: 'Chosen Project' }, lastOpenedAt: 1_010 },
        { root: { id: 'project-b', name: 'Second' }, lastOpenedAt: 1_005 },
      ]);
      expect(Object.isFrozen(recent)).toBe(true);
      expect(recent.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.root))).toBe(true);
    });

    it('snapshots dialogs and schedules cancellable callbacks against the injected clock', async () => {
      const harness = createHarness();
      const request = {
        kind: 'overwrite' as const,
        title: 'External change',
        message: 'Overwrite exact disk bytes?',
        confirmLabel: 'Overwrite',
        cancelLabel: 'Cancel',
      };
      harness.queueConfirmation(true);
      const confirmation = harness.host.confirm(request);
      request.message = 'mutated';
      expect(await confirmation).toEqual({ confirmed: true });
      await harness.host.showMessage({ kind: 'error', title: 'Save failed', message: 'Disk full' });

      const calls: string[] = [];
      const cancelled = harness.host.schedule(10, () => { calls.push('cancelled'); });
      harness.host.schedule(20, () => { calls.push(`late:${harness.host.now()}`); });
      harness.host.schedule(10, () => { calls.push(`early:${harness.host.now()}`); });
      cancelled.dispose();
      await harness.advanceTime(10);
      expect(calls).toEqual(['early:1010']);
      await harness.advanceTime(10);
      expect(calls).toEqual(['early:1010', 'late:1020']);
    });
  });
}

describe('TauriHost IPC validation and serialization', () => {
  it('publishes frozen native capabilities without claiming browser or memory behavior', () => {
    const host = new TauriHost({
      invoke: async () => null,
      listen: async () => () => undefined,
      timers: new FakeTimers(0),
    });

    expect(host.capabilities).toEqual({
      mode: 'tauri',
      projectSelection: 'directory-picker',
      atomicReplace: 'guaranteed',
      watch: 'native-revision-aware',
      appData: 'app-data',
      dialogs: 'native',
    });
    expect(Object.isFrozen(host.capabilities)).toBe(true);
  });

  it.each([
    {},
    { projectId: '', displayName: 'Chosen' },
    { projectId: 'project-a', displayName: '' },
    { projectId: 'project-a', displayName: 'Chosen', absolutePath: 'C:\\secret' },
  ])('rejects an untrusted choose_project result before branding it: %j', async (result) => {
    const host = new TauriHost({
      invoke: async () => result,
      listen: async () => () => undefined,
      timers: new FakeTimers(0),
    });

    await expect(host.chooseProject()).rejects.toMatchObject({ code: 'selection-failed' });
  });

  it('maps an explicit native picker cancellation to the HostPort null result', async () => {
    const host = new TauriHost({
      invoke: async () => null,
      listen: async () => () => undefined,
      timers: new FakeTimers(0),
    });

    await expect(host.chooseProject()).resolves.toBeNull();
  });

  it('uses explicit project-id/relative-path payloads and maps structured native errors', async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    const host = new TauriHost({
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'host_choose_project') return { projectId: 'project-a', displayName: 'Chosen Project' };
        if (command === 'host_read_text') throw { code: 'not-found', message: 'missing fixture' };
        throw new Error(`Unexpected command: ${command}`);
      },
      listen: async () => () => undefined,
      timers: new FakeTimers(0),
    });
    const root = (await host.chooseProject())!;

    await expect(host.readText(projectPath(root, 'Assets/Main.uxml'))).rejects.toEqual(expect.objectContaining({
      name: 'HostError',
      code: 'not-found',
      message: 'missing fixture',
    }));
    expect(calls).toEqual([
      { command: 'host_choose_project', payload: undefined },
      {
        command: 'host_read_text',
        payload: { request: { projectId: 'project-a', relativePath: 'Assets/Main.uxml' } },
      },
    ]);
  });

  it('rejects malformed enumeration, read, recent, dialog, and watch event results', async () => {
    const bridge = new FakeTauriBridge(() => 0);
    const host = new TauriHost({ ...bridge.ports, timers: new FakeTimers(0) });
    const root = (await host.chooseProject())!;

    bridge.overrides.set('host_enumerate_files', { relativePaths: ['A.uss', 'a.uss'] });
    await expect(host.enumerateFiles(root)).rejects.toMatchObject({ code: 'read-failed' });
    bridge.overrides.set('host_read_text', { text: 7, revision: 'sha256:v1:bad' });
    await expect(host.readText(projectPath(root, 'Assets/UI/Main.uxml'))).rejects.toMatchObject({ code: 'read-failed' });
    bridge.overrides.set('host_list_recent_projects', [{ projectId: 'x', displayName: 'X', lastOpenedAt: Number.NaN }]);
    await expect(host.listRecentProjects()).rejects.toMatchObject({ code: 'app-data-failed' });
    bridge.overrides.set('host_confirm', { confirmed: 'yes' });
    await expect(host.confirm({
      kind: 'overwrite', title: 'Title', message: 'Message', confirmLabel: 'Yes', cancelLabel: 'No',
    })).rejects.toMatchObject({ code: 'dialog-failed' });

    const events: FileChangeEvent[] = [];
    const watch = await host.watch(root, (event) => { events.push(event); });
    await bridge.emit('uxml://file-change', {
      watchId: 'watch-1', projectId: 'other', kind: 'changed', relativePath: 'A.uss', revision: 'sha256:v1:1',
    });
    await bridge.emit('uxml://file-change', {
      watchId: 'watch-1', projectId: 'project-a', kind: 'changed', relativePath: '../escape', revision: 'sha256:v1:1',
    });
    expect(events).toEqual([]);
    watch.dispose();
  });

  it('rejects an oversized recent-project result from untrusted IPC', async () => {
    const bridge = new FakeTauriBridge(() => 0);
    bridge.overrides.set(
      'host_list_recent_projects',
      Array.from({ length: 11 }, (_, index) => ({
        projectId: `project-${index}`,
        displayName: `Project ${index}`,
        lastOpenedAt: 11 - index,
      })),
    );
    const host = new TauriHost({ ...bridge.ports, timers: new FakeTimers(0) });

    await expect(host.listRecentProjects()).rejects.toMatchObject({ code: 'app-data-failed' });
  });

  it('serializes watch delivery and drops queued events when the watch is disposed', async () => {
    const bridge = new FakeTauriBridge(() => 0);
    const host = new TauriHost({ ...bridge.ports, timers: new FakeTimers(0) });
    const root = (await host.chooseProject())!;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const delivered: FileChangeEvent[] = [];
    let activeListeners = 0;
    let maximumActiveListeners = 0;
    const watch = await host.watch(root, async (event) => {
      activeListeners += 1;
      maximumActiveListeners = Math.max(maximumActiveListeners, activeListeners);
      delivered.push(event);
      if (delivered.length === 1) {
        markFirstStarted!();
        await firstBlocked;
      }
      activeListeners -= 1;
    });

    const firstWrite = bridge.externalWrite('Assets/UI/Main.uxml', '<UXML first="true" />');
    await firstStarted;
    const secondWrite = bridge.externalWrite('Assets/UI/Main.uxml', '<UXML second="true" />');
    await Promise.resolve();
    watch.dispose();
    releaseFirst!();
    await Promise.all([firstWrite, secondWrite]);

    expect(maximumActiveListeners).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it('delivers a native change emitted before the start-watch response resolves', async () => {
    let nativeListener: ((event: TauriEvent<unknown>) => void | Promise<void>) | undefined;
    const host = new TauriHost({
      invoke: async (command) => {
        if (command === 'host_choose_project') {
          return { projectId: 'project-a', displayName: 'Chosen Project' };
        }
        if (command === 'host_start_watch') {
          await nativeListener!({
            payload: {
              watchId: 'watch-1',
              projectId: 'project-a',
              kind: 'changed',
              relativePath: 'Assets/UI/Main.uxml',
              revision: `sha256:v1:${'a'.repeat(64)}`,
            },
          });
          return { watchId: 'watch-1' };
        }
        if (command === 'host_stop_watch') return null;
        throw new Error(`Unexpected command: ${command}`);
      },
      listen: async (_event, listener) => {
        nativeListener = listener;
        return () => { nativeListener = undefined; };
      },
      timers: new FakeTimers(0),
    });
    const root = (await host.chooseProject())!;
    const events: FileChangeEvent[] = [];

    const watch = await host.watch(root, (event) => { events.push(event); });

    expect(events).toEqual([{
      kind: 'changed',
      path: { projectId: 'project-a', relativePath: 'Assets/UI/Main.uxml' },
      revision: `sha256:v1:${'a'.repeat(64)}`,
    }]);
    watch.dispose();
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an unsafe recent-project timestamp from untrusted IPC: %s',
    async (lastOpenedAt) => {
      const bridge = new FakeTauriBridge(() => 0);
      bridge.overrides.set('host_list_recent_projects', [{
        projectId: 'project-a', displayName: 'Project', lastOpenedAt,
      }]);
      const host = new TauriHost({ ...bridge.ports, timers: new FakeTimers(0) });

      await expect(host.listRecentProjects()).rejects.toMatchObject({ code: 'app-data-failed' });
    },
  );
});

class FakeTimers {
  private currentTime: number;
  private nextId = 1;
  private readonly tasks = new Map<number, { due: number; callback: () => void | Promise<void> }>();

  constructor(initialTime: number) {
    this.currentTime = initialTime;
  }

  now = (): number => this.currentTime;

  setTimeout = (callback: () => void | Promise<void>, delayMs: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { due: this.currentTime + delayMs, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') this.tasks.delete(handle);
  };

  async advance(milliseconds: number): Promise<void> {
    const target = this.currentTime + milliseconds;
    for (;;) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.currentTime = next[1].due;
      await next[1].callback();
    }
    this.currentTime = target;
  }
}

class FakeTauriBridge {
  readonly confirmations: boolean[] = [];
  readonly overrides = new Map<string, unknown>();
  replaceFailure = false;
  private readonly files = new Map([
    ['Assets/Zeta.uss', '.zeta {}\n'],
    ['Assets/UI/Main.uxml', '<UXML label="日本語">\r\n</UXML>\r\n'],
    ['Assets/Alpha.uss', '.alpha {}\n'],
  ]);
  private readonly revisions = new Map<string, string>();
  private readonly recovery = new Map<string, string>();
  private readonly recents = new Map<string, { projectId: string; displayName: string; lastOpenedAt: number; sequence: number }>();
  private readonly eventListeners = new Map<string, Set<(event: TauriEvent<unknown>) => void | Promise<void>>>();
  private sequence = 0;
  private revisionSequence = 0;
  private readonly readNow: () => number;

  constructor(readNow: () => number) {
    this.readNow = readNow;
    for (const path of this.files.keys()) this.revisions.set(path, this.nextRevision());
  }

  readonly ports: Pick<TauriHostPorts, 'invoke' | 'listen'> = {
    invoke: async (command, payload) => this.invoke(command, payload),
    listen: async (event, listener) => {
      const listeners = this.eventListeners.get(event) ?? new Set();
      listeners.add(listener);
      this.eventListeners.set(event, listeners);
      return () => { listeners.delete(listener); };
    },
  };

  async externalWrite(path: string, text: string): Promise<void> {
    this.files.set(path, text);
    const revision = this.nextRevision();
    this.revisions.set(path, revision);
    await this.emit('uxml://file-change', {
      watchId: 'watch-1', projectId: 'project-a', kind: 'changed', relativePath: path, revision,
    });
  }

  async externalDelete(path: string): Promise<void> {
    this.files.delete(path);
    this.revisions.delete(path);
    await this.emit('uxml://file-change', {
      watchId: 'watch-1', projectId: 'project-a', kind: 'deleted', relativePath: path,
    });
  }

  async emit(eventName: string, payload: unknown): Promise<void> {
    for (const listener of [...(this.eventListeners.get(eventName) ?? [])]) {
      await listener(Object.freeze({ payload }));
    }
  }

  private async invoke(command: string, payload: unknown): Promise<unknown> {
    if (this.overrides.has(command)) return this.overrides.get(command);
    const request = readRequest(payload);
    switch (command) {
      case 'host_choose_project':
        return { projectId: 'project-a', displayName: 'Chosen Project' };
      case 'host_enumerate_files':
        this.requireProject(request.projectId);
        return { relativePaths: [...this.files.keys()].sort() };
      case 'host_read_text': {
        this.requireProject(request.projectId);
        const text = this.files.get(request.relativePath);
        if (text === undefined) throw nativeError('not-found', 'File does not exist.');
        return { text, revision: this.revisions.get(request.relativePath) };
      }
      case 'host_replace_text': {
        this.requireProject(request.projectId);
        const current = this.revisions.get(request.relativePath);
        if (current === undefined) throw nativeError('not-found', 'File does not exist.');
        if (current !== request.expectedRevision) throw nativeError('stale-revision', 'File changed before replacement.');
        if (this.replaceFailure) {
          this.replaceFailure = false;
          throw nativeError('replace-failed', 'Injected replacement failure.');
        }
        this.files.set(request.relativePath, request.text);
        const revision = this.nextRevision();
        this.revisions.set(request.relativePath, revision);
        return { revision };
      }
      case 'host_start_watch':
        this.requireProject(request.projectId);
        return { watchId: 'watch-1' };
      case 'host_stop_watch':
        return null;
      case 'host_read_recovery':
        this.requireProject(request.projectId);
        return { journal: this.recovery.get(request.projectId) ?? null };
      case 'host_write_recovery':
        this.requireProject(request.projectId);
        this.recovery.set(request.projectId, request.journal);
        return null;
      case 'host_clear_recovery':
        this.requireProject(request.projectId);
        this.recovery.delete(request.projectId);
        return null;
      case 'host_list_recent_projects':
        return [...this.recents.values()]
          .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt || right.sequence - left.sequence)
          .map(({ sequence: _sequence, ...entry }) => entry);
      case 'host_remember_recent_project':
        this.recents.set(request.projectId, {
          projectId: request.projectId,
          displayName: request.displayName,
          lastOpenedAt: this.readNow(),
          sequence: ++this.sequence,
        });
        return null;
      case 'host_confirm':
        return { confirmed: this.confirmations.shift() ?? false };
      case 'host_show_message':
        return null;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  }

  private requireProject(id: unknown): void {
    if (id !== 'project-a') throw nativeError('root-not-granted', 'Project is not granted.');
  }

  private nextRevision(): string {
    return `sha256:v1:${(++this.revisionSequence).toString(16).padStart(64, '0')}`;
  }
}

function readRequest(payload: unknown): Record<string, any> {
  if (typeof payload !== 'object' || payload === null || !('request' in payload)) return {};
  const request = (payload as { request: unknown }).request;
  return typeof request === 'object' && request !== null ? request as Record<string, any> : {};
}

function nativeError(code: HostError['code'], message: string): HostError {
  return new HostError(code, message);
}
