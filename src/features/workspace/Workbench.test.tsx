import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import type { EditorDiagnostic } from '../../core/adapter/types';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../../core/documents/DocumentSession';
import { MemoryHost } from '../../core/host/MemoryHost';
import {
  DEFAULT_PANE_DIMENSIONS,
  type EditorLayoutStorage,
} from '../../core/store/EditorLayoutStorage';
import { EditorStore } from '../../core/store/EditorStore';
import { Workbench } from './Workbench';

class RecordingLayoutStorage implements EditorLayoutStorage {
  value: string | null = null;
  writes: string[] = [];

  getItem(): string | null {
    return this.value;
  }

  setItem(_key: string, value: string): void {
    this.value = value;
    this.writes.push(value);
  }
}

describe('Workbench regions and command bar', () => {
  it.each([
    ['desktop', 1366],
    ['compact', 720],
  ])('mounts the interactive preview canvas in %s layout', (mode, width) => {
    render(<Workbench store={new EditorStore({ viewport: { width, height: 768 } })} />);

    expect(screen.getByTestId('canvas-pane')).toBeVisible();
    expect(screen.getByLabelText('Device preset')).toBeVisible();
    expect(screen.getByTestId('canvas-field')).toBeVisible();
    expect(screen.getByRole('application')).toHaveAttribute('data-layout-mode', mode);
  });

  it('renders the dense five-region desktop workbench with all separators', () => {
    const store = new EditorStore({ viewport: { width: 1024, height: 768 } });

    render(<Workbench store={store} />);

    expect(screen.getByTestId('commandbar')).toBeVisible();
    expect(screen.getByTestId('left-pane')).toBeVisible();
    expect(screen.getByTestId('canvas-pane')).toBeVisible();
    expect(screen.getByTestId('right-pane')).toBeVisible();
    expect(screen.getByTestId('bottom-pane')).toBeVisible();
    expect(screen.getAllByRole('separator')).toHaveLength(3);
    expect(screen.getByRole('tablist', { name: 'Bottom views' })).toBeVisible();
  });

  it('does not publish component-authored geometry as a test-only DOM contract', () => {
    render(<Workbench store={new EditorStore({ viewport: { width: 1024, height: 768 } })} />);

    expect(document.querySelector('[data-layout-top]')).toBeNull();
    expect(document.querySelector('[data-layout-height]')).toBeNull();
    expect(document.querySelector('[data-layout-width]')).toBeNull();
  });

  it('exposes stable square icon commands with tooltips, focusability, and initial disabled states', () => {
    render(<Workbench store={new EditorStore()} />);

    const open = screen.getByRole('button', { name: 'Open project' });
    const undo = screen.getByRole('button', { name: 'Undo' });
    const redo = screen.getByRole('button', { name: 'Redo' });
    expect(open).toBeDisabled();
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();
    expect(open).toHaveAttribute('title', 'Open project');
    expect(undo).toHaveAttribute('title', 'Undo');
    expect(redo).toHaveAttribute('title', 'Redo');
    expect(open).toHaveAttribute('data-control-shape', 'square');
    expect(open.querySelector('svg.lucide-folder-open')).toBeInTheDocument();
    expect(undo.querySelector('svg.lucide-undo-2')).toBeInTheDocument();
    expect(redo.querySelector('svg.lucide-redo-2')).toBeInTheDocument();

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    zoomIn.focus();
    expect(zoomIn).toHaveFocus();
  });

  it('updates disabled file and history commands as host/session availability changes', async () => {
    const user = userEvent.setup();
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': '<UXML />' } }],
    });
    const chooseProject = vi.spyOn(host, 'chooseProject');
    const session = openSession();
    session.history.execute({
      id: 'rename-control',
      label: 'Rename control',
      patchesByFile: new Map([['Assets/UI/Main.uxml', [{ start: 7, end: 13, replacement: 'Label' }]]]),
    });
    const store = new EditorStore();
    render(<Workbench store={store} />);

    act(() => store.dispatch({ type: 'context/set', host, session }));
    const open = screen.getByRole('button', { name: 'Open project' });
    const undo = screen.getByRole('button', { name: 'Undo' });
    const redo = screen.getByRole('button', { name: 'Redo' });
    expect(open).toBeEnabled();
    expect(undo).toBeEnabled();
    expect(redo).toBeDisabled();

    await user.click(open);
    expect(chooseProject).toHaveBeenCalledTimes(1);
    await user.click(undo);
    expect(undo).toBeDisabled();
    expect(redo).toBeEnabled();
  });

  it('wires zoom, tool, preview, and panel controls to observable store state', async () => {
    const user = userEvent.setup();
    const store = new EditorStore();
    render(<Workbench store={store} />);

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    expect(zoomIn).toHaveAttribute('title', 'Zoom in');
    expect(screen.getByLabelText('Canvas zoom')).toHaveTextContent('100%');
    await user.click(zoomIn);
    expect(store.getSnapshot().zoom).toBe(1.1);
    expect(screen.getByLabelText('Canvas zoom')).toHaveTextContent('110%');

    await user.click(screen.getByRole('button', { name: 'Pan tool' }));
    expect(store.getSnapshot().activeTool).toBe('pan');
    expect(screen.getByRole('button', { name: 'Pan tool' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(store.getSnapshot().previewState).toBe('preview');
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Show inspector' }));
    expect(store.getSnapshot().activePanel).toBe('inspector');

    act(() => store.dispatch({ type: 'zoom/set', zoom: 4 }));
    expect(zoomIn).toBeDisabled();
  });

  it('activates and focuses each visible desktop pane from its panel command', async () => {
    const user = userEvent.setup();
    const store = new EditorStore({ viewport: { width: 1024, height: 768 } });
    render(<Workbench store={store} />);
    const cases = [
      { panel: 'inspector', command: 'Show inspector', testId: 'right-pane' },
      { panel: 'diagnostics', command: 'Show diagnostics', testId: 'bottom-pane' },
      { panel: 'hierarchy', command: 'Show hierarchy', testId: 'left-pane' },
    ] as const;

    for (const item of cases) {
      const command = screen.getByRole('button', { name: item.command });
      await user.click(command);
      const pane = screen.getByTestId(item.testId);

      expect(store.getSnapshot().activePanel).toBe(item.panel);
      expect(command).toHaveAttribute('aria-pressed', 'true');
      expect(pane).toHaveAttribute('tabindex', '-1');
      expect(pane).toHaveAttribute('data-active', 'true');
      expect(pane).toHaveAttribute('aria-current', 'true');
      expect(pane).toHaveFocus();
    }
  });

  it('keeps deterministic canvas tracks stable when diagnostics change', () => {
    const store = new EditorStore({ viewport: { width: 1920, height: 1080 } });
    render(<Workbench store={store} />);
    const workbench = screen.getByRole('application', { name: 'UXML Editor' });
    const before = {
      left: workbench.style.getPropertyValue('--workbench-left-pane'),
      right: workbench.style.getPropertyValue('--workbench-right-pane'),
      bottom: workbench.style.getPropertyValue('--workbench-bottom-pane'),
    };
    const diagnostic: EditorDiagnostic = {
      origin: 'render',
      severity: 'warning',
      kind: 'unsupported-property',
      message: 'Unsupported property',
    };

    act(() => store.dispatch({ type: 'diagnostics/set', diagnostics: [diagnostic] }));

    expect(screen.getByText('Unsupported property')).toBeVisible();
    expect({
      left: workbench.style.getPropertyValue('--workbench-left-pane'),
      right: workbench.style.getPropertyValue('--workbench-right-pane'),
      bottom: workbench.style.getPropertyValue('--workbench-bottom-pane'),
    }).toEqual(before);
    expect(before).toEqual({ left: '240px', right: '280px', bottom: '180px' });
  });

  it('retains diagnostics and source in one desktop bottom region and opens a diagnostic at its source', async () => {
    const user = userEvent.setup();
    const source = '<UXML><FancyChart name="chart" /></UXML>';
    const session = DocumentSession.open(
      new Map([['Assets/UI/Main.uxml', source]]),
      'Assets/UI/Main.uxml',
      new UxmlPreviewAdapter(),
    );
    const store = new EditorStore({ session, viewport: { width: 1024, height: 768 } });
    render(<Workbench store={store} />);
    const chart = session.document.root.children[0];
    act(() => store.dispatch({
      type: 'diagnostics/set',
      diagnostics: [{
        origin: 'parse',
        severity: 'warning',
        kind: 'unsupported-control',
        message: 'Unsupported FancyChart',
        nodeId: chart.id,
        source: chart.source,
      }],
    }));

    const bottom = screen.getByTestId('bottom-pane');
    expect(screen.getByRole('tab', { name: 'Diagnostics' })).toHaveAttribute('aria-selected', 'true');
    expect(bottom.querySelectorAll('.workspace-pane')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /unsupported FancyChart/i }));

    expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Assets/UI/Main.uxml source' })).toBeVisible();
    expect(store.getSnapshot().selection).toHaveLength(1);
    expect(screen.getAllByTestId('bottom-pane')).toHaveLength(1);
  });

  it('provides keyboard navigation between retained desktop bottom views', () => {
    const store = new EditorStore({ session: openSession(), viewport: { width: 1024, height: 768 } });
    render(<Workbench store={store} />);
    const diagnostics = screen.getByRole('tab', { name: 'Diagnostics' });
    const source = screen.getByRole('tab', { name: 'Source' });

    diagnostics.focus();
    fireEvent.keyDown(diagnostics, { key: 'ArrowRight' });
    expect(source).toHaveFocus();
    expect(source).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(source, { key: 'Home' });
    expect(diagnostics).toHaveFocus();
    expect(diagnostics).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps malformed CodeMirror drafts out of session history, marks preview stale, and recovers on correction', async () => {
    const user = userEvent.setup();
    const session = openSession();
    const original = session.snapshot().files.get(session.entryPath)!.text;
    const store = new EditorStore({ session, viewport: { width: 1024, height: 768 } });
    render(<Workbench store={store} />);
    await user.click(screen.getByRole('tab', { name: 'Source' }));
    const editor = screen.getByRole('textbox', { name: `${session.entryPath} source` });
    const view = EditorView.findFromDOM(editor)!;

    act(() => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '<UXML><Button' },
    }));

    expect(await screen.findByText('Stale preview', {}, { timeout: 1500 })).toBeVisible();
    expect(screen.getByTestId('canvas-field')).toHaveAttribute('data-source-status', 'stale');
    expect(screen.getByRole('button', { name: 'Paste' })).toBeDisabled();
    expect(session.snapshot().files.get(session.entryPath)?.text).toBe(original);
    expect(session.history.undoDepth).toBe(0);

    act(() => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: original.replace('Button', 'Label') },
    }));

    expect(await screen.findByText('Ready', {}, { timeout: 1500 })).toBeVisible();
    expect(screen.getByTestId('canvas-field')).toHaveAttribute('data-source-status', 'ready');
    expect(session.snapshot().files.get(session.entryPath)?.text).toContain('Label');
    expect(session.history.undoDepth).toBe(1);
  });

  it('disposes a pending source edit when the authoritative session is replaced', async () => {
    const user = userEvent.setup();
    const first = openSession();
    const firstOriginal = first.snapshot().files.get(first.entryPath)!.text;
    const second = DocumentSession.open(
      new Map([[first.entryPath, '<UXML><Label /></UXML>']]),
      first.entryPath,
      new UxmlPreviewAdapter(),
    );
    const store = new EditorStore({ session: first, viewport: { width: 1024, height: 768 } });
    render(<Workbench store={store} />);
    await user.click(screen.getByRole('tab', { name: 'Source' }));
    const editor = screen.getByRole('textbox', { name: `${first.entryPath} source` });
    const view = EditorView.findFromDOM(editor)!;
    act(() => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '<UXML><Button text="pending" /></UXML>' },
    }));

    act(() => store.dispatch({ type: 'context/set', session: second, host: null }));
    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(first.snapshot().files.get(first.entryPath)?.text).toBe(firstOriginal);
    expect(first.history.undoDepth).toBe(0);
    expect(screen.getByRole('textbox', { name: `${second.entryPath} source` })).toHaveTextContent('Label');
  });
});

describe('PaneResizer behavior', () => {
  it('captures pointer movement, clamps it, and persists only the final dimensions', () => {
    const storage = new RecordingLayoutStorage();
    const store = new EditorStore({ storage, viewport: { width: 1366, height: 768 } });
    render(<Workbench store={store} />);
    const separator = screen.getByTestId('left-resizer');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(separator, {
      setPointerCapture: { value: setPointerCapture },
      releasePointerCapture: { value: releasePointerCapture },
    });

    fireEvent.pointerDown(separator, {
      pointerId: 7,
      button: 0,
      isPrimary: true,
      clientX: 240,
      clientY: 100,
    });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 500, clientY: 100 });
    expect(store.getSnapshot().panes.left).toBe(420);
    expect(storage.writes).toHaveLength(0);

    fireEvent.pointerUp(window, { pointerId: 7, clientX: 500, clientY: 100 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(storage.writes).toHaveLength(1);
    expect(JSON.parse(storage.writes[0])).toEqual({
      version: 1,
      panes: { left: 420, right: 280, bottom: 180 },
    });
  });

  it('supports directional arrows, Home, and End with current separator values', () => {
    const storage = new RecordingLayoutStorage();
    const store = new EditorStore({ storage });
    render(<Workbench store={store} />);
    const left = screen.getByTestId('left-resizer');

    expect(left).toHaveAttribute('role', 'separator');
    expect(left).toHaveAttribute('aria-orientation', 'vertical');
    expect(left).toHaveAttribute('aria-valuemin', '160');
    expect(left).toHaveAttribute('aria-valuemax', '420');
    expect(left).toHaveAttribute('aria-valuenow', '240');

    fireEvent.keyDown(left, { key: 'ArrowRight' });
    expect(store.getSnapshot().panes.left).toBe(248);
    expect(left).toHaveAttribute('aria-valuenow', '248');
    fireEvent.keyDown(left, { key: 'Home' });
    expect(store.getSnapshot().panes.left).toBe(160);
    fireEvent.keyDown(left, { key: 'End' });
    expect(store.getSnapshot().panes.left).toBe(420);
    expect(storage.writes).toHaveLength(3);
  });

  it('uses visual directions for right and bottom separator keyboard movement', () => {
    const store = new EditorStore();
    render(<Workbench store={store} />);

    fireEvent.keyDown(screen.getByTestId('right-resizer'), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByTestId('bottom-resizer'), { key: 'ArrowUp' });

    expect(store.getSnapshot().panes.right).toBe(288);
    expect(store.getSnapshot().panes.bottom).toBe(188);
  });

  it('rejects non-primary pointers without capture, movement, or persistence', () => {
    const storage = new RecordingLayoutStorage();
    const store = new EditorStore({ storage });
    render(<Workbench store={store} />);
    const separator = screen.getByTestId('left-resizer');
    const setPointerCapture = vi.fn();
    Object.defineProperty(separator, 'setPointerCapture', { value: setPointerCapture });

    fireEvent.pointerDown(separator, {
      pointerId: 8,
      button: 0,
      isPrimary: false,
      clientX: 240,
    });
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 360 });
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 360 });

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(store.getSnapshot().panes.left).toBe(240);
    expect(storage.writes).toHaveLength(0);
  });

  it('abandons failed capture without listeners and accepts the next primary drag', () => {
    const storage = new RecordingLayoutStorage();
    const store = new EditorStore({ storage });
    render(<Workbench store={store} />);
    const separator = screen.getByTestId('left-resizer');
    const addEventListener = vi.spyOn(window, 'addEventListener');
    Object.defineProperty(separator, 'setPointerCapture', {
      value: vi.fn()
        .mockImplementationOnce(() => { throw new Error('capture denied'); })
        .mockImplementationOnce(() => undefined),
    });

    expect(() => fireEvent.pointerDown(separator, {
      pointerId: 9,
      button: 0,
      isPrimary: true,
      clientX: 240,
    })).not.toThrow();
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 360 });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 360 });

    expect(store.getSnapshot().panes.left).toBe(240);
    expect(storage.writes).toHaveLength(0);
    expect(addEventListener.mock.calls.filter(([type]) => String(type).startsWith('pointer'))).toHaveLength(0);

    fireEvent.pointerDown(separator, {
      pointerId: 10,
      button: 0,
      isPrimary: true,
      clientX: 240,
    });
    fireEvent.pointerMove(window, { pointerId: 10, clientX: 320 });
    fireEvent.pointerUp(window, { pointerId: 10, clientX: 320 });

    expect(store.getSnapshot().panes.left).toBe(320);
    expect(storage.writes).toHaveLength(1);
    addEventListener.mockRestore();
  });

  it('uses window pointer lifecycle when capture methods are unavailable', () => {
    const storage = new RecordingLayoutStorage();
    const store = new EditorStore({ storage });
    render(<Workbench store={store} />);
    const separator = screen.getByTestId('left-resizer');

    expect(separator).not.toHaveProperty('setPointerCapture');
    expect(separator).not.toHaveProperty('releasePointerCapture');
    fireEvent.pointerDown(separator, {
      pointerId: 13,
      button: 0,
      isPrimary: true,
      clientX: 240,
    });
    fireEvent.pointerMove(window, { pointerId: 13, clientX: 300 });
    fireEvent.pointerUp(window, { pointerId: 13, clientX: 300 });

    expect(store.getSnapshot().panes.left).toBe(300);
    expect(storage.writes).toHaveLength(1);
  });

  it('ignores a second pointer while the primary drag is active', () => {
    const storage = new RecordingLayoutStorage();
    const store = new EditorStore({ storage });
    render(<Workbench store={store} />);
    const separator = screen.getByTestId('left-resizer');
    const setPointerCapture = vi.fn();
    Object.defineProperty(separator, 'setPointerCapture', { value: setPointerCapture });

    fireEvent.pointerDown(separator, {
      pointerId: 10,
      button: 0,
      isPrimary: true,
      clientX: 240,
    });
    fireEvent.pointerDown(separator, {
      pointerId: 11,
      button: 0,
      isPrimary: true,
      clientX: 240,
    });
    fireEvent.pointerMove(window, { pointerId: 11, clientX: 400 });
    expect(store.getSnapshot().panes.left).toBe(240);

    fireEvent.pointerMove(window, { pointerId: 10, clientX: 320 });
    fireEvent.pointerUp(window, { pointerId: 10, clientX: 320 });

    expect(setPointerCapture).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().panes.left).toBe(320);
    expect(storage.writes).toHaveLength(1);
  });

  it.each([
    { eventName: 'pointerup', finish: fireEvent.pointerUp },
    { eventName: 'pointercancel', finish: fireEvent.pointerCancel },
  ])('persists and cleans up after $eventName when release throws', ({ finish }) => {
    const storage = new RecordingLayoutStorage();
    const store = new EditorStore({ storage });
    render(<Workbench store={store} />);
    const separator = screen.getByTestId('left-resizer');
    const releasePointerCapture = vi.fn(() => { throw new Error('release failed'); });
    Object.defineProperties(separator, {
      setPointerCapture: { value: vi.fn() },
      releasePointerCapture: { value: releasePointerCapture },
    });

    fireEvent.pointerDown(separator, {
      pointerId: 12,
      button: 0,
      isPrimary: true,
      clientX: 240,
    });
    fireEvent.pointerMove(window, { pointerId: 12, clientX: 320 });
    expect(() => finish(window, { pointerId: 12, clientX: 320 })).not.toThrow();
    fireEvent.pointerMove(window, { pointerId: 12, clientX: 400 });

    expect(releasePointerCapture).toHaveBeenCalledWith(12);
    expect(store.getSnapshot().panes.left).toBe(320);
    expect(storage.writes).toHaveLength(1);
  });

  it('releases active capture and listeners on unmount without phantom persistence', () => {
    const storage = new RecordingLayoutStorage();
    const store = new EditorStore({ storage });
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<Workbench store={store} />);
    const separator = screen.getByTestId('left-resizer');
    const releasePointerCapture = vi.fn(() => { throw new Error('release failed during unmount'); });
    Object.defineProperties(separator, {
      setPointerCapture: { value: vi.fn() },
      releasePointerCapture: { value: releasePointerCapture },
    });

    fireEvent.pointerDown(separator, {
      pointerId: 3,
      button: 0,
      isPrimary: true,
      clientX: 240,
    });
    expect(() => unmount()).not.toThrow();
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 360 });

    expect(releasePointerCapture).toHaveBeenCalledWith(3);
    expect(store.getSnapshot().panes.left).toBe(240);
    expect(storage.writes).toHaveLength(0);
    expect(removeEventListener).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('pointercancel', expect.any(Function));
    removeEventListener.mockRestore();
  });
});

describe.each([
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1024, height: 768 },
])('desktop layout at $width x $height', ({ width, height }) => {
  it('renders all regions with stable exported track variables', () => {
    render(<Workbench store={new EditorStore({ viewport: { width, height } })} />);
    const workbench = screen.getByRole('application', { name: 'UXML Editor' });

    expect(workbench).toHaveAttribute('data-layout-mode', 'desktop');
    expect(workbench.style.getPropertyValue('--workbench-left-pane')).toBe(`${DEFAULT_PANE_DIMENSIONS.left}px`);
    expect(workbench.style.getPropertyValue('--workbench-right-pane')).toBe(`${DEFAULT_PANE_DIMENSIONS.right}px`);
    expect(workbench.style.getPropertyValue('--workbench-bottom-pane')).toBe(`${DEFAULT_PANE_DIMENSIONS.bottom}px`);
    expect(workbench.style.getPropertyValue('--workbench-commandbar')).toBe('40px');
    expect(workbench.style.getPropertyValue('--workbench-separator')).toBe('4px');
    expect(screen.getByTestId('left-pane')).toBeVisible();
    expect(screen.getByTestId('canvas-pane')).toBeVisible();
    expect(screen.getByTestId('right-pane')).toBeVisible();
    expect(screen.getByTestId('bottom-pane')).toBeVisible();
    expect(screen.getAllByRole('separator')).toHaveLength(3);
  });
});

describe('compact 720px layout', () => {
  it('adapts to compact mode when restored side tracks would starve the canvas', () => {
    const storage = new RecordingLayoutStorage();
    storage.value = JSON.stringify({
      version: 1,
      panes: { left: 420, right: 480, bottom: 180 },
    });
    const store = new EditorStore({ storage, viewport: { width: 900, height: 768 } });
    render(<Workbench store={store} />);
    const workbench = screen.getByRole('application', { name: 'UXML Editor' });

    expect(workbench).toHaveAttribute('data-layout-mode', 'compact');
    expect(screen.getByTestId('canvas-pane')).toBeVisible();
    expect(screen.getByRole('tablist', { name: 'Tool panes' })).toBeVisible();

    act(() => store.dispatch({ type: 'viewport/set', width: 1024, height: 768 }));

    expect(workbench).toHaveAttribute('data-layout-mode', 'desktop');
    expect(screen.queryByRole('tablist', { name: 'Tool panes' })).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Bottom views' })).toBeVisible();
    expect(screen.getByTestId('left-pane')).toBeVisible();
    expect(screen.getByTestId('canvas-pane')).toBeVisible();
    expect(screen.getByTestId('right-pane')).toBeVisible();
    expect(screen.getByTestId('bottom-pane')).toBeVisible();
    expect(screen.getAllByRole('separator')).toHaveLength(3);
  });

  it('keeps command bar and canvas visible while collapsing tool panes into one tab region', () => {
    const store = new EditorStore({ viewport: { width: 720, height: 768 } });
    render(<Workbench store={store} />);
    const workbench = screen.getByRole('application', { name: 'UXML Editor' });

    expect(workbench).toHaveAttribute('data-layout-mode', 'compact');
    expect(screen.getByTestId('commandbar')).toBeVisible();
    expect(screen.getByTestId('canvas-pane')).toBeVisible();
    expect(screen.getByRole('tablist', { name: 'Tool panes' })).toBeVisible();
    expect(screen.getByTestId('left-pane')).toBeVisible();
    expect(screen.getByTestId('right-pane')).not.toBeVisible();
    expect(screen.getByTestId('bottom-pane')).not.toBeVisible();
    expect(screen.getByTestId('source-pane')).not.toBeVisible();
    expect(screen.getByTestId('right-pane').style.display).toBe('none');
    expect(screen.getByTestId('bottom-pane').style.display).toBe('none');
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('implements keyboard-correct tabs and linked tabpanels', () => {
    const store = new EditorStore({ viewport: { width: 720, height: 768 } });
    render(<Workbench store={store} />);
    const hierarchy = screen.getByRole('tab', { name: 'Hierarchy' });
    const inspector = screen.getByRole('tab', { name: 'Inspector' });
    const diagnostics = screen.getByRole('tab', { name: 'Diagnostics' });
    const source = screen.getByRole('tab', { name: 'Source' });

    expect(hierarchy).toHaveAttribute('aria-selected', 'true');
    expect(hierarchy).toHaveAttribute('aria-controls', 'compact-hierarchy-panel');
    expect(screen.getByTestId('left-pane')).toHaveAttribute('aria-labelledby', 'compact-hierarchy-tab');

    hierarchy.focus();
    fireEvent.keyDown(hierarchy, { key: 'ArrowRight' });
    expect(inspector).toHaveFocus();
    expect(inspector).toHaveAttribute('aria-selected', 'true');
    expect(store.getSnapshot().activePanel).toBe('inspector');
    expect(screen.getByTestId('left-pane')).not.toBeVisible();
    expect(screen.getByTestId('right-pane')).toBeVisible();

    fireEvent.keyDown(inspector, { key: 'End' });
    expect(source).toHaveFocus();
    expect(source).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(source, { key: 'ArrowLeft' });
    expect(diagnostics).toHaveFocus();
    fireEvent.keyDown(diagnostics, { key: 'Home' });
    expect(hierarchy).toHaveFocus();
  });

  it('keeps every compact tabpanel inside the single tools region', () => {
    render(<Workbench store={new EditorStore({ viewport: { width: 720, height: 768 } })} />);
    const tools = screen.getByTestId('compact-tools');

    expect(tools).toContainElement(screen.getByTestId('left-pane'));
    expect(tools).toContainElement(screen.getByTestId('right-pane'));
    expect(tools).toContainElement(screen.getByTestId('bottom-pane'));
    expect(tools).toContainElement(screen.getByTestId('source-pane'));
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(4);
  });

  it('transitions between compact and desktop regions from observable viewport state', () => {
    const store = new EditorStore({ viewport: { width: 720, height: 768 } });
    render(<Workbench store={store} />);
    expect(screen.getByRole('tablist', { name: 'Tool panes' })).toBeVisible();

    act(() => store.dispatch({ type: 'viewport/set', width: 1024, height: 768 }));

    expect(screen.queryByRole('tablist', { name: 'Tool panes' })).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Bottom views' })).toBeVisible();
    expect(screen.getByTestId('left-pane')).toBeVisible();
    expect(screen.getByTestId('right-pane')).toBeVisible();
    expect(screen.getByTestId('bottom-pane')).toBeVisible();
    expect(screen.getAllByRole('separator')).toHaveLength(3);
  });

  it('retains compact Source as the visible desktop bottom view after a responsive transition', () => {
    const store = new EditorStore({ session: openSession(), viewport: { width: 720, height: 768 } });
    render(<Workbench store={store} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(store.getSnapshot().activePanel).toBe('source');
    expect(screen.getByTestId('source-pane')).toBeVisible();

    act(() => store.dispatch({ type: 'viewport/set', width: 1024, height: 768 }));

    expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Assets/UI/Main.uxml source' })).toBeVisible();
    const diagnosticsView = document.getElementById('bottom-diagnostics-view');
    expect(diagnosticsView).not.toBeNull();
    expect(diagnosticsView).not.toBeVisible();
  });
});

function openSession(): DocumentSession {
  return DocumentSession.open(
    new Map([['Assets/UI/Main.uxml', '<UXML><Button /></UXML>']]),
    'Assets/UI/Main.uxml',
    new UxmlPreviewAdapter(),
  );
}
