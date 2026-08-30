import type { RecentProject } from '../host/HostPort';
import type { EditorStore } from './EditorStore';
import commandMetadataSource from './CommandDefinitions.json';

export type EditorCommandId =
  | 'file.new-project'
  | 'file.open-project'
  | 'file.open-recent'
  | 'file.save'
  | 'file.save-as'
  | 'file.save-all'
  | 'file.close-project'
  | 'file.reopen-project'
  | 'file.reload-project'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.duplicate'
  | 'edit.delete'
  | 'view.zoom-in'
  | 'view.zoom-out'
  | 'view.zoom-reset'
  | 'view.search'
  | 'view.diagnostics'
  | 'view.pane-hierarchy'
  | 'view.pane-inspector'
  | 'view.pane-diagnostics'
  | 'view.pane-source'
  | 'workspace.command-palette';
export type CommandCategory = 'File' | 'Edit' | 'View';
export type CommandPlatform = 'windows' | 'mac';

export interface EditorFileCommandSnapshot {
  readonly projectName: string | null;
  readonly dirtyState: 'clean' | 'dirty' | 'unknown';
  readonly recentProjects: readonly RecentProject[];
  readonly canReopen: boolean;
  readonly canReload: boolean;
  readonly capabilities: EditorFileCommandCapabilities;
}

export interface EditorFileCommandCapabilities {
  readonly newProject: boolean;
  readonly openProject: boolean;
  readonly openRecent: boolean;
  readonly save: boolean;
  readonly saveAs: boolean;
  readonly saveAll: boolean;
  readonly closeProject: boolean;
  readonly reopenProject: boolean;
  readonly reloadProject: boolean;
}

export interface EditorFileCommandPort {
  newProject(): void | Promise<void>;
  openProject(): void | Promise<void>;
  openRecent(recent?: RecentProject): void | Promise<void>;
  save(): void | Promise<void>;
  saveAs(): void | Promise<void>;
  saveAll(): void | Promise<void>;
  closeProject(): void | Promise<void>;
  reopenProject(): void | Promise<void>;
  reloadProject(): void | Promise<void>;
  getSnapshot(): EditorFileCommandSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface EditorEditingCommandPort {
  canCut(): boolean;
  canCopy(): boolean;
  canPaste(): boolean;
  canDuplicate(): boolean;
  canDelete(): boolean;
  cut(): void | Promise<void>;
  copy(): void | Promise<void>;
  paste(): void | Promise<void>;
  duplicate(): void | Promise<void>;
  delete(): void | Promise<void>;
}

export interface EditorUiCommandPort {
  openSearch(): void;
  openCommandPalette(): void;
}

export interface CommandRegistryOptions {
  readonly store: EditorStore;
  readonly file: EditorFileCommandPort;
  readonly editing?: EditorEditingCommandPort;
  readonly ui?: EditorUiCommandPort;
  readonly errors: CommandErrorPort;
  readonly platform?: CommandPlatform;
}

export interface CommandErrorPort {
  report(command: EditorCommandState, error: unknown): void | Promise<void>;
}

export interface EditorCommandState {
  readonly id: EditorCommandId;
  readonly label: string;
  readonly category: CommandCategory;
  readonly shortcut: string | null;
  readonly enabled: boolean;
}

export interface CommandRegistrySnapshot {
  readonly commands: readonly EditorCommandState[];
}

export type CommandExecutionResult =
  | Readonly<{ readonly status: 'executed' | 'unavailable' }>
  | Readonly<{ readonly status: 'failed'; readonly error: unknown }>;

interface CommandDefinition {
  readonly id: EditorCommandId;
  readonly label: string;
  readonly section: CommandCategory;
  readonly windowsAccelerator: string | null;
  readonly macAccelerator: string | null;
  readonly enabled: (options: CommandRegistryOptions) => boolean;
  readonly execute: (options: CommandRegistryOptions, argument?: unknown) => void | Promise<void>;
}

type CommandBehavior = Pick<CommandDefinition, 'enabled' | 'execute'>;

export class CommandRegistry {
  private readonly options: CommandRegistryOptions;
  private readonly platform: CommandPlatform;
  private readonly listeners = new Map<number, () => void>();
  private disposeSources: readonly (() => void)[] = Object.freeze([]);
  private nextListenerId = 1;
  private snapshot: CommandRegistrySnapshot;

  constructor(options: CommandRegistryOptions) {
    this.options = options;
    this.platform = options.platform ?? runtimePlatform();
    this.snapshot = this.createSnapshot();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    const id = this.nextListenerId++;
    this.listeners.set(id, listener);
    if (this.listeners.size === 1) this.connectSources();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(id);
      if (this.listeners.size === 0) this.disconnectSources();
    };
  };

  readonly getSnapshot = (): CommandRegistrySnapshot => this.snapshot;

  command(id: EditorCommandId): EditorCommandState {
    return this.createSnapshot().commands.find((command) => command.id === id)!;
  }

  async execute(id: EditorCommandId, argument?: unknown): Promise<CommandExecutionResult> {
    const definition = DEFINITIONS_BY_ID.get(id);
    if (definition === undefined || !definition.enabled(this.options)) {
      return Object.freeze({ status: 'unavailable' });
    }
    try {
      await definition.execute(this.options, argument);
      return Object.freeze({ status: 'executed' });
    } catch (error) {
      try {
        await this.options.errors.report(commandState(definition, this.platform, true), error);
      } catch {
        // Execution callers stay contained even if the visible error boundary itself fails.
      }
      return Object.freeze({ status: 'failed', error });
    }
  }

  dispose(): void {
    this.disconnectSources();
    this.listeners.clear();
  }

  private readonly refresh = (): void => {
    this.snapshot = this.createSnapshot();
    let listenerError: unknown;
    let listenerThrew = false;
    for (const listener of [...this.listeners.values()]) {
      try {
        listener();
      } catch (error) {
        if (!listenerThrew) listenerError = error;
        listenerThrew = true;
      }
    }
    if (listenerThrew) throw listenerError;
  };

  private createSnapshot(): CommandRegistrySnapshot {
    return Object.freeze({
      commands: Object.freeze(DEFINITIONS.map((definition) => Object.freeze({
        ...commandState(definition, this.platform, definition.enabled(this.options)),
      }))),
    });
  }

  private connectSources(): void {
    if (this.disposeSources.length > 0) return;
    this.snapshot = this.createSnapshot();
    this.disposeSources = Object.freeze([
      this.options.store.subscribe(this.refresh),
      this.options.file.subscribe(this.refresh),
    ]);
  }

  private disconnectSources(): void {
    const sources = this.disposeSources;
    this.disposeSources = Object.freeze([]);
    for (const dispose of sources) dispose();
  }
}

const BEHAVIORS = {
  'file.new-project': fileCommand('newProject', ({ file }) => file.newProject()),
  'file.open-project': fileCommand('openProject', ({ file }) => file.openProject()),
  'file.open-recent': fileCommand('openRecent', ({ file }, argument) => (
    file.openRecent(argument as RecentProject | undefined)
  )),
  'file.save': fileCommand('save', ({ file }) => file.save()),
  'file.save-as': fileCommand('saveAs', ({ file }) => file.saveAs()),
  'file.save-all': fileCommand('saveAll', ({ file }) => file.saveAll()),
  'file.close-project': fileCommand('closeProject', ({ file }) => file.closeProject()),
  'file.reopen-project': fileCommand('reopenProject', ({ file }) => file.reopenProject()),
  'file.reload-project': fileCommand('reloadProject', ({ file }) => file.reloadProject()),
  'edit.undo': storeCommand('undo', { type: 'command/undo' }),
  'edit.redo': storeCommand('redo', { type: 'command/redo' }),
  'edit.cut': editingCommand('canCut', 'cut'),
  'edit.copy': editingCommand('canCopy', 'copy'),
  'edit.paste': editingCommand('canPaste', 'paste'),
  'edit.duplicate': editingCommand('canDuplicate', 'duplicate'),
  'edit.delete': editingCommand('canDelete', 'delete'),
  'view.zoom-in': storeCommand('zoomIn', { type: 'command/zoom-in' }),
  'view.zoom-out': storeCommand('zoomOut', { type: 'command/zoom-out' }),
  'view.zoom-reset': viewCommand(({ store }) => store.dispatch({ type: 'zoom/set', zoom: 1 })),
  'view.search': {
    ...viewCommand(({ ui }) => ui?.openSearch()),
    enabled: ({ ui }) => ui !== undefined,
  },
  'view.diagnostics': viewCommand(({ store }) => store.dispatch({ type: 'panel/set', panel: 'diagnostics' })),
  'view.pane-hierarchy': viewCommand(({ store }) => store.dispatch({ type: 'panel/set', panel: 'hierarchy' })),
  'view.pane-inspector': viewCommand(({ store }) => store.dispatch({ type: 'panel/set', panel: 'inspector' })),
  'view.pane-diagnostics': viewCommand(({ store }) => store.dispatch({ type: 'panel/set', panel: 'diagnostics' })),
  'view.pane-source': viewCommand(({ store }) => store.dispatch({ type: 'panel/set', panel: 'source' })),
  'workspace.command-palette': {
    ...viewCommand(({ ui }) => ui?.openCommandPalette()),
    enabled: ({ ui }) => ui !== undefined,
  },
} satisfies Record<EditorCommandId, CommandBehavior>;

const DEFINITIONS: readonly CommandDefinition[] = Object.freeze(commandMetadataSource.map((metadata) => {
  const id = metadata.id as EditorCommandId;
  const behavior = BEHAVIORS[id];
  if (behavior === undefined || !isCommandCategory(metadata.section)) {
    throw new Error(`Invalid shared command definition: ${metadata.id}`);
  }
  return Object.freeze({
    id,
    label: metadata.label,
    section: metadata.section,
    windowsAccelerator: metadata.windowsAccelerator,
    macAccelerator: metadata.macAccelerator,
    ...behavior,
  });
}));

if (new Set(DEFINITIONS.map(({ id }) => id)).size !== Object.keys(BEHAVIORS).length) {
  throw new Error('Shared command definitions must contain each editor command exactly once.');
}

export const EDITOR_COMMAND_IDS: readonly EditorCommandId[] = Object.freeze(
  DEFINITIONS.map(({ id }) => id),
);

const DEFINITIONS_BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

function fileCommand(
  capability: keyof EditorFileCommandCapabilities,
  execute: CommandDefinition['execute'],
): CommandBehavior {
  return Object.freeze({
    enabled: ({ file }: CommandRegistryOptions) => file.getSnapshot().capabilities[capability],
    execute,
  });
}

function storeCommand(
  availability: 'undo' | 'redo' | 'zoomIn' | 'zoomOut',
  action: Parameters<EditorStore['dispatch']>[0],
): CommandBehavior {
  return Object.freeze({
    enabled: ({ store }: CommandRegistryOptions) => store.getSnapshot().commands[availability],
    execute: ({ store }: CommandRegistryOptions) => store.dispatch(action),
  });
}

function editingCommand(
  availability: 'canCut' | 'canCopy' | 'canPaste' | 'canDuplicate' | 'canDelete',
  action: 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete',
): CommandBehavior {
  return Object.freeze({
    enabled: ({ editing }: CommandRegistryOptions) => editing?.[availability]() ?? false,
    execute: ({ editing }: CommandRegistryOptions) => editing?.[action](),
  });
}

function viewCommand(execute: CommandDefinition['execute']): CommandBehavior {
  return Object.freeze({
    enabled: () => true,
    execute,
  });
}

function shortcutFor(definition: CommandDefinition, platform: CommandPlatform): string | null {
  return platform === 'mac' ? definition.macAccelerator : definition.windowsAccelerator;
}

function commandState(
  definition: CommandDefinition,
  platform: CommandPlatform,
  enabled: boolean,
): EditorCommandState {
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    category: definition.section,
    shortcut: shortcutFor(definition, platform),
    enabled,
  });
}

function isCommandCategory(value: string): value is CommandCategory {
  return value === 'File' || value === 'Edit' || value === 'View';
}

function runtimePlatform(): CommandPlatform {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? 'mac'
    : 'windows';
}
