import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

export interface PaneResizerProps {
  readonly testId: string;
  readonly label: string;
  readonly orientation: 'horizontal' | 'vertical';
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly movementSign: 1 | -1;
  readonly onResize: (value: number, persist: boolean) => void;
}

interface ActiveDrag {
  readonly pointerId: number;
  readonly element: HTMLDivElement;
  readonly startCoordinate: number;
  readonly startValue: number;
  value: number;
}

const KEYBOARD_STEP = 8;

export function PaneResizer({
  testId,
  label,
  orientation,
  value,
  min,
  max,
  movementSign,
  onResize,
}: PaneResizerProps) {
  const activeDrag = useRef<ActiveDrag | null>(null);
  const removePointerListeners = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    const drag = activeDrag.current;
    removePointerListeners.current?.();
    removePointerListeners.current = null;
    activeDrag.current = null;
    if (drag !== null) releasePointerCapture(drag);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || activeDrag.current !== null) return;
    event.preventDefault();
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const coordinate = orientation === 'vertical' ? event.clientX : event.clientY;
    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      return;
    }
    activeDrag.current = {
      pointerId,
      element,
      startCoordinate: coordinate,
      startValue: value,
      value,
    };

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = activeDrag.current;
      if (drag === null || pointerEvent.pointerId !== drag.pointerId) return;
      const nextCoordinate = orientation === 'vertical' ? pointerEvent.clientX : pointerEvent.clientY;
      drag.value = clamp(drag.startValue + (nextCoordinate - drag.startCoordinate) * movementSign, min, max);
      onResize(drag.value, false);
    };
    const finishPointer = (pointerEvent: PointerEvent) => {
      const drag = activeDrag.current;
      if (drag === null || pointerEvent.pointerId !== drag.pointerId) return;
      removePointerListeners.current?.();
      removePointerListeners.current = null;
      activeDrag.current = null;
      try {
        drag.element.releasePointerCapture?.(drag.pointerId);
      } catch {
        // Capture can already be lost if the browser ends the pointer first.
      } finally {
        onResize(drag.value, true);
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', finishPointer);
    };
    removePointerListeners.current?.();
    removePointerListeners.current = cleanup;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishPointer);
    window.addEventListener('pointercancel', finishPointer);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'Home') next = min;
    if (event.key === 'End') next = max;
    if (orientation === 'vertical' && event.key === 'ArrowLeft') {
      next = value - KEYBOARD_STEP * movementSign;
    }
    if (orientation === 'vertical' && event.key === 'ArrowRight') {
      next = value + KEYBOARD_STEP * movementSign;
    }
    if (orientation === 'horizontal' && event.key === 'ArrowUp') {
      next = value - KEYBOARD_STEP * movementSign;
    }
    if (orientation === 'horizontal' && event.key === 'ArrowDown') {
      next = value + KEYBOARD_STEP * movementSign;
    }
    if (next === null) return;
    event.preventDefault();
    onResize(clamp(next, min, max), true);
  };

  return (
    <div
      className={`pane-resizer pane-resizer--${orientation}`}
      data-testid={testId}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function releasePointerCapture(drag: ActiveDrag): void {
  try {
    drag.element.releasePointerCapture?.(drag.pointerId);
  } catch {
    // Unmount must remain cleanup-only even if browser capture state changed.
  }
}
