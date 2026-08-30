import type { AppDesktopPorts } from './App';
import {
  DESKTOP_FILE_COMMAND_IDS,
  type DesktopFileCommandAvailability,
} from '../core/desktop/DesktopCommandBridge';
import { TauriHost, type TauriEvent, type TauriTimerPorts } from '../core/host/TauriHost';

export interface RawTauriRuntimePorts {
  readonly commandAuthority: object;
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
      commandAuthority: raw.commandAuthority,
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
        setLifecycleReady: async (lifecycleGeneration: string, ready: boolean) => {
          if (!/^lifecycle:v1:[0-9a-f]{16}$/.test(lifecycleGeneration)) {
            throw new Error('Desktop lifecycle generation is malformed.');
          }
          await invokeVoid(
            raw,
            'desktop_set_lifecycle_ready',
            { request: { lifecycleGeneration, ready } },
          );
        },
        resolveClose: async (lease: string, lifecycleGeneration: string, action: 'close' | 'cancel') => {
          if (!/^close:v1:[0-9a-f]{16}$/.test(lease)
            || !/^lifecycle:v1:[0-9a-f]{16}$/.test(lifecycleGeneration)
            || (action !== 'close' && action !== 'cancel')) {
            throw new Error('Desktop close resolution is malformed.');
          }
          await invokeVoid(raw, 'desktop_resolve_close', {
            request: { lease, lifecycleGeneration, action },
          });
        },
        abandonClose: async (lease: string, lifecycleGeneration: string) => {
          if (!/^close:v1:[0-9a-f]{16}$/.test(lease)
            || !/^lifecycle:v1:[0-9a-f]{16}$/.test(lifecycleGeneration)) {
            throw new Error('Desktop close abandonment is malformed.');
          }
          await invokeVoid(raw, 'desktop_abandon_close', {
            request: { lease, lifecycleGeneration },
          });
        },
      }),
      menu: Object.freeze({
        setFileWorkflowEnabled: async (
          workflowGeneration: string,
          availability: DesktopFileCommandAvailability,
        ) => {
          if (!/^workflow:v1:[0-9a-f]{16}$/.test(workflowGeneration)) {
            throw new Error('Desktop workflow generation is malformed.');
          }
          const validatedAvailability = validateFileCommandAvailability(availability);
          await invokeVoid(
            raw,
            'desktop_set_file_workflow_enabled',
            { request: { workflowGeneration, availability: validatedAvailability } },
          );
        },
      }),
      errors: Object.freeze({
        report: (error: unknown) => (raw.reportError ?? console.error)(error),
      }),
    }),
  });
}

const DESKTOP_FILE_COMMAND_ID_SET: ReadonlySet<string> = new Set(DESKTOP_FILE_COMMAND_IDS);

function validateFileCommandAvailability(value: unknown): DesktopFileCommandAvailability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Desktop file-command availability is malformed.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== DESKTOP_FILE_COMMAND_IDS.length
    || keys.some((key) => !DESKTOP_FILE_COMMAND_ID_SET.has(key))
    || DESKTOP_FILE_COMMAND_IDS.some((id) => typeof record[id] !== 'boolean')) {
    throw new Error('Desktop file-command availability is malformed.');
  }
  return Object.freeze(Object.fromEntries(
    DESKTOP_FILE_COMMAND_IDS.map((id) => [id, record[id] as boolean]),
  )) as DesktopFileCommandAvailability;
}

async function invokeVoid(raw: RawTauriRuntimePorts, command: string, payload: unknown): Promise<void> {
  const result = await raw.invoke(command, payload);
  if (result !== null && result !== undefined) {
    throw new Error(`Native command ${command} returned unexpected data.`);
  }
}
