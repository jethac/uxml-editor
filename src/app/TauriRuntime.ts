import type { AppDesktopPorts } from './App';
import { TauriHost, type TauriEvent, type TauriTimerPorts } from '../core/host/TauriHost';

export interface RawTauriRuntimePorts {
  readonly invoke: (command: string, payload?: unknown) => Promise<unknown>;
  readonly listen: (
    eventName: string,
    listener: (event: TauriEvent<unknown>) => void | Promise<void>,
  ) => Promise<() => void>;
  readonly reportError?: (error: unknown) => void;
  readonly timers: TauriTimerPorts;
}

export interface TauriRuntimeBindings {
  readonly host: TauriHost;
  readonly desktop: AppDesktopPorts;
}

export function createTauriRuntimeBindings(raw: RawTauriRuntimePorts): TauriRuntimeBindings {
  return Object.freeze({
    host: new TauriHost(raw),
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
        setLifecycleReady: (ready: boolean) => invokeVoid(
          raw,
          'desktop_set_lifecycle_ready',
          { request: { ready } },
        ),
        resolveClose: async (lease: string, action: 'close' | 'cancel') => {
          if (!/^close:v1:[0-9a-f]{16}$/.test(lease)
            || (action !== 'close' && action !== 'cancel')) {
            throw new Error('Desktop close resolution is malformed.');
          }
          await invokeVoid(raw, 'desktop_resolve_close', { request: { lease, action } });
        },
      }),
      menu: Object.freeze({
        setFileWorkflowEnabled: (enabled: boolean) => invokeVoid(
          raw,
          'desktop_set_file_workflow_enabled',
          { request: { enabled } },
        ),
      }),
      errors: Object.freeze({
        report: (error: unknown) => (raw.reportError ?? console.error)(error),
      }),
    }),
  });
}

async function invokeVoid(raw: RawTauriRuntimePorts, command: string, payload: unknown): Promise<void> {
  const result = await raw.invoke(command, payload);
  if (result !== null && result !== undefined) {
    throw new Error(`Native command ${command} returned unexpected data.`);
  }
}
