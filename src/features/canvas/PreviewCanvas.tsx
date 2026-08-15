import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { Maximize2, RotateCw, Scan } from 'lucide-react';
import type {
  EditorElement,
  EditorNodeId,
  MeasurePreviewText,
  PreviewFrame,
  PreviewSize,
  TextMeasurementContext,
} from '../../core/adapter/types';
import type { EditorStore } from '../../core/store/EditorStore';
import { CanvasOverlay } from './CanvasOverlay';
import { ViewportModel } from './ViewportModel';

export interface PreviewCanvasProps {
  readonly store: EditorStore;
  readonly resolveAsset?: (path: string, form: 'url' | 'resource') => string | null;
  readonly measureText?: MeasurePreviewText;
}

const DEFAULT_PANEL_SIZE = Object.freeze({ width: 640, height: 480 });
const FIT_PADDING = 24;
const PSEUDO_STATES = Object.freeze([
  'hover', 'active', 'focus', 'disabled', 'checked', 'selected', 'inactive',
] as const);
type PseudoState = typeof PSEUDO_STATES[number];

const PRESETS = Object.freeze({
  desktop: { width: 1280, height: 720 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
});

export function PreviewCanvas({
  store,
  resolveAsset = defaultResolveAsset,
  measureText = defaultMeasureText,
}: PreviewCanvasProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const session = snapshot.session;
  const sessionDocument = session?.document ?? null;
  const rendererRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<PreviewFrame | null>(null);
  const generationRef = useRef(0);
  const panGestureRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [panelSize, setPanelSize] = useState<PreviewSize>(DEFAULT_PANEL_SIZE);
  const [widthDraft, setWidthDraft] = useState(String(DEFAULT_PANEL_SIZE.width));
  const [heightDraft, setHeightDraft] = useState(String(DEFAULT_PANEL_SIZE.height));
  const [preset, setPreset] = useState('custom');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoveredNodeId, setHoveredNodeId] = useState<EditorNodeId | null>(null);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [statesByNode, setStatesByNode] = useState<ReadonlyMap<EditorNodeId, ReadonlySet<PseudoState>>>(new Map());

  const selectedNodeId = snapshot.selection[0] ?? null;
  const selectedParentNodeId = sessionDocument === null || selectedNodeId === null
    ? null
    : parentNodeId(sessionDocument.root, selectedNodeId);
  const selectedStates = selectedNodeId === null ? undefined : statesByNode.get(selectedNodeId);
  const selectedSelector = sessionDocument === null || selectedNodeId === null
    ? null
    : narrowStateSelector(sessionDocument.root, selectedNodeId);
  const renderStates = useMemo(
    () => sessionDocument === null ? undefined : stateOptions(sessionDocument.root, statesByNode),
    [sessionDocument, statesByNode],
  );

  useEffect(() => {
    const container = rendererRef.current;
    const generation = ++generationRef.current;
    let cancelled = false;

    frameRef.current?.dispose();
    frameRef.current = null;
    setFrame(null);
    setHoveredNodeId(null);
    setRenderError(null);
    container?.replaceChildren();
    if (session === null || sessionDocument === null) {
      store.dispatch({ type: 'diagnostics/set', diagnostics: [] });
      return;
    }
    store.dispatch({ type: 'diagnostics/set', diagnostics: session.diagnostics });
    if (container === null) return;

    let rendering: Promise<PreviewFrame>;
    try {
      rendering = session.adapter.render(sessionDocument, container, {
        size: panelSize,
        resolveAsset,
        measureText,
        ...(renderStates === undefined ? {} : { states: renderStates }),
      });
    } catch (error) {
      setRenderError(errorMessage(error));
      return;
    }

    void rendering.then((nextFrame) => {
      if (cancelled || generation !== generationRef.current) {
        nextFrame.dispose();
        return;
      }
      frameRef.current = nextFrame;
      setFrame(nextFrame);
      store.dispatch({
        type: 'diagnostics/set',
        diagnostics: [...session.diagnostics, ...nextFrame.diagnostics],
      });
    }).catch((error: unknown) => {
      if (cancelled || generation !== generationRef.current) return;
      setRenderError(errorMessage(error));
      store.dispatch({ type: 'diagnostics/set', diagnostics: session.diagnostics });
    });

    return () => {
      cancelled = true;
      generationRef.current += 1;
      frameRef.current?.dispose();
      frameRef.current = null;
    };
  }, [measureText, panelSize, renderStates, resolveAsset, session, sessionDocument, store]);

  const nodeForTarget = (target: EventTarget | null): EditorNodeId | null => {
    if (frameRef.current === null || !(target instanceof Element)) return null;
    let element: Element | null = target;
    while (element !== null && element !== rendererRef.current) {
      const nodeId = frameRef.current.nodeForElement(element);
      if (nodeId !== null) return nodeId;
      element = element.parentElement;
    }
    return null;
  };

  const selectRenderedElement = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (session === null) return;
    const nodeId = nodeForTarget(event.target);
    if (nodeId === null) return;
    const locator = session.locatorFor(nodeId);
    if (locator === null) return;
    session.setSelection([locator]);
    store.dispatch({ type: 'session/sync' });
    if (frameRef.current !== null) {
      store.dispatch({
        type: 'diagnostics/set',
        diagnostics: [...session.diagnostics, ...frameRef.current.diagnostics],
      });
    }
  };

  const choosePreset = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setPreset(value);
    if (value !== 'custom') setPanel(PRESETS[value as keyof typeof PRESETS]);
  };

  const commitDimension = (axis: 'width' | 'height') => {
    const value = Number(axis === 'width' ? widthDraft : heightDraft);
    if (!positiveFinite(value)) return;
    setPreset('custom');
    setPanelSize((current) => ({ ...current, [axis]: value }));
  };

  const fitCanvas = () => {
    const bounds = fieldRef.current?.getBoundingClientRect();
    if (bounds === undefined) return;
    const fitted = new ViewportModel({ zoom: snapshot.zoom, pan }).fit(
      panelSize,
      { width: bounds.width, height: bounds.height },
      FIT_PADDING,
    );
    setPan(fitted.pan);
    store.dispatch({ type: 'zoom/set', zoom: fitted.zoom });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const requested = event.deltaY < 0 ? snapshot.zoom * 1.1 : snapshot.zoom / 1.1;
    const zoom = Math.round(requested * 100) / 100;
    const next = new ViewportModel({ zoom: snapshot.zoom, pan }).zoomAt(zoom, anchor);
    setPan(next.pan);
    store.dispatch({ type: 'zoom/set', zoom: next.zoom });
  };

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (snapshot.activeTool !== 'pan' && event.button !== 1) return;
    panGestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = panGestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    panGestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setPan((current) => ({ x: current.x + dx, y: current.y + dy }));
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panGestureRef.current?.pointerId !== event.pointerId) return;
    panGestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const toggleState = (state: PseudoState) => {
    if (selectedNodeId === null || selectedSelector === null) return;
    setStatesByNode((current) => {
      const next = new Map(current);
      const states = new Set(next.get(selectedNodeId) ?? []);
      if (states.has(state)) states.delete(state);
      else states.add(state);
      if (states.size === 0) next.delete(selectedNodeId);
      else next.set(selectedNodeId, states);
      return next;
    });
  };

  return (
    <section className="workspace-pane workspace-pane--canvas" data-testid="canvas-pane" aria-labelledby="canvas-heading">
      <h2 id="canvas-heading">Canvas</h2>
      <div className="canvas-toolbar" aria-label="Canvas controls">
        <label className="canvas-control canvas-control--preset">
          <span>Preset</span>
          <select aria-label="Device preset" value={preset} onChange={choosePreset}>
            <option value="custom">Custom</option>
            <option value="desktop">Desktop 1280 x 720</option>
            <option value="tablet">Tablet 768 x 1024</option>
            <option value="mobile">Mobile 390 x 844</option>
          </select>
        </label>
        <label className="canvas-control canvas-control--dimension">
          <span>W</span>
          <input aria-label="Canvas width" type="number" min="1" value={widthDraft} aria-invalid={!positiveFinite(Number(widthDraft))} onChange={(event) => setWidthDraft(event.target.value)} onBlur={() => commitDimension('width')} />
        </label>
        <label className="canvas-control canvas-control--dimension">
          <span>H</span>
          <input aria-label="Canvas height" type="number" min="1" value={heightDraft} aria-invalid={!positiveFinite(Number(heightDraft))} onChange={(event) => setHeightDraft(event.target.value)} onBlur={() => commitDimension('height')} />
        </label>
        <button type="button" className="canvas-tool-button" aria-label="Swap orientation" title="Swap orientation" onClick={() => { setPreset('custom'); setPanel({ width: panelSize.height, height: panelSize.width }); }}>
          <RotateCw aria-hidden="true" /><span>Rotate</span>
        </button>
        <button type="button" className="canvas-tool-button" aria-label="Fit canvas" title="Fit canvas" onClick={fitCanvas}>
          <Maximize2 aria-hidden="true" /><span>Fit</span>
        </button>
        <button type="button" className="canvas-tool-button" aria-label="Actual size" title="Actual size (100%)" onClick={() => store.dispatch({ type: 'zoom/set', zoom: 1 })}>
          <Scan aria-hidden="true" /><span>100%</span>
        </button>
        <label className="canvas-check canvas-check--safe">
          <input type="checkbox" checked={showSafeArea} onChange={(event) => setShowSafeArea(event.target.checked)} />
          <span>Show safe area</span>
        </label>
        <fieldset className="canvas-states" disabled={selectedSelector === null}>
          <legend>Element states</legend>
          {PSEUDO_STATES.map((state) => (
            <label key={state} className="canvas-check">
              <input type="checkbox" checked={selectedStates?.has(state) ?? false} onChange={() => toggleState(state)} />
              <span>{state[0].toUpperCase() + state.slice(1)}</span>
            </label>
          ))}
        </fieldset>
      </div>
      <div
        ref={fieldRef}
        className={`canvas-field${snapshot.activeTool === 'pan' ? ' canvas-field--pan' : ''}`}
        data-testid="canvas-field"
        onWheel={handleWheel}
        onPointerDown={beginPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {session === null && <span className="pane-empty">No document</span>}
        {renderError !== null && <div className="canvas-render-error" role="alert">Preview unavailable: {renderError}</div>}
        {session !== null && (
          <div className="canvas-transform" data-testid="canvas-transform" style={{ width: panelSize.width, height: panelSize.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${snapshot.zoom})` }}>
            <div
              ref={rendererRef}
              className="canvas-renderer"
              data-testid="canvas-renderer"
              style={{ width: panelSize.width, height: panelSize.height }}
              onClick={selectRenderedElement}
              onMouseOver={(event) => setHoveredNodeId(nodeForTarget(event.target))}
              onMouseLeave={() => setHoveredNodeId(null)}
            />
            {frame !== null && (
              <CanvasOverlay frame={frame} panelSize={panelSize} hoveredNodeId={hoveredNodeId} selectedNodeId={selectedNodeId} selectedParentNodeId={selectedParentNodeId} showSafeArea={showSafeArea} />
            )}
          </div>
        )}
      </div>
    </section>
  );

  function setPanel(size: PreviewSize) {
    setPanelSize(size);
    setWidthDraft(String(size.width));
    setHeightDraft(String(size.height));
  }
}

function parentNodeId(root: EditorElement, target: EditorNodeId): EditorNodeId | null {
  for (const child of root.children) {
    if (child.id === target) return root.id;
    const nested = parentNodeId(child, target);
    if (nested !== null) return nested;
  }
  return null;
}

function narrowStateSelector(root: EditorElement, target: EditorNodeId): string | null {
  const elements = listElements(root);
  const selected = elements.find((element) => element.id === target);
  const authoredName = selected?.attributes.find((attribute) => attribute.name === 'name')?.value;
  if (authoredName === undefined || authoredName.length === 0) return null;
  const matches = elements.filter((element) => element.attributes.some((attribute) => attribute.name === 'name' && attribute.value === authoredName));
  return matches.length === 1 ? `#${escapeSelectorIdentifier(authoredName)}` : null;
}

function stateOptions(root: EditorElement, statesByNode: ReadonlyMap<EditorNodeId, ReadonlySet<PseudoState>>): Readonly<Record<string, readonly string[]>> | undefined {
  const options: Record<string, readonly string[]> = {};
  for (const [nodeId, states] of statesByNode) {
    const selector = narrowStateSelector(root, nodeId);
    if (selector !== null && states.size > 0) options[selector] = PSEUDO_STATES.filter((state) => states.has(state));
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

function listElements(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(listElements)];
}

function escapeSelectorIdentifier(value: string): string {
  return value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0)?.toString(16)} `);
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Render failed';
}

function defaultResolveAsset(path: string): string | null {
  if (/^(?:data:|blob:|https?:|\/)/i.test(path)) return path;
  return null;
}

function defaultMeasureText(text: string, context: TextMeasurementContext, availableWidth: number) {
  const width = Math.min(Math.max(0, availableWidth), text.length * context.fontSize * 0.56);
  return { width, height: context.fontSize * 1.2 };
}
