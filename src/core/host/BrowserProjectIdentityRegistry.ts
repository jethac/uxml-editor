import { HostError, projectId, type ProjectId } from './HostPort';
import type { BrowserDirectoryHandle } from './BrowserHost';

export interface BrowserProjectIdentityStore {
  identify(handle: BrowserDirectoryHandle): Promise<ProjectId>;
}

export interface BrowserIdentityScope {
  readonly indexedDB?: IDBFactory;
  readonly crypto?: Pick<Crypto, 'randomUUID'>;
}

interface StoredBrowserProjectIdentity {
  readonly id: string;
  readonly handle: BrowserDirectoryHandle;
}

const IDENTITY_DB = 'uxml-editor-host-v1';
const IDENTITY_STORE = 'project-identities';

export class IndexedDbBrowserProjectIdentityStore implements BrowserProjectIdentityStore {
  constructor(
    private readonly factory: IDBFactory,
    private readonly createId: () => string,
  ) {}

  async identify(handle: BrowserDirectoryHandle): Promise<ProjectId> {
    if (typeof handle.isSameEntry !== 'function') {
      throw new HostError('identity-failed', 'The browser cannot compare persisted directory handles.');
    }
    const database = await openIdentityDatabase(this.factory);
    try {
      const records = await readIdentityRecords(database);
      for (const record of records) {
        if (await handle.isSameEntry(record.handle)) return projectId(record.id);
      }
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const id = projectId(`browser-root:v1:${this.createId()}`);
        try {
          await addIdentityRecord(database, Object.freeze({ id, handle }));
          return id;
        } catch (error) {
          if (!isNamedError(error, 'ConstraintError')) throw error;
        }
      }
      throw new HostError('identity-failed', 'The browser could not allocate a unique project identity.');
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('identity-failed', 'The browser project identity registry failed.', error);
    } finally {
      database.close();
    }
  }
}

export function createDefaultBrowserProjectIdentityStore(
  scope: BrowserIdentityScope,
): BrowserProjectIdentityStore | undefined {
  try {
    const factory = scope.indexedDB;
    const randomUUID = scope.crypto?.randomUUID;
    if (factory === undefined || typeof factory.open !== 'function' || typeof randomUUID !== 'function') return undefined;
    return new IndexedDbBrowserProjectIdentityStore(factory, () => randomUUID.call(scope.crypto));
  } catch {
    return undefined;
  }
}

function openIdentityDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(IDENTITY_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(IDENTITY_STORE)) {
        database.createObjectStore(IDENTITY_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB open failed.')); };
    request.onblocked = () => { reject(new Error('IndexedDB upgrade was blocked.')); };
  });
}

async function readIdentityRecords(database: IDBDatabase): Promise<readonly StoredBrowserProjectIdentity[]> {
  const transaction = database.transaction(IDENTITY_STORE, 'readonly');
  const completion = transactionComplete(transaction);
  const request = transaction.objectStore(IDENTITY_STORE).getAll();
  const value = await requestValue(request);
  await completion;
  if (!Array.isArray(value)) throw new TypeError('Browser project identity registry is invalid.');
  return Object.freeze(value.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) throw new TypeError('Browser project identity is invalid.');
    const record = candidate as Partial<StoredBrowserProjectIdentity>;
    if (typeof record.id !== 'string' || record.id.length === 0 || !isDirectoryHandle(record.handle)) {
      throw new TypeError('Browser project identity is invalid.');
    }
    return Object.freeze({ id: record.id, handle: record.handle });
  }));
}

async function addIdentityRecord(database: IDBDatabase, record: StoredBrowserProjectIdentity): Promise<void> {
  const transaction = database.transaction(IDENTITY_STORE, 'readwrite');
  const completion = transactionComplete(transaction);
  transaction.objectStore(IDENTITY_STORE).add(record);
  await completion;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB request failed.')); };
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => { resolve(); };
    transaction.onerror = () => { reject(transaction.error ?? new Error('IndexedDB transaction failed.')); };
    transaction.onabort = () => { reject(transaction.error ?? new Error('IndexedDB transaction was aborted.')); };
  });
}

function isDirectoryHandle(candidate: unknown): candidate is BrowserDirectoryHandle {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const handle = candidate as BrowserDirectoryHandle;
  return handle.kind === 'directory' && typeof handle.name === 'string'
    && typeof handle.getDirectoryHandle === 'function' && typeof handle.getFileHandle === 'function';
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name;
}
