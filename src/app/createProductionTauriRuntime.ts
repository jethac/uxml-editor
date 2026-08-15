import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createTauriRuntimeBindings, type TauriRuntimeBindings } from './TauriRuntime';

const productionCommandAuthority = Object.freeze({});

export function createProductionTauriRuntime(): TauriRuntimeBindings | undefined {
  if (!Object.prototype.hasOwnProperty.call(globalThis, '__TAURI_INTERNALS__')) return undefined;
  return createTauriRuntimeBindings({
    commandAuthority: productionCommandAuthority,
    invoke: (command, payload) => invoke(command, payload as Record<string, unknown> | undefined),
    listen: (eventName, listener) => listen(eventName, (event) => listener(Object.freeze({ payload: event.payload }))),
    reportError: (error) => console.error('Desktop bridge startup failed.', error),
    timers: Object.freeze({
      now: () => Date.now(),
      setTimeout: (callback: () => void | Promise<void>, delayMs: number) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    }),
  });
}
