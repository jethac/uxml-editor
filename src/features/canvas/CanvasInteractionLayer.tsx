import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PreviewSize, RenderFrameBox } from '../../core/adapter/types';
import type { SnapGuide } from './ManipulationController';

export interface CanvasInteractionLayerProps {
  readonly panelSize: PreviewSize;
  readonly selectedBox: RenderFrameBox | null;
  readonly guides: readonly SnapGuide[];
  readonly onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function CanvasInteractionLayer({
  panelSize,
  selectedBox,
  guides,
  onResizePointerDown,
}: CanvasInteractionLayerProps) {
  return (
    <div
      className="canvas-interaction-layer"
      data-testid="canvas-interaction-layer"
      style={{ width: panelSize.width, height: panelSize.height }}
    >
      <div aria-hidden="true">
        {guides.map((guide) => (
          <span
            key={`${guide.axis}:${guide.value}`}
            className={`canvas-snap-guide canvas-snap-guide--${guide.axis}`}
            style={guide.axis === 'x' ? { left: guide.value } : { top: guide.value }}
          />
        ))}
      </div>
      {selectedBox !== null && (
        <button
          type="button"
          className="canvas-resize-handle"
          aria-label="Resize selection"
          title="Resize selection"
          style={{ left: selectedBox.left + selectedBox.width, top: selectedBox.top + selectedBox.height }}
          onPointerDown={onResizePointerDown}
        />
      )}
    </div>
  );
}
