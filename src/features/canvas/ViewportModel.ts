export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

export interface ViewportModelOptions {
  readonly zoom?: number;
  readonly pan?: CanvasPoint;
}

export const MIN_CANVAS_ZOOM = 0.25;
export const MAX_CANVAS_ZOOM = 4;

export class ViewportModel {
  readonly zoom: number;
  readonly pan: CanvasPoint;

  constructor(options: ViewportModelOptions = {}) {
    this.zoom = clampZoom(options.zoom ?? 1);
    const pan = options.pan ?? { x: 0, y: 0 };
    this.pan = Object.freeze({ x: finiteOrZero(pan.x), y: finiteOrZero(pan.y) });
  }

  panelToScreen(point: CanvasPoint): CanvasPoint {
    return {
      x: point.x * this.zoom + this.pan.x,
      y: point.y * this.zoom + this.pan.y,
    };
  }

  screenToPanel(point: CanvasPoint): CanvasPoint {
    return {
      x: (point.x - this.pan.x) / this.zoom,
      y: (point.y - this.pan.y) / this.zoom,
    };
  }

  zoomAt(zoom: number, screenAnchor: CanvasPoint): ViewportModel {
    const nextZoom = clampZoom(zoom);
    const panelAnchor = this.screenToPanel(screenAnchor);
    return new ViewportModel({
      zoom: nextZoom,
      pan: {
        x: cleanNumber(screenAnchor.x - panelAnchor.x * nextZoom),
        y: cleanNumber(screenAnchor.y - panelAnchor.y * nextZoom),
      },
    });
  }

  panBy(delta: CanvasPoint): ViewportModel {
    return new ViewportModel({
      zoom: this.zoom,
      pan: { x: this.pan.x + delta.x, y: this.pan.y + delta.y },
    });
  }

  fit(panel: CanvasSize, viewport: CanvasSize, padding = 0): ViewportModel {
    if (!positiveFinite(panel.width) || !positiveFinite(panel.height)) return this;
    if (!positiveFinite(viewport.width) || !positiveFinite(viewport.height)) return this;
    const inset = Number.isFinite(padding) && padding > 0 ? padding : 0;
    const availableWidth = Math.max(0, viewport.width - inset * 2);
    const availableHeight = Math.max(0, viewport.height - inset * 2);
    const zoom = clampZoom(Math.min(availableWidth / panel.width, availableHeight / panel.height));
    return new ViewportModel({
      zoom,
      pan: {
        x: (viewport.width - panel.width * zoom) / 2,
        y: (viewport.height - panel.height * zoom) / 2,
      },
    });
  }
}

function clampZoom(zoom: number): number {
  const finite = Number.isFinite(zoom) ? zoom : 1;
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, finite));
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function cleanNumber(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
