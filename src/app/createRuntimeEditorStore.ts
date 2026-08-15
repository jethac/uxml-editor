import { BrowserHost, type BrowserHostOptions } from '../core/host/BrowserHost';
import { TauriHost, type TauriHostPorts } from '../core/host/TauriHost';
import { EditorStore } from '../core/store/EditorStore';
import { createBrowserLayoutStorage, type EditorLayoutStorage } from '../core/store/EditorLayoutStorage';
import type { EditorViewport } from '../core/store/EditorLayoutStorage';

export interface RuntimeEditorStoreOptions {
  readonly scope?: Record<string, unknown>;
  readonly browserHostOptions?: BrowserHostOptions;
  readonly tauriPorts?: TauriHostPorts;
  readonly storage?: EditorLayoutStorage | null;
  readonly viewport?: EditorViewport;
}

export function createRuntimeEditorStore(options: RuntimeEditorStoreOptions = {}): EditorStore {
  const scope = options.scope ?? globalThis as unknown as Record<string, unknown>;
  const tauri = Object.prototype.hasOwnProperty.call(scope, '__TAURI_INTERNALS__');
  const host = tauri
    ? createTauriHost(options.tauriPorts)
    : new BrowserHost(options.browserHostOptions);
  const storage = options.storage === undefined ? createBrowserLayoutStorage() : options.storage;
  const viewport = options.viewport ?? readRuntimeViewport(scope);
  return new EditorStore({ host, storage, viewport });
}

function createTauriHost(ports: TauriHostPorts | undefined): TauriHost {
  if (ports === undefined) throw new Error('Tauri runtime bindings are unavailable.');
  return new TauriHost(ports);
}

function readRuntimeViewport(scope: Record<string, unknown>): EditorViewport | undefined {
  const width = scope.innerWidth;
  const height = scope.innerHeight;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0
    || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined;
  return Object.freeze({ width: Math.max(1, width), height: Math.max(1, height) });
}
