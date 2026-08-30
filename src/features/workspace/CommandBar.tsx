import {
  Eye,
  FolderOpen,
  Hand,
  MousePointer2,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pencil,
  Redo2,
  Save,
  Search,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import type { EditorPanel, EditorSnapshot, EditorStore } from '../../core/store/EditorStore';
import {
  type CommandRegistry,
  type CommandRegistrySnapshot,
  type EditorCommandId,
} from '../../core/store/CommandRegistry';
import type { FileWorkflowPort, FileWorkflowSnapshot } from './FileWorkflow';
import { useSyncExternalStore } from 'react';

export interface CommandBarProps {
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
  readonly registry?: CommandRegistry;
  readonly workflow?: FileWorkflowPort;
  readonly onPanelActivate: (panel: EditorPanel) => void;
}

interface IconButtonProps {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly onClick: () => void;
}

export function CommandBar({ store, snapshot, registry, workflow, onPanelActivate }: CommandBarProps) {
  const registrySnapshot = useSyncExternalStore(
    registry?.subscribe ?? nullRegistrySubscribe,
    registry?.getSnapshot ?? nullRegistrySnapshot,
    registry?.getSnapshot ?? nullRegistrySnapshot,
  );
  const workflowSnapshot = useSyncExternalStore(
    workflow?.subscribe ?? nullWorkflowSubscribe,
    workflow?.getSnapshot ?? nullWorkflowSnapshot,
    workflow?.getSnapshot ?? nullWorkflowSnapshot,
  );
  const projectStatus = workflowSnapshot.projectName ?? snapshot.session?.entryPath ?? 'No project open';
  const projectStateDescription = workflowSnapshot.dirtyState === 'dirty'
    ? 'Project has unsaved changes.'
    : workflowSnapshot.dirtyState === 'clean'
      ? 'Project has no unsaved changes.'
      : 'Project save state is unavailable.';
  const registered = (id: EditorCommandId) => registrySnapshot.commands.find((command) => command.id === id);
  const run = (id: EditorCommandId, fallback: () => void) => {
    if (registry === undefined) fallback();
    else void registry.execute(id);
  };
  return (
    <div
      className="commandbar"
      data-testid="commandbar"
    >
      <div className="commandbar-brand" aria-label="Project status" aria-description={projectStateDescription}>
        <h1>UXML Editor</h1>
        <span title={projectStatus}>{projectStatus}</span>
      </div>
      <div className="commandbar-toolbar" role="toolbar" aria-label="Editor commands">
        <div className="command-group" role="group" aria-label="File and history">
          <IconButton
            label={registered('file.open-project')?.label ?? 'Open project'}
            icon={FolderOpen}
            disabled={registered('file.open-project')?.enabled === false || (registry === undefined && !snapshot.commands.openProject)}
            onClick={() => run('file.open-project', () => store.dispatch({ type: 'command/open-project' }))}
          />
          {registry !== undefined && (
            <IconButton
              label={registered('file.save')?.label ?? 'Save'}
              icon={Save}
              disabled={registered('file.save')?.enabled !== true}
              onClick={() => run('file.save', () => undefined)}
            />
          )}
          <IconButton
            label={registered('edit.undo')?.label ?? 'Undo'}
            icon={Undo2}
            disabled={registered('edit.undo')?.enabled === false || (registry === undefined && !snapshot.commands.undo)}
            onClick={() => run('edit.undo', () => store.dispatch({ type: 'command/undo' }))}
          />
          <IconButton
            label={registered('edit.redo')?.label ?? 'Redo'}
            icon={Redo2}
            disabled={registered('edit.redo')?.enabled === false || (registry === undefined && !snapshot.commands.redo)}
            onClick={() => run('edit.redo', () => store.dispatch({ type: 'command/redo' }))}
          />
        </div>

        <div className="command-group segmented-control" role="group" aria-label="Canvas tool">
          <IconButton
            label="Select tool"
            icon={MousePointer2}
            pressed={snapshot.activeTool === 'select'}
            onClick={() => store.dispatch({ type: 'tool/set', tool: 'select' })}
          />
          <IconButton
            label="Pan tool"
            icon={Hand}
            pressed={snapshot.activeTool === 'pan'}
            onClick={() => store.dispatch({ type: 'tool/set', tool: 'pan' })}
          />
        </div>

        <div className="command-group command-group--zoom" role="group" aria-label="Zoom">
          <IconButton
            label={registered('view.zoom-out')?.label ?? 'Zoom out'}
            icon={ZoomOut}
            disabled={registered('view.zoom-out')?.enabled === false || (registry === undefined && !snapshot.commands.zoomOut)}
            onClick={() => run('view.zoom-out', () => store.dispatch({ type: 'command/zoom-out' }))}
          />
          <output aria-label="Canvas zoom">{Math.round(snapshot.zoom * 100)}%</output>
          <IconButton
            label={registered('view.zoom-in')?.label ?? 'Zoom in'}
            icon={ZoomIn}
            disabled={registered('view.zoom-in')?.enabled === false || (registry === undefined && !snapshot.commands.zoomIn)}
            onClick={() => run('view.zoom-in', () => store.dispatch({ type: 'command/zoom-in' }))}
          />
        </div>

        <div className="command-group segmented-control" role="group" aria-label="Preview state">
          <IconButton
            label="Edit preview"
            icon={Pencil}
            pressed={snapshot.previewState === 'edit'}
            onClick={() => store.dispatch({ type: 'preview/set', state: 'edit' })}
          />
          <IconButton
            label="Preview"
            icon={Eye}
            pressed={snapshot.previewState === 'preview'}
            onClick={() => store.dispatch({ type: 'preview/set', state: 'preview' })}
          />
        </div>

        <div className="command-group command-group--panels" role="group" aria-label="Panels">
          <IconButton
            label={registered('view.pane-hierarchy')?.label ?? 'Show hierarchy'}
            icon={PanelLeft}
            pressed={snapshot.activePanel === 'hierarchy'}
            onClick={() => {
              run('view.pane-hierarchy', () => undefined);
              onPanelActivate('hierarchy');
            }}
          />
          <IconButton
            label={registered('view.pane-inspector')?.label ?? 'Show inspector'}
            icon={PanelRight}
            pressed={snapshot.activePanel === 'inspector'}
            onClick={() => {
              run('view.pane-inspector', () => undefined);
              onPanelActivate('inspector');
            }}
          />
          <IconButton
            label={registered('view.pane-diagnostics')?.label ?? 'Show diagnostics'}
            icon={PanelBottom}
            pressed={snapshot.activePanel === 'diagnostics'}
            onClick={() => {
              run('view.pane-diagnostics', () => undefined);
              onPanelActivate('diagnostics');
            }}
          />
        </div>
        {registry !== undefined && (
          <div className="command-group" role="group" aria-label="Command search">
            <IconButton
              label={registered('workspace.command-palette')?.label ?? 'Command Palette'}
              icon={Search}
              disabled={registered('workspace.command-palette')?.enabled !== true}
              onClick={() => run('workspace.command-palette', () => undefined)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY_REGISTRY_SNAPSHOT: CommandRegistrySnapshot = Object.freeze({ commands: Object.freeze([]) });
const nullRegistrySubscribe = (_listener: () => void) => () => undefined;
const nullRegistrySnapshot = () => EMPTY_REGISTRY_SNAPSHOT;
const EMPTY_WORKFLOW_SNAPSHOT: FileWorkflowSnapshot = Object.freeze({
  projectName: null,
  dirtyState: 'clean',
  recentProjects: Object.freeze([]),
  externalChanges: Object.freeze([]),
  canReopen: false,
  canReload: false,
  capabilities: Object.freeze({
    newProject: false,
    openProject: false,
    openRecent: false,
    save: false,
    saveAs: false,
    saveAll: false,
    closeProject: false,
    reopenProject: false,
    reloadProject: false,
  }),
});
const nullWorkflowSubscribe = (_listener: () => void) => () => undefined;
const nullWorkflowSnapshot = () => EMPTY_WORKFLOW_SNAPSHOT;

function IconButton({ label, icon: Icon, disabled = false, pressed, onClick }: IconButtonProps) {
  return (
    <button
      type="button"
      className="icon-command"
      data-control-shape="square"
      aria-label={label}
      title={label}
      disabled={disabled}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      onClick={onClick}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
    </button>
  );
}
