import type { AppDesktopPorts } from './App';
import { TauriHost, type TauriEvent, type TauriTimerPorts } from '../core/host/TauriHost';

export interface RawTauriRuntimePorts {
  readonly invoke: (command: string, payload?: unknown) => Promise<unknown>;
  readonly listen: (
    eventName: string,
    listener: (event: TauriEvent<unknown>) => void | Promise<void>,
  ) => Promise<() => void>;
  readonly window: { close(): void | Promise<void> };
  readonly timers: TauriTimerPorts;
}

export interface TauriRuntimeBindings {
  readonly host: TauriHost;
  readonly hostPorts: RawTauriRuntimePorts;
  readonly desktop: AppDesktopPorts;
}

export function createTauriRuntimeBindings(raw: RawTauriRuntimePorts): TauriRuntimeBindings {
  return Object.freeze({
    host: new TauriHost(raw),
    hostPorts: raw,
    desktop: Object.freeze({
      events: Object.freeze({ listen: raw.listen }),
      confirm: Object.freeze({
        confirmClose: async () => {
          const result = await raw.invoke('desktop_confirm_close');
          if (result !== 'save' && result !== 'discard' && result !== 'cancel') {
            throw new Error('Native host returned a malformed close decision.');
          }
          return result;
        },
      }),
      window: Object.freeze({
        close: async () => {
          const authorized = await raw.invoke('desktop_authorize_close');
          if (authorized !== null && authorized !== undefined) {
            throw new Error('Native host returned an unexpected authorization result.');
          }
          try {
            await raw.window.close();
          } catch (error) {
            await raw.invoke('desktop_revoke_close_authorization').catch(() => undefined);
            throw error;
          }
        },
      }),
    }),
  });
}
