import { describe, expect, it } from 'vitest';
import { BrowserHost, type BrowserDirectoryHandle, type BrowserProjectIdentityStore } from './BrowserHost';
import { projectId, projectPath, type ProjectPath } from './HostPort';
import { MemoryHost } from './MemoryHost';

describe('BrowserHost', () => {
  it('imports without browser globals and exposes an explicit demo-memory fallback', async () => {
    const fallback = new MemoryHost({
      projects: [{ id: 'demo', name: 'Demo Project', files: { 'Assets/Main.uxml': '<UXML />\r\n' } }],
    });
    const host = new BrowserHost({ scope: {}, fallback });

    expect(host.capabilities).toEqual({
      mode: 'demo-memory',
      projectSelection: 'demo',
      atomicReplace: 'guaranteed',
      watch: 'deterministic',
      appData: 'memory',
      dialogs: 'deterministic',
    });
    const root = (await host.chooseProject())!;
    expect(await host.readText(projectPath(root, 'Assets/Main.uxml'))).toMatchObject({
      text: '<UXML />\r\n',
    });
  });

  it('uses granted File System Access handles for exact scoped compare-before-replace writes', async () => {
    const directory = new FakeDirectoryHandle('Chosen Project', {
      Assets: new FakeDirectoryHandle('Assets', {
        'Main.uxml': new FakeFileHandle('Main.uxml', '<UXML>\r\n</UXML>\r\n'),
      }),
    });
    let pickerOptions: { readonly mode?: string } | undefined;
    const host = new BrowserHost({
      scope: { showDirectoryPicker: async (options) => { pickerOptions = options; return directory; } },
      identityStore: new FakeProjectIdentityStore(),
    });

    expect(host.capabilities).toMatchObject({
      mode: 'browser-file-system',
      atomicReplace: 'best-effort-safe-write',
      watch: 'unsupported',
    });
    const root = (await host.chooseProject())!;
    expect(pickerOptions).toEqual({ mode: 'readwrite' });
    expect(directory.permissionRequests).toEqual([{ operation: 'query', mode: 'readwrite' }]);
    const path = projectPath(root, 'Assets/Main.uxml');
    const original = await host.readText(path);
    expect(original.text).toBe('<UXML>\r\n</UXML>\r\n');

    const revision = await host.replaceTextAtomically(path, original.revision, '<UXML />\n');
    expect((await host.readText(path))).toMatchObject({ text: '<UXML />\n', revision });

    directory.file('Assets/Main.uxml').replaceExternally('<UXML><Button /></UXML>');
    await expect(host.replaceTextAtomically(path, revision, 'stale')).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(host.watch(root, () => undefined)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('owns browser picker cancellation and read/write permission denial outcomes', async () => {
    const cancelled = new BrowserHost({
      scope: { showDirectoryPicker: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } },
      identityStore: new FakeProjectIdentityStore(),
    });
    await expect(cancelled.chooseProject()).resolves.toBeNull();

    const deniedDirectory = new FakeDirectoryHandle('Denied', {}, 'denied');
    const denied = new BrowserHost({
      scope: { showDirectoryPicker: async () => deniedDirectory },
      identityStore: new FakeProjectIdentityStore(),
    });
    await expect(denied.chooseProject()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(deniedDirectory.permissionRequests).toEqual([
      { operation: 'query', mode: 'readwrite' },
      { operation: 'request', mode: 'readwrite' },
    ]);

    const promptedDirectory = new FakeDirectoryHandle('Prompted', {}, 'prompt');
    promptedDirectory.requestResult = 'granted';
    const prompted = new BrowserHost({
      scope: { showDirectoryPicker: async () => promptedDirectory },
      identityStore: new FakeProjectIdentityStore(),
    });
    await expect(prompted.chooseProject()).resolves.toMatchObject({ name: 'Prompted' });
    expect(promptedDirectory.permissionRequests).toEqual([
      { operation: 'query', mode: 'readwrite' },
      { operation: 'request', mode: 'readwrite' },
    ]);
  });

  it('keeps persisted project identities stable and distinct across browser host instances', async () => {
    const firstDirectory = new FakeDirectoryHandle('Project', {
      'Main.uxml': new FakeFileHandle('Main.uxml', '<UXML />'),
    });
    const secondDirectory = new FakeDirectoryHandle('Project', {
      'Main.uxml': new FakeFileHandle('Main.uxml', '<UXML />'),
    });
    const identityStore = new FakeProjectIdentityStore();
    const storage = new FakeStorage();
    const firstHost = new BrowserHost({
      scope: { showDirectoryPicker: async () => firstDirectory, localStorage: storage },
      identityStore,
    } as ConstructorParameters<typeof BrowserHost>[0]);
    const firstRoot = (await firstHost.chooseProject())!;
    await firstHost.writeRecovery(firstRoot.id, 'first-project-journal');

    const secondHost = new BrowserHost({
      scope: { showDirectoryPicker: async () => secondDirectory, localStorage: storage },
      identityStore,
    } as ConstructorParameters<typeof BrowserHost>[0]);
    const secondRoot = (await secondHost.chooseProject())!;
    expect(secondRoot.id).not.toBe(firstRoot.id);
    expect(await secondHost.readRecovery(secondRoot.id)).toBeNull();

    const reopenedHost = new BrowserHost({
      scope: { showDirectoryPicker: async () => firstDirectory, localStorage: storage },
      identityStore,
    } as ConstructorParameters<typeof BrowserHost>[0]);
    const reopenedRoot = (await reopenedHost.chooseProject())!;
    expect(reopenedRoot.id).toBe(firstRoot.id);
    expect(await reopenedHost.readRecovery(reopenedRoot.id)).toBe('first-project-journal');
  });

  it('rejects forged paths for roots that were never granted', async () => {
    const directory = new FakeDirectoryHandle('Chosen Project', {
      'Main.uxml': new FakeFileHandle('Main.uxml', '<UXML />'),
    });
    const host = new BrowserHost({
      scope: { showDirectoryPicker: async () => directory },
      identityStore: new FakeProjectIdentityStore(),
    });
    await host.chooseProject();
    const forged = Object.freeze({
      projectId: projectId('ungranted'),
      relativePath: 'Main.uxml',
    }) as ProjectPath;

    await expect(host.readText(forged)).rejects.toMatchObject({ code: 'root-not-granted' });
  });

  it('uses browser-local app data and dialogs when those capabilities are available', async () => {
    const directory = new FakeDirectoryHandle('Chosen Project', {
      'Main.uxml': new FakeFileHandle('Main.uxml', '<UXML />'),
    });
    const storage = new FakeStorage();
    const confirmations: string[] = [];
    const messages: string[] = [];
    const host = new BrowserHost({
      scope: {
        showDirectoryPicker: async () => directory,
        localStorage: storage,
        confirm: (message) => { confirmations.push(message); return true; },
        alert: (message) => { messages.push(message); },
        now: () => 42,
      },
      identityStore: new FakeProjectIdentityStore(),
    });
    const root = (await host.chooseProject())!;

    await host.writeRecovery(root.id, '{"version":1}');
    expect(await host.readRecovery(root.id)).toBe('{"version":1}');
    await host.clearRecovery(root.id);
    expect(await host.readRecovery(root.id)).toBeNull();

    await host.rememberRecentProject(root);
    expect(await host.listRecentProjects()).toEqual([{ root, lastOpenedAt: 42 }]);
    expect(await host.confirm({
      kind: 'overwrite',
      title: 'External change',
      message: 'Overwrite?',
      confirmLabel: 'Overwrite',
      cancelLabel: 'Cancel',
    })).toEqual({ confirmed: true });
    await host.showMessage({ kind: 'error', title: 'Save failed', message: 'Disk full' });
    expect(confirmations).toEqual(['External change\n\nOverwrite?']);
    expect(messages).toEqual(['Save failed\n\nDisk full']);
    expect(storage.keys().every((key) => key.startsWith('uxml-editor:v1:'))).toBe(true);
  });
});

class FakeFileHandle {
  readonly kind = 'file';

  constructor(readonly name: string, private contents: string) {}

  async getFile() {
    const snapshot = this.contents;
    return Object.freeze({ text: async () => snapshot });
  }

  async createWritable() {
    let staged = this.contents;
    return {
      write: async (text: string) => { staged = text; },
      close: async () => { this.contents = staged; },
      abort: async () => undefined,
    };
  }

  replaceExternally(text: string): void {
    this.contents = text;
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory';
  readonly permissionRequests: Array<{ readonly operation: 'query' | 'request'; readonly mode: string }> = [];
  requestResult: PermissionState;

  constructor(
    readonly name: string,
    private readonly entries: Record<string, FakeDirectoryHandle | FakeFileHandle>,
    private readonly queryResult: PermissionState = 'granted',
  ) {
    this.requestResult = queryResult;
  }

  async queryPermission(options: { readonly mode: string }) {
    this.permissionRequests.push({ operation: 'query', mode: options.mode });
    return this.queryResult;
  }

  async requestPermission(options: { readonly mode: string }) {
    this.permissionRequests.push({ operation: 'request', mode: options.mode });
    return this.requestResult;
  }

  async getDirectoryHandle(name: string) {
    const entry = this.entries[name];
    if (!(entry instanceof FakeDirectoryHandle)) throw notFound();
    return entry;
  }

  async getFileHandle(name: string) {
    const entry = this.entries[name];
    if (!(entry instanceof FakeFileHandle)) throw notFound();
    return entry;
  }

  file(path: string): FakeFileHandle {
    const parts = path.split('/');
    let directory: FakeDirectoryHandle = this;
    for (const part of parts.slice(0, -1)) {
      const next = directory.entries[part];
      if (!(next instanceof FakeDirectoryHandle)) throw notFound();
      directory = next;
    }
    const file = directory.entries[parts.at(-1)!];
    if (!(file instanceof FakeFileHandle)) throw notFound();
    return file;
  }
}

function notFound(): Error {
  return Object.assign(new Error('Not found'), { name: 'NotFoundError' });
}

class FakeStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  keys(): string[] { return [...this.values.keys()]; }
}

class FakeProjectIdentityStore implements BrowserProjectIdentityStore {
  private readonly ids = new Map<BrowserDirectoryHandle, ReturnType<typeof projectId>>();
  private nextId = 1;

  async identify(handle: BrowserDirectoryHandle) {
    const existing = this.ids.get(handle);
    if (existing !== undefined) return existing;
    const id = projectId(`persisted-browser-root:${this.nextId++}`);
    this.ids.set(handle, id);
    return id;
  }
}
