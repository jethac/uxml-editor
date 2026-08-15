import type { RecentProject } from '../host/HostPort';
import type { EditorStore } from './EditorStore';

export const EDITOR_COMMAND_IDS = Object.freeze([
  'file.new-project',
  'file.open-project',
  'file.open-recent',
  'file.save',
  'file.save-as',
  'file.save-all',
  'file.close-project',
  'file.reopen-project',
  'file.reload-project',
  'edit.undo',
  'edit.redo',
  'edit.cut',
  'edit.copy',
  'edit.paste',
  'edit.duplicate',
  'edit.delete',
  'view.zoom-in',
  'view.zoom-out',
  'view.zoom-reset',
  'view.search',
  'view.diagnostics',
  'view.pane-hierarchy',
  'view.pane-inspector',
  'view.pane-diagnostics',
  'view.pane-source',
  'workspace.command-palette',
] as const);

export type EditorCommandId = typeof EDITOR_COMMAND_IDS[number];
export type CommandCategory = 'File' | 'Edit' | 'View';
export type CommandPlatform = 'windows' | 'mac';

export interface EditorFileCommandSnapshot {
  readonly projectName: string | null;
  readonly dirtyState: 'clean' | 'dirty' | 'unknown';
  readonly recentProjects: readonly RecentProject[];
  readonly canReopen: boolean;
  readonly canReload: boolean;
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
  readonly platform?: CommandPlatform;
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

export type CommandExecutionResult = Readonly<{ readonly status: 'executed' | 'unavailable' }>;

interface CommandDefinition {
  readonly id: EditorCommandId;
  readonly label: string;
  readonly category: CommandCategory;
  readonly windowsShortcut?: string;
  readonly macShortcut?: string;
  readonly enabled: (options: CommandRegistryOptions) => boolean;
  readonly execute: (options: CommandRegistryOptions, argument?: unknown) => void | Promise<void>;
}

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
    await definition.execute(this.options, argument);
    return Object.freeze({ status: 'executed' });
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
        id: definition.id,
        label: definition.label,
        category: definition.category,
        shortcut: shortcutFor(definition, this.platform),
        enabled: definition.enabled(this.options),
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

const DEFINITIONS: readonly CommandDefinition[] = Object.freeze([
  fileCommand('file.new-project', 'New Project', 'Ctrl+N', 'Meta+N', ({ file }) => file.newProject()),
  fileCommand('file.open-project', 'Open Project', 'Ctrl+O', 'Meta+O', ({ file }) => file.openProject()),
  {
    ...fileCommand('file.open-recent', 'Open Recent Project', undefined, undefined, ({ file }, argument) => (
      file.openRecent(argument as RecentProject | undefined)
    )),
    enabled: ({ file }) => file.getSnapshot().recentProjects.length > 0,
  },
  sessionFileCommand('file.save', 'Save', 'Ctrl+S', 'Meta+S', ({ file }) => file.save()),
  sessionFileCommand('file.save-as', 'Save As', 'Ctrl+Shift+S', 'Meta+Shift+S', ({ file }) => file.saveAs()),
  sessionFileCommand('file.save-all', 'Save All', 'Ctrl+Alt+S', 'Meta+Alt+S', ({ file }) => file.saveAll()),
  sessionFileCommand('file.close-project', 'Close Project', 'Ctrl+W', 'Meta+W', ({ file }) => file.closeProject()),
  {
    ...fileCommand('file.reopen-project', 'Reopen Project', undefined, undefined, ({ file }) => file.reopenProject()),
    enabled: ({ file }) => file.getSnapshot().canReopen,
  },
  {
    ...fileCommand('file.reload-project', 'Reload Project', 'Ctrl+Shift+R', 'Meta+Shift+R', ({ file }) => file.reloadProject()),
    enabled: ({ file }) => file.getSnapshot().canReload,
  },
  storeCommand('edit.undo', 'Undo', 'Edit', 'Ctrl+Z', 'Meta+Z', 'undo', { type: 'command/undo' }),
  storeCommand('edit.redo', 'Redo', 'Edit', 'Ctrl+Y', 'Meta+Shift+Z', 'redo', { type: 'command/redo' }),
  editingCommand('edit.cut', 'Cut', 'Ctrl+X', 'Meta+X', 'canCut', 'cut'),
  editingCommand('edit.copy', 'Copy', 'Ctrl+C', 'Meta+C', 'canCopy', 'copy'),
  editingCommand('edit.paste', 'Paste', 'Ctrl+V', 'Meta+V', 'canPaste', 'paste'),
  editingCommand('edit.duplicate', 'Duplicate', 'Ctrl+D', 'Meta+D', 'canDuplicate', 'duplicate'),
  editingCommand('edit.delete', 'Delete', 'Delete', 'Backspace', 'canDelete', 'delete'),
  storeCommand('view.zoom-in', 'Zoom In', 'View', 'Ctrl++', 'Meta++', 'zoomIn', { type: 'command/zoom-in' }),
  storeCommand('view.zoom-out', 'Zoom Out', 'View', 'Ctrl+-', 'Meta+-', 'zoomOut', { type: 'command/zoom-out' }),
  viewCommand('view.zoom-reset', 'Actual Size', 'Ctrl+0', 'Meta+0', ({ store }) => store.dispatch({ type: 'zoom/set', zoom: 1 })),
  {
    ...viewCommand('view.search', 'Search', 'Ctrl+F', 'Meta+F', ({ ui }) => ui?.openSearch()),
    enabled: ({ ui }) => ui !== undefined,
  },
  viewCommand('view.diagnostics', 'Show Diagnostics', 'Ctrl+Shift+M', 'Meta+Shift+M', ({ store }) => store.dispatch({ type: 'panel/set', panel: 'diagnostics' })),
  viewCommand('view.pane-hierarchy', 'Show Hierarchy', 'Ctrl+1', 'Meta+1', ({ store }) => store.dispatch({ type: 'panel/set', panel: 'hierarchy' })),
  viewCommand('view.pane-inspector', 'Show Inspector', 'Ctrl+2', 'Meta+2', ({ store }) => store.dispatch({ type: 'panel/set', panel: 'inspector' })),
  viewCommand('view.pane-diagnostics', 'Show Diagnostics', 'Ctrl+3', 'Meta+3', ({ store }) => store.dispatch({ type: 'panel/set', panel: 'diagnostics' })),
  viewCommand('view.pane-source', 'Show Source', 'Ctrl+4', 'Meta+4', ({ store }) => store.dispatch({ type: 'panel/set', panel: 'source' })),
  {
    ...viewCommand('workspace.command-palette', 'Command Palette', 'Ctrl+Shift+P', 'Meta+Shift+P', ({ ui }) => ui?.openCommandPalette()),
    enabled: ({ ui }) => ui !== undefined,
  },
]);

const DEFINITIONS_BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

function fileCommand(
  id: EditorCommandId,
  label: string,
  windowsShortcut: string | undefined,
  macShortcut: string | undefined,
  execute: CommandDefinition['execute'],
): CommandDefinition {
  return Object.freeze({
    id,
    label,
    category: 'File',
    windowsShortcut,
    macShortcut,
    enabled: ({ store }: CommandRegistryOptions) => store.getSnapshot().host !== null,
    execute,
  });
}

function sessionFileCommand(
  id: EditorCommandId,
  label: string,
  windowsShortcut: string,
  macShortcut: string,
  execute: CommandDefinition['execute'],
): CommandDefinition {
  return Object.freeze({
    ...fileCommand(id, label, windowsShortcut, macShortcut, execute),
    enabled: ({ store }: CommandRegistryOptions) => store.getSnapshot().session !== null,
  });
}

function storeCommand(
  id: EditorCommandId,
  label: string,
  category: CommandCategory,
  windowsShortcut: string,
  macShortcut: string,
  availability: 'undo' | 'redo' | 'zoomIn' | 'zoomOut',
  action: Parameters<EditorStore['dispatch']>[0],
): CommandDefinition {
  return Object.freeze({
    id,
    label,
    category,
    windowsShortcut,
    macShortcut,
    enabled: ({ store }: CommandRegistryOptions) => store.getSnapshot().commands[availability],
    execute: ({ store }: CommandRegistryOptions) => store.dispatch(action),
  });
}

function editingCommand(
  id: EditorCommandId,
  label: string,
  windowsShortcut: string,
  macShortcut: string,
  availability: 'canCut' | 'canCopy' | 'canPaste' | 'canDuplicate' | 'canDelete',
  action: 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete',
): CommandDefinition {
  return Object.freeze({
    id,
    label,
    category: 'Edit',
    windowsShortcut,
    macShortcut,
    enabled: ({ editing }: CommandRegistryOptions) => editing?.[availability]() ?? false,
    execute: ({ editing }: CommandRegistryOptions) => editing?.[action](),
  });
}

function viewCommand(
  id: EditorCommandId,
  label: string,
  windowsShortcut: string | undefined,
  macShortcut: string | undefined,
  execute: CommandDefinition['execute'],
): CommandDefinition {
  return Object.freeze({
    id,
    label,
    category: 'View',
    windowsShortcut,
    macShortcut,
    enabled: () => true,
    execute,
  });
}

function shortcutFor(definition: CommandDefinition, platform: CommandPlatform): string | null {
  return (platform === 'mac' ? definition.macShortcut : definition.windowsShortcut) ?? null;
}

function runtimePlatform(): CommandPlatform {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? 'mac'
    : 'windows';
}
