import type { CSSProperties } from 'react';
import type { EditorNodeId, PreviewFrame, PreviewSize, RenderFrameBox } from '../../core/adapter/types';

export interface CanvasOverlayProps {
  readonly frame: PreviewFrame;
  readonly panelSize: PreviewSize;
  readonly hoveredNodeId: EditorNodeId | null;
  readonly selectedNodeId: EditorNodeId | null;
  readonly selectedParentNodeId: EditorNodeId | null;
  readonly showSafeArea: boolean;
}

export function CanvasOverlay({ frame, panelSize, hoveredNodeId, selectedNodeId, selectedParentNodeId, showSafeArea }: CanvasOverlayProps) {
  const hover = boxFor(frame, hoveredNodeId);
  const selected = boxFor(frame, selectedNodeId);
  const parent = boxFor(frame, selectedParentNodeId);
  return (
    <div className="canvas-overlay" data-testid="canvas-overlay" style={{ width: panelSize.width, height: panelSize.height, pointerEvents: 'none' }} aria-hidden="true">
      {showSafeArea && <div className="canvas-safe-area" data-testid="safe-area" />}
      {parent !== null && <div className="canvas-bounds canvas-bounds--parent" data-testid="selected-parent-bounds" style={boxStyle(parent)} />}
      {hover !== null && <div className="canvas-bounds canvas-bounds--hover" data-testid="hover-bounds" style={boxStyle(hover)} />}
      {selected !== null && (
        <div className="canvas-bounds canvas-bounds--selected" data-testid="selected-bounds" style={boxStyle(selected)}>
          {['nw', 'ne', 'sw', 'se'].map((position) => (
            <span key={position} className={`canvas-selection-handle canvas-selection-handle--${position}`} data-testid="selection-handle" />
          ))}
        </div>
      )}
    </div>
  );
}

function boxFor(frame: PreviewFrame, nodeId: EditorNodeId | null): RenderFrameBox | null {
  return nodeId === null ? null : frame.boxes.get(nodeId) ?? null;
}

function boxStyle(box: RenderFrameBox): CSSProperties {
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}
