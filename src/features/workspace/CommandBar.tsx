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
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import type { EditorSnapshot, EditorStore } from '../../core/store/EditorStore';
import { WORKBENCH_COMMAND_BAR_HEIGHT } from '../../core/store/EditorLayoutStorage';

export interface CommandBarProps {
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
}

interface IconButtonProps {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly onClick: () => void;
}

export function CommandBar({ store, snapshot }: CommandBarProps) {
  const projectStatus = snapshot.session?.entryPath ?? 'No project open';
  return (
    <header
      className="commandbar"
      data-testid="commandbar"
      data-layout-top="0"
      data-layout-height={WORKBENCH_COMMAND_BAR_HEIGHT}
    >
      <div className="commandbar-brand" aria-label="Project status">
        <strong>UXML Editor</strong>
        <span title={projectStatus}>{projectStatus}</span>
      </div>
      <div className="commandbar-toolbar" role="toolbar" aria-label="Editor commands">
        <div className="command-group" role="group" aria-label="File and history">
          <IconButton
            label="Open project"
            icon={FolderOpen}
            disabled={!snapshot.commands.openProject}
            onClick={() => store.dispatch({ type: 'command/open-project' })}
          />
          <IconButton
            label="Undo"
            icon={Undo2}
            disabled={!snapshot.commands.undo}
            onClick={() => store.dispatch({ type: 'command/undo' })}
          />
          <IconButton
            label="Redo"
            icon={Redo2}
            disabled={!snapshot.commands.redo}
            onClick={() => store.dispatch({ type: 'command/redo' })}
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
            label="Zoom out"
            icon={ZoomOut}
            disabled={!snapshot.commands.zoomOut}
            onClick={() => store.dispatch({ type: 'command/zoom-out' })}
          />
          <output aria-label="Canvas zoom">{Math.round(snapshot.zoom * 100)}%</output>
          <IconButton
            label="Zoom in"
            icon={ZoomIn}
            disabled={!snapshot.commands.zoomIn}
            onClick={() => store.dispatch({ type: 'command/zoom-in' })}
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
            label="Show hierarchy"
            icon={PanelLeft}
            pressed={snapshot.activePanel === 'hierarchy'}
            onClick={() => store.dispatch({ type: 'panel/set', panel: 'hierarchy' })}
          />
          <IconButton
            label="Show inspector"
            icon={PanelRight}
            pressed={snapshot.activePanel === 'inspector'}
            onClick={() => store.dispatch({ type: 'panel/set', panel: 'inspector' })}
          />
          <IconButton
            label="Show diagnostics"
            icon={PanelBottom}
            pressed={snapshot.activePanel === 'diagnostics'}
            onClick={() => store.dispatch({ type: 'panel/set', panel: 'diagnostics' })}
          />
        </div>
      </div>
    </header>
  );
}

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
