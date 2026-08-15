import { describe, expect, it } from 'vitest';
import { ViewportModel } from './ViewportModel';

describe('ViewportModel', () => {
  it('round-trips panel and screen coordinates under pan and zoom', () => {
    const viewport = new ViewportModel({ zoom: 1.5, pan: { x: 40, y: -12 } });
    const point = { x: 240, y: 160 };
    expect(viewport.screenToPanel(viewport.panelToScreen(point))).toEqual(point);
  });

  it('keeps the panel point beneath the cursor fixed while zooming and clamps zoom', () => {
    const viewport = new ViewportModel({ zoom: 1, pan: { x: 30, y: -20 } });
    const cursor = { x: 330, y: 180 };
    const panelPoint = viewport.screenToPanel(cursor);

    const zoomed = viewport.zoomAt(8, cursor);

    expect(zoomed.zoom).toBe(4);
    expect(zoomed.screenToPanel(cursor)).toEqual(panelPoint);
    expect(zoomed.panelToScreen(panelPoint)).toEqual(cursor);
  });

  it('fits a panel inside the viewport with padding and supports exact panning', () => {
    const fitted = new ViewportModel().fit(
      { width: 1_000, height: 500 },
      { width: 600, height: 400 },
      20,
    );

    expect(fitted.zoom).toBe(0.56);
    expect(fitted.pan).toEqual({ x: 20, y: 60 });
    expect(fitted.panBy({ x: 15, y: -8 }).pan).toEqual({ x: 35, y: 52 });
  });
});
