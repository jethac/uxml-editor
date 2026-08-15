import type { Disposable } from '../host/HostPort';
import type { EditorStore } from '../store/EditorStore';

export const DESKTOP_COMMAND_IDS = Object.freeze([
  'file.open-project',
  'file.save',
  'file.save-all',
  'file.close-project',
  'edit.undo',
  'edit.redo',
  'view.zoom-in',
  'view.zoom-out',
  'view.pane-hierarchy',
  'view.pane-inspector',
  'view.pane-diagnostics',
  'view.pane-source',
] as const);

export type DesktopCommandId = typeof DESKTOP_COMMAND_IDS[number];

export interface DesktopEvent<T> {
  readonly payload: T;
}

export interface DesktopEventPort {
  listen(
    eventName: string,
    listener: (event: DesktopEvent<unknown>) => void | Promise<void>,
  ): Promise<() => void>;
}

export interface DesktopCommandExecutor {
  execute(command: DesktopCommandId): void | Promise<void>;
}

export interface DesktopErrorPort {
  report(error: unknown): void;
}

export interface Task16FileCommandPort {
  save(): void | Promise<void>;
  saveAll(): void | Promise<void>;
  closeProject(): void | Promise<void>;
}

export class DesktopCommandBridge {
  constructor(
    private readonly events: DesktopEventPort,
    private readonly executor: DesktopCommandExecutor,
    private readonly errors: DesktopErrorPort = { report: () => undefined },
  ) {}

  async start(): Promise<Disposable> {
    let active = true;
    const unlisten = await this.events.listen('uxml://menu-command', async ({ payload }) => {
      if (!active || !isDesktopCommandPayload(payload)) return;
      try {
        await this.executor.execute(payload.commandId);
      } catch (error) {
        try {
          this.errors.report(error);
        } catch {
          // Native event callbacks must not leak application error-reporting failures.
        }
      }
    });
    return Object.freeze({
      dispose: () => {
        if (!active) return;
        active = false;
        unlisten();
      },
    });
  }
}

export class EditorDesktopCommandController implements DesktopCommandExecutor {
  constructor(
    private readonly store: EditorStore,
    private readonly fileCommands?: Task16FileCommandPort,
  ) {}

  async execute(command: DesktopCommandId): Promise<void> {
    switch (command) {
      case 'file.open-project':
        this.store.dispatch({ type: 'command/open-project' });
        return;
      case 'file.save':
        await this.fileCommands?.save();
        return;
      case 'file.save-all':
        await this.fileCommands?.saveAll();
        return;
      case 'file.close-project':
        await this.fileCommands?.closeProject();
        return;
      case 'edit.undo':
        this.store.dispatch({ type: 'command/undo' });
        return;
      case 'edit.redo':
        this.store.dispatch({ type: 'command/redo' });
        return;
      case 'view.zoom-in':
        this.store.dispatch({ type: 'command/zoom-in' });
        return;
      case 'view.zoom-out':
        this.store.dispatch({ type: 'command/zoom-out' });
        return;
      case 'view.pane-hierarchy':
        this.store.dispatch({ type: 'panel/set', panel: 'hierarchy' });
        return;
      case 'view.pane-inspector':
        this.store.dispatch({ type: 'panel/set', panel: 'inspector' });
        return;
      case 'view.pane-diagnostics':
        this.store.dispatch({ type: 'panel/set', panel: 'diagnostics' });
        return;
      case 'view.pane-source':
        this.store.dispatch({ type: 'panel/set', panel: 'source' });
    }
  }
}

const COMMAND_IDS: ReadonlySet<string> = new Set(DESKTOP_COMMAND_IDS);

function isDesktopCommandPayload(value: unknown): value is Readonly<{ commandId: DesktopCommandId }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1
    && typeof record.commandId === 'string'
    && COMMAND_IDS.has(record.commandId);
}
