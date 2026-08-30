import { describe, expect, it } from 'vitest';
import type { BrowserDirectoryHandle } from './BrowserHost';
import {
  createDefaultBrowserProjectIdentityStore,
  type BrowserIdentityLockManager,
} from './BrowserProjectIdentityRegistry';

describe('BrowserProjectIdentityRegistry', () => {
  it('does not advertise durable identity without cross-context locking', () => {
    const store = createDefaultBrowserProjectIdentityStore({
      indexedDB: { open: () => { throw new Error('not called'); } } as unknown as IDBFactory,
      crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    });

    expect(store).toBeUndefined();
  });

  it('allocates one stable identity when real registry instances select the same directory concurrently', async () => {
    const indexedDB = new DeterministicIndexedDbFactory();
    const locks = new DeterministicBrowserLocks();
    const handle = directoryHandle('Shared Project');
    const first = createDefaultBrowserProjectIdentityStore({
      indexedDB: indexedDB as unknown as IDBFactory,
      crypto: { randomUUID: () => uuid(1) },
      navigator: { locks },
    })!;
    const second = createDefaultBrowserProjectIdentityStore({
      indexedDB: indexedDB as unknown as IDBFactory,
      crypto: { randomUUID: () => uuid(2) },
      navigator: { locks },
    })!;

    const [firstId, secondId] = await Promise.all([first.identify(handle), second.identify(handle)]);

    expect(firstId).toBe('browser-root:v1:00000000-0000-4000-8000-000000000001');
    expect(secondId).toBe(firstId);
    expect(indexedDB.recordCount).toBe(1);
    expect(Object.isFrozen(locks.lastOptions)).toBe(true);
  });
});

class DeterministicBrowserLocks implements BrowserIdentityLockManager {
  private readonly tails = new Map<string, Promise<void>>();
  lastOptions: { readonly mode: 'exclusive' } | undefined;

  request<T>(name: string, options: { readonly mode: 'exclusive' }, callback: () => Promise<T> | T): Promise<T> {
    this.lastOptions = options;
    const previous = this.tails.get(name) ?? Promise.resolve();
    const result = previous.then(callback);
    this.tails.set(name, result.then(() => undefined, () => undefined));
    return result;
  }
}

class DeterministicIndexedDbFactory {
  private readonly records: Array<{ readonly id: string; readonly handle: BrowserDirectoryHandle }> = [];
  private upgraded = false;

  get recordCount(): number { return this.records.length; }

  open(): IDBOpenDBRequest {
    const request = eventTargetRequest<IDBDatabase>() as IDBOpenDBRequest;
    const database = {
      objectStoreNames: { contains: () => this.upgraded },
      createObjectStore: () => { this.upgraded = true; },
      transaction: (_name: string, mode: IDBTransactionMode) => new DeterministicTransaction(this.records, mode),
      close: () => undefined,
    } as unknown as IDBDatabase;
    queueMicrotask(() => {
      setRequestResult(request, database);
      if (!this.upgraded) request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
}

class DeterministicTransaction {
  error: DOMException | null = null;
  oncomplete: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onabort: ((event: Event) => unknown) | null = null;

  constructor(
    private readonly records: Array<{ readonly id: string; readonly handle: BrowserDirectoryHandle }>,
    private readonly mode: IDBTransactionMode,
  ) {}

  objectStore() {
    return {
      getAll: () => {
        const request = eventTargetRequest<readonly unknown[]>();
        const snapshot = [...this.records];
        queueMicrotask(() => {
          setRequestResult(request, snapshot);
          request.onsuccess?.(new Event('success'));
          queueMicrotask(() => { this.oncomplete?.(new Event('complete')); });
        });
        return request;
      },
      add: (record: { readonly id: string; readonly handle: BrowserDirectoryHandle }) => {
        if (this.mode !== 'readwrite') throw new Error('Read-only identity transaction.');
        const request = eventTargetRequest<IDBValidKey>();
        queueMicrotask(() => {
          this.records.push(Object.freeze({ id: record.id, handle: record.handle }));
          setRequestResult(request, record.id);
          request.onsuccess?.(new Event('success'));
          this.oncomplete?.(new Event('complete'));
        });
        return request;
      },
    };
  }
}

function eventTargetRequest<T>(): IDBRequest<T> {
  return {
    result: undefined as T,
    error: null,
    source: null,
    transaction: null,
    readyState: 'pending',
    onsuccess: null,
    onerror: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  } as unknown as IDBRequest<T>;
}

function setRequestResult<T>(request: IDBRequest<T>, result: T): void {
  Object.defineProperty(request, 'result', { configurable: true, value: result });
  Object.defineProperty(request, 'readyState', { configurable: true, value: 'done' });
}

function directoryHandle(name: string): BrowserDirectoryHandle {
  const handle: BrowserDirectoryHandle = {
    kind: 'directory',
    name,
    getDirectoryHandle: async () => { throw new Error('unused'); },
    getFileHandle: async () => { throw new Error('unused'); },
    isSameEntry: async (other) => other === handle,
  };
  return Object.freeze(handle);
}

function uuid(index: number): ReturnType<Crypto['randomUUID']> {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}` as ReturnType<Crypto['randomUUID']>;
}
