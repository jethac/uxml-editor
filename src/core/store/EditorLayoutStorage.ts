export type PaneName = 'left' | 'right' | 'bottom';

export interface PaneDimensions {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

export interface EditorViewport {
  readonly width: number;
  readonly height: number;
}

export interface EditorLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface PaneLimit {
  readonly min: number;
  readonly max: number;
}

export const EDITOR_LAYOUT_STORAGE_KEY = 'uxml-editor.layout';
export const EDITOR_LAYOUT_SCHEMA_VERSION = 1;
export const WORKBENCH_COMMAND_BAR_HEIGHT = 40;
export const WORKBENCH_SEPARATOR_SIZE = 4;
export const WORKBENCH_COMPACT_BREAKPOINT = 720;
export const WORKBENCH_MIN_CANVAS_WIDTH = 96;

export const PANE_LIMITS: Readonly<Record<PaneName, PaneLimit>> = Object.freeze({
  left: Object.freeze({ min: 160, max: 420 }),
  right: Object.freeze({ min: 200, max: 480 }),
  bottom: Object.freeze({ min: 96, max: 360 }),
});

export const DEFAULT_PANE_DIMENSIONS: PaneDimensions = Object.freeze({
  left: 240,
  right: 280,
  bottom: 180,
});

export const DEFAULT_VIEWPORT: EditorViewport = Object.freeze({
  width: 1366,
  height: 768,
});

export function clampPaneDimension(pane: PaneName, value: number): number {
  const limits = PANE_LIMITS[pane];
  return Math.min(limits.max, Math.max(limits.min, value));
}

export function restorePaneDimensions(storage: EditorLayoutStorage | null): PaneDimensions {
  if (storage === null) return copyDefaultDimensions();
  try {
    const serialized = storage.getItem(EDITOR_LAYOUT_STORAGE_KEY);
    if (serialized === null) return copyDefaultDimensions();
    const value: unknown = JSON.parse(serialized);
    if (!isLayoutPayload(value)) return copyDefaultDimensions();
    return freezePaneDimensions({
      left: clampPaneDimension('left', value.panes.left),
      right: clampPaneDimension('right', value.panes.right),
      bottom: clampPaneDimension('bottom', value.panes.bottom),
    });
  } catch {
    return copyDefaultDimensions();
  }
}

export function persistPaneDimensions(
  storage: EditorLayoutStorage | null,
  panes: PaneDimensions,
): void {
  if (storage === null) return;
  try {
    storage.setItem(EDITOR_LAYOUT_STORAGE_KEY, JSON.stringify({
      version: EDITOR_LAYOUT_SCHEMA_VERSION,
      panes: { left: panes.left, right: panes.right, bottom: panes.bottom },
    }));
  } catch {
    // UI layout persistence must never make the editor unusable.
  }
}

export function createBrowserLayoutStorage(): EditorLayoutStorage {
  return Object.freeze({
    getItem(key: string): string | null {
      try {
        return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
      } catch {
        // Browser policy and opaque origins may deny local storage.
      }
    },
  });
}

export function freezePaneDimensions(panes: PaneDimensions): PaneDimensions {
  return Object.freeze({ left: panes.left, right: panes.right, bottom: panes.bottom });
}

function copyDefaultDimensions(): PaneDimensions {
  return freezePaneDimensions(DEFAULT_PANE_DIMENSIONS);
}

function isLayoutPayload(value: unknown): value is {
  readonly version: 1;
  readonly panes: PaneDimensions;
} {
  if (!isRecord(value) || value.version !== EDITOR_LAYOUT_SCHEMA_VERSION || !isRecord(value.panes)) {
    return false;
  }
  return isFiniteNumber(value.panes.left)
    && isFiniteNumber(value.panes.right)
    && isFiniteNumber(value.panes.bottom);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
