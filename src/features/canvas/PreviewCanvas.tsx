import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceBetween,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceBetween,
  BringToFront,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Maximize2,
  RotateCw,
  Scan,
  SendToBack,
} from 'lucide-react';
import type {
  EditorElement,
  EditorNodeId,
  MeasurePreviewText,
  PreviewFrame,
  PreviewSize,
  TextMeasurementContext,
} from '../../core/adapter/types';
import type { EditorStore } from '../../core/store/EditorStore';
import {
  EDITOR_PSEUDO_STATES,
  equalActiveStateLocator,
  type EditorActiveStateEntry,
  type EditorPseudoState,
} from '../../core/store/EditorStoreContracts';
import type { DocumentSession } from '../../core/documents/DocumentSession';
import { resolveElementLocator } from '../../core/documents/ElementLocator';
import type { ClipboardPort } from '../../core/commands/ClipboardService';
import {
  layoutCommands,
  type Alignment,
  type Distribution,
  type LayoutCommandResult,
  type SourceOrder,
} from '../../core/commands/layoutCommands';
import { CanvasOverlay } from './CanvasOverlay';
import { CanvasInteractionLayer } from './CanvasInteractionLayer';
import { ManipulationController, type SnapGuide } from './ManipulationController';
import { useCanvasClipboard } from './useCanvasClipboard';
import { ViewportModel } from './ViewportModel';

export interface PreviewCanvasProps {
  readonly store: EditorStore;
  readonly resolveAsset?: (path: string, form: 'url' | 'resource') => string | null;
  readonly measureText?: MeasurePreviewText;
  readonly clipboardPort?: ClipboardPort;
}

const DEFAULT_PANEL_SIZE = Object.freeze({ width: 640, height: 480 });
const FIT_PADDING = 24;
const PRESETS = Object.freeze({
  desktop: { width: 1280, height: 720 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
});

export function PreviewCanvas({
  store,
  resolveAsset = defaultResolveAsset,
  measureText = defaultMeasureText,
  clipboardPort,
}: PreviewCanvasProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const session = snapshot.session;
  const sessionDocument = session?.document ?? null;
  const rendererRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<PreviewFrame | null>(null);
  const generationRef = useRef(0);
  const stateSessionRef = useRef<DocumentSession | null>(session);
  const panGestureRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const manipulationRef = useRef<{ pointerId: number; controller: ManipulationController } | null>(null);
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [panelSize, setPanelSize] = useState<PreviewSize>(DEFAULT_PANEL_SIZE);
  const [widthDraft, setWidthDraft] = useState(String(DEFAULT_PANEL_SIZE.width));
  const [heightDraft, setHeightDraft] = useState(String(DEFAULT_PANEL_SIZE.height));
  const [preset, setPreset] = useState('custom');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoveredNodeId, setHoveredNodeId] = useState<EditorNodeId | null>(null);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [interactionDiagnostic, setInteractionDiagnostic] = useState<string | null>(null);
  const [snapGuides, setSnapGuides] = useState<readonly SnapGuide[]>(Object.freeze([]));

  const selectedNodeId = snapshot.selection[0] ?? null;
  const selectedNodes = sessionDocument === null
    ? []
    : snapshot.selection.flatMap((nodeId) => {
      const node = elementById(sessionDocument.root, nodeId);
      return node === null ? [] : [node];
    });
  const selectedParentNodeId = sessionDocument === null || selectedNodeId === null
    ? null
    : parentNodeId(sessionDocument.root, selectedNodeId);
  const selectedLocator = session === null || selectedNodeId === null ? null : session.locatorFor(selectedNodeId);
  const selectedStates = selectedLocator === null
    ? undefined
    : snapshot.activeStates.find((entry) => equalActiveStateLocator(entry.locator, selectedLocator))?.states;
  const selectedSelector = sessionDocument === null || selectedNodeId === null
    ? null
    : narrowStateSelector(sessionDocument.root, selectedNodeId);
  const renderStates = useMemo(
    () => session === null || sessionDocument === null ? undefined : stateOptions(sessionDocument.root, snapshot.activeStates),
    [session, sessionDocument, snapshot.activeStates],
  );
  const stateControlDescription = selectedNodeId !== null && selectedSelector === null
    ? 'A unique authored name is required for pseudo states.'
    : null;
  const clipboard = useCanvasClipboard({
    store,
    session,
    selectedNodes,
    clipboardPort,
    onDiagnostic: setInteractionDiagnostic,
    onCommit: syncAfterMutation,
  });

  useEffect(() => {
    if (stateSessionRef.current === session) return;
    const manipulation = manipulationRef.current;
    manipulation?.controller.cancel();
    manipulationRef.current = null;
    panGestureRef.current = null;
    if (manipulation !== null) {
      try { fieldRef.current?.releasePointerCapture?.(manipulation.pointerId); } catch { /* Capture may already be released. */ }
    }
    setSnapGuides(Object.freeze([]));
    setInteractionDiagnostic(null);
    stateSessionRef.current = session;
  }, [session]);

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
    if (event.detail !== 0) return;
    if (session === null) return;
    const nodeId = nodeForTarget(event.target);
    if (nodeId === null) return;
    selectNode(session, nodeId, event.shiftKey);
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

  const beginPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (snapshot.activeTool === 'pan' || event.button === 1) {
      panGestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.button !== 0 || session === null || frameRef.current === null) return;
    const nodeId = nodeForTarget(event.target);
    const node = nodeId === null ? null : elementById(session.document.root, nodeId);
    if (node === null) return;
    selectNode(session, node.id, event.shiftKey);
    const controller = new ManipulationController(session, frameRef.current, { onCommit: syncAfterMutation });
    const started = controller.start(node, canvasPoint(event.clientX, event.clientY));
    if (!started.ok) {
      setInteractionDiagnostic(started.diagnostic.message);
      return;
    }
    setInteractionDiagnostic(null);
    manipulationRef.current = { pointerId: event.pointerId, controller };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const movePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = panGestureRef.current;
    if (gesture !== null && gesture.pointerId === event.pointerId) {
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      panGestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      setPan((current) => new ViewportModel({ zoom: snapshot.zoom, pan: current }).panBy({ x: dx, y: dy }).pan);
      return;
    }
    const manipulation = manipulationRef.current;
    if (manipulation === null || manipulation.pointerId !== event.pointerId) return;
    const result = manipulation.controller.update(canvasPoint(event.clientX, event.clientY));
    if (!result.ok) {
      setInteractionDiagnostic(result.diagnostic.message);
      setSnapGuides(Object.freeze([]));
    } else {
      setInteractionDiagnostic(null);
      setSnapGuides(result.guides ?? Object.freeze([]));
    }
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    let handled = false;
    if (panGestureRef.current?.pointerId === event.pointerId) {
      panGestureRef.current = null;
      handled = true;
    }
    if (manipulationRef.current?.pointerId === event.pointerId) {
      manipulationRef.current.controller.finish();
      manipulationRef.current = null;
      setSnapGuides(Object.freeze([]));
      handled = true;
    }
    if (handled) event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const node = selectedNodes.length === 1 ? selectedNodes[0] : null;
    if (session === null || node === null || frameRef.current === null || fieldRef.current === null) return;
    const controller = new ManipulationController(session, frameRef.current, { onCommit: syncAfterMutation });
    const started = controller.startResize(node, canvasPoint(event.clientX, event.clientY));
    if (!started.ok) {
      setInteractionDiagnostic(started.diagnostic.message);
      return;
    }
    manipulationRef.current = { pointerId: event.pointerId, controller };
    fieldRef.current.setPointerCapture?.(event.pointerId);
    setInteractionDiagnostic(null);
    event.preventDefault();
    event.stopPropagation();
  };

  const handleNudge = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = arrowDelta(event.key);
    if (direction === null || session === null || selectedNodes.length === 0) return;
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    executeLayout(layoutCommands.nudge(session, selectedNodes, {
      x: direction.x * amount,
      y: direction.y * amount,
    }));
  };

  const alignSelection = (alignment: Alignment) => {
    if (session === null || frameRef.current === null) return;
    executeLayout(layoutCommands.align(session, selectedNodes, alignment, frameRef.current));
  };

  const distributeSelection = (direction: Distribution) => {
    if (session === null || frameRef.current === null) return;
    executeLayout(layoutCommands.distribute(session, selectedNodes, direction, frameRef.current));
  };

  const orderSelection = (destination: SourceOrder) => {
    if (session === null) return;
    executeLayout(layoutCommands.order(session, selectedNodes, destination));
  };

  const toggleState = (state: EditorPseudoState) => {
    if (session === null || selectedLocator === null || selectedSelector === null) return;
    store.dispatch({ type: 'active-states/toggle', locator: selectedLocator, state });
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
        <div className="canvas-command-group" role="group" aria-label="Alignment commands">
          <CommandButton label="Align left" disabled={selectedNodes.length < 2} onClick={() => alignSelection('left')}><AlignHorizontalJustifyStart /></CommandButton>
          <CommandButton label="Align horizontal centers" disabled={selectedNodes.length < 2} onClick={() => alignSelection('horizontal-center')}><AlignHorizontalJustifyCenter /></CommandButton>
          <CommandButton label="Align right" disabled={selectedNodes.length < 2} onClick={() => alignSelection('right')}><AlignHorizontalJustifyEnd /></CommandButton>
          <CommandButton label="Align top" disabled={selectedNodes.length < 2} onClick={() => alignSelection('top')}><AlignVerticalJustifyStart /></CommandButton>
          <CommandButton label="Align vertical centers" disabled={selectedNodes.length < 2} onClick={() => alignSelection('vertical-center')}><AlignVerticalJustifyCenter /></CommandButton>
          <CommandButton label="Align bottom" disabled={selectedNodes.length < 2} onClick={() => alignSelection('bottom')}><AlignVerticalJustifyEnd /></CommandButton>
          <CommandButton label="Distribute horizontally" disabled={selectedNodes.length < 3} onClick={() => distributeSelection('horizontal')}><AlignHorizontalSpaceBetween /></CommandButton>
          <CommandButton label="Distribute vertically" disabled={selectedNodes.length < 3} onClick={() => distributeSelection('vertical')}><AlignVerticalSpaceBetween /></CommandButton>
        </div>
        <div className="canvas-command-group" role="group" aria-label="Ordering and clipboard commands">
          <CommandButton label="Bring to front" disabled={selectedNodes.length === 0} onClick={() => orderSelection('front')}><BringToFront /></CommandButton>
          <CommandButton label="Send to back" disabled={selectedNodes.length === 0} onClick={() => orderSelection('back')}><SendToBack /></CommandButton>
          <CommandButton label="Copy selection" disabled={selectedNodes.length === 0} onClick={() => { void clipboard.copy(); }}><Copy /></CommandButton>
          <CommandButton label="Paste" disabled={session === null} onClick={() => { void clipboard.paste(); }}><ClipboardPaste /></CommandButton>
          <CommandButton label="Duplicate selection" disabled={selectedNodes.length === 0} onClick={() => { void clipboard.duplicate(); }}><CopyPlus /></CommandButton>
        </div>
        <label className="canvas-check canvas-check--safe">
          <input type="checkbox" checked={showSafeArea} onChange={(event) => setShowSafeArea(event.target.checked)} />
          <span>Show safe area</span>
        </label>
        <fieldset className="canvas-states" disabled={selectedSelector === null} aria-describedby={stateControlDescription === null ? undefined : 'canvas-state-description'}>
          <legend>Element states</legend>
          {EDITOR_PSEUDO_STATES.map((state) => (
            <label key={state} className="canvas-check">
              <input type="checkbox" checked={selectedStates?.includes(state) ?? false} onChange={() => toggleState(state)} />
              <span>{state[0].toUpperCase() + state.slice(1)}</span>
            </label>
          ))}
        </fieldset>
        {stateControlDescription !== null && <p id="canvas-state-description" role="status">{stateControlDescription}</p>}
        {interactionDiagnostic !== null && <p className="canvas-interaction-status" role="status">{interactionDiagnostic}</p>}
      </div>
      <div
        ref={fieldRef}
        className={`canvas-field${snapshot.activeTool === 'pan' ? ' canvas-field--pan' : ''}`}
        data-testid="canvas-field"
        tabIndex={0}
        onWheel={handleWheel}
        onKeyDown={handleNudge}
        onPointerDown={beginPointer}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        {session === null && <span className="pane-empty">No document</span>}
        {renderError !== null && <div className="canvas-render-error" role="alert">Preview unavailable: {renderError}</div>}
        {session !== null && (
          <div ref={transformRef} className="canvas-transform" data-testid="canvas-transform" style={{ width: panelSize.width, height: panelSize.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${snapshot.zoom})` }}>
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
              <>
                <CanvasOverlay frame={frame} panelSize={panelSize} hoveredNodeId={hoveredNodeId} selectedNodeId={selectedNodeId} selectedParentNodeId={selectedParentNodeId} showSafeArea={showSafeArea} />
                <CanvasInteractionLayer
                  panelSize={panelSize}
                  selectedBox={selectedNodeId === null ? null : frame.boxes.get(selectedNodeId) ?? null}
                  guides={snapGuides}
                  onResizePointerDown={beginResize}
                />
              </>
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

  function selectNode(currentSession: DocumentSession, nodeId: EditorNodeId, additive: boolean) {
    const locator = currentSession.locatorFor(nodeId);
    if (locator === null) return;
    if (!additive) {
      currentSession.setSelection([locator]);
    } else {
      const existing = currentSession.selectedNodeIds;
      const next = existing.includes(nodeId)
        ? existing.filter((selected) => selected !== nodeId)
        : [...existing, nodeId];
      currentSession.setSelection(next.flatMap((selected) => {
        const selectedLocator = currentSession.locatorFor(selected);
        return selectedLocator === null ? [] : [selectedLocator];
      }));
    }
    syncAfterMutation();
  }

  function executeLayout(result: LayoutCommandResult) {
    if (session === null) return;
    if (!result.ok) {
      setInteractionDiagnostic(result.diagnostic.message);
      return;
    }
    try {
      session.history.execute(result.transaction);
      setInteractionDiagnostic(null);
      syncAfterMutation();
    } catch (error) {
      setInteractionDiagnostic(errorMessage(error));
    }
  }

  function syncAfterMutation(authoritativeSession: DocumentSession | null = session) {
    if (authoritativeSession === null || store.getSnapshot().session !== authoritativeSession) return;
    store.dispatch({ type: 'session/sync' });
    const currentFrame = frameRef.current;
    store.dispatch({
      type: 'diagnostics/set',
      diagnostics: currentFrame === null
        ? authoritativeSession.diagnostics
        : [...authoritativeSession.diagnostics, ...currentFrame.diagnostics],
    });
  }

  function canvasPoint(clientX: number, clientY: number) {
    const bounds = transformRef.current?.getBoundingClientRect();
    if (bounds === undefined) return { x: clientX, y: clientY };
    return {
      x: (clientX - bounds.left) / snapshot.zoom,
      y: (clientY - bounds.top) / snapshot.zoom,
    };
  }
}

interface CommandButtonProps {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function CommandButton({ label, disabled, onClick, children }: CommandButtonProps) {
  return (
    <button type="button" className="canvas-tool-button canvas-tool-button--icon" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function parentNodeId(root: EditorElement, target: EditorNodeId): EditorNodeId | null {
  for (const child of root.children) {
    if (child.id === target) return root.id;
    const nested = parentNodeId(child, target);
    if (nested !== null) return nested;
  }
  return null;
}

function elementById(root: EditorElement, target: EditorNodeId): EditorElement | null {
  if (root.id === target) return root;
  for (const child of root.children) {
    const nested = elementById(child, target);
    if (nested !== null) return nested;
  }
  return null;
}

function arrowDelta(key: string): { readonly x: number; readonly y: number } | null {
  if (key === 'ArrowLeft') return { x: -1, y: 0 };
  if (key === 'ArrowRight') return { x: 1, y: 0 };
  if (key === 'ArrowUp') return { x: 0, y: -1 };
  if (key === 'ArrowDown') return { x: 0, y: 1 };
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

function stateOptions(root: EditorElement, entries: readonly EditorActiveStateEntry[]): Readonly<Record<string, readonly string[]>> | undefined {
  const options: Record<string, readonly string[]> = {};
  for (const { locator, states } of entries) {
    const nodeId = resolveElementLocator(root, locator);
    if (nodeId === null) continue;
    const selector = narrowStateSelector(root, nodeId);
    if (selector !== null && states.length > 0) {
      options[selector] = EDITOR_PSEUDO_STATES.filter((state) => states.includes(state));
    }
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

function listElements(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(listElements)];
}

function escapeSelectorIdentifier(value: string): string {
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) {
      escaped += '\uFFFD';
    } else if (
      (codeUnit >= 1 && codeUnit <= 31)
      || codeUnit === 127
      || (index === 0 && codeUnit >= 48 && codeUnit <= 57)
      || (index === 1 && value.charCodeAt(0) === 45 && codeUnit >= 48 && codeUnit <= 57)
    ) {
      escaped += `\\${codeUnit.toString(16)} `;
    } else if (index === 0 && codeUnit === 45 && value.length === 1) {
      escaped += '\\-';
    } else if (
      codeUnit >= 128
      || codeUnit === 45
      || codeUnit === 95
      || (codeUnit >= 48 && codeUnit <= 57)
      || (codeUnit >= 65 && codeUnit <= 90)
      || (codeUnit >= 97 && codeUnit <= 122)
    ) {
      escaped += value[index];
    } else {
      escaped += `\\${value[index]}`;
    }
  }
  return escaped;
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
