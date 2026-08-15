import { describe, expect, it } from 'vitest';
import { BrowserHost } from '../core/host/BrowserHost';
import { MemoryHost } from '../core/host/MemoryHost';
import { TauriHost } from '../core/host/TauriHost';
import { createRuntimeEditorStore } from './createRuntimeEditorStore';

describe('createRuntimeEditorStore', () => {
  it('keeps browser startup on the existing BrowserHost path', () => {
    const fallback = new MemoryHost({
      projects: [{ id: 'demo', name: 'Demo', files: { 'Main.uxml': '<UXML />' } }],
    });

    const store = createRuntimeEditorStore({
      scope: {},
      browserHostOptions: { scope: {}, fallback },
      storage: null,
      viewport: { width: 800, height: 600 },
    });

    expect(store.getSnapshot().host).toBeInstanceOf(BrowserHost);
    expect(store.getSnapshot().host).not.toBe(fallback);
  });

  it('initializes the store from the current runtime viewport when no override is provided', () => {
    const store = createRuntimeEditorStore({
      scope: { innerWidth: 720, innerHeight: 768 },
      browserHostOptions: { scope: {}, fallback: new MemoryHost() },
      storage: null,
    });

    expect(store.getSnapshot().viewport).toEqual({ width: 720, height: 768 });
  });

  it('makes TauriHost reachable from real runtime detection with injected native ports', () => {
    const store = createRuntimeEditorStore({
      scope: { __TAURI_INTERNALS__: Object.freeze({}) },
      tauriPorts: {
        invoke: async () => null,
        listen: async () => () => undefined,
        timers: {
          now: () => 42,
          setTimeout: () => 1,
          clearTimeout: () => undefined,
        },
      },
      storage: null,
      viewport: { width: 800, height: 600 },
    });

    expect(store.getSnapshot().host).toBeInstanceOf(TauriHost);
    expect(store.getSnapshot().host?.now()).toBe(42);
  });

  it('reuses the exact TauriHost created by runtime bootstrap', () => {
    const host = new TauriHost({
      invoke: async () => null,
      listen: async () => () => undefined,
      timers: { now: () => 42, setTimeout: () => 1, clearTimeout: () => undefined },
    });
    const store = createRuntimeEditorStore({
      scope: { __TAURI_INTERNALS__: Object.freeze({}) },
      tauriHost: host,
      storage: null,
      viewport: { width: 800, height: 600 },
    } as never);

    expect(store.getSnapshot().host).toBe(host);
  });

  it('fails closed when Tauri is detected without native bindings', () => {
    expect(() => createRuntimeEditorStore({
      scope: { __TAURI_INTERNALS__: Object.freeze({}) },
      storage: null,
      viewport: { width: 800, height: 600 },
    })).toThrow('Tauri runtime bindings are unavailable');
  });
});
