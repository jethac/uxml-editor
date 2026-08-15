import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  EditorDiagnostic,
  EditorNodeId,
  ParsedPreviewDocument,
  PreviewFrame,
  PreviewRenderOptions,
  ProjectParseInput,
  StyleExplanationOptions,
  UxmlPreviewPort,
} from '../../core/adapter/types';
import { freezeParsedPreviewDocument } from '../../core/adapter/immutableParsedDocument';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import {
  ClipboardService,
  type ClipboardItemLike,
  type ClipboardPort,
} from '../../core/commands/ClipboardService';
import { DocumentSession } from '../../core/documents/DocumentSession';
import {
  SourceEditCoordinator,
  type SourceEditScheduledTask,
  type SourceEditScheduler,
} from '../../core/documents/SourceEditCoordinator';
import { EditorStore } from '../../core/store/EditorStore';
import { PreviewCanvas } from './PreviewCanvas';
import { ViewportModel } from './ViewportModel';

const ENTRY = 'Assets/UI/Main.uxml';
const UXML = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:VisualElement name="parent">
    <ui:Button name="target" text="Choose" />
  </ui:VisualElement>
</ui:UXML>`;

describe('PreviewCanvas frame lifecycle and selection', () => {
  it('disposes the current frame before rendering a replacement session', async () => {
    const events: string[] = [];
    const firstAdapter = new ControlledPreviewPort('first', events);
    const secondAdapter = new ControlledPreviewPort('second', events);
    const first = openSession(firstAdapter);
    const second = openSession(secondAdapter);
    const store = new EditorStore({ session: first });

    render(<PreviewCanvas store={store} />);
    await screen.findByText('first preview');

    act(() => store.dispatch({ type: 'context/set', session: second, host: null }));

    await screen.findByText('second preview');
    expect(events.indexOf('first:dispose')).toBeGreaterThan(-1);
    expect(events.indexOf('first:dispose')).toBeLessThan(events.indexOf('second:render'));
  });

  it('rerenders when the authoritative session publishes a replacement document', async () => {
    const adapter = new ControlledPreviewPort('document', []);
    const session = openSession(adapter);
    const store = new EditorStore({ session });
    render(<PreviewCanvas store={store} />);
    await screen.findByText('document preview');

    const start = UXML.indexOf('Choose');
    act(() => {
      session.history.execute({
        id: 'change-text',
        label: 'Change text',
        patchesByFile: new Map([[ENTRY, [{ start, end: start + 6, replacement: 'Next' }]]]),
      });
      store.dispatch({ type: 'session/sync' });
    });

    await waitFor(() => expect(adapter.renderOptions).toHaveLength(2));
  });

  it('disposes a stale async frame without publishing its DOM or diagnostics', async () => {
    const events: string[] = [];
    const staleAdapter = new ControlledPreviewPort('stale', events, true);
    const currentAdapter = new ControlledPreviewPort('current', events);
    const store = new EditorStore({ session: openSession(staleAdapter) });

    render(<PreviewCanvas store={store} />);
    await waitFor(() => expect(staleAdapter.pendingCount).toBe(1));
    act(() => store.dispatch({
      type: 'context/set',
      session: openSession(currentAdapter),
      host: null,
    }));
    await screen.findByText('current preview');

    await act(async () => staleAdapter.resolveNext());

    expect(events).toContain('stale:dispose');
    expect(screen.queryByText('stale preview')).not.toBeInTheDocument();
    expect(screen.getByText('current preview')).toBeVisible();
    expect(store.getSnapshot().diagnostics).toEqual([]);
  });

  it('walks generated renderer ancestors and commits a locator-backed session selection', async () => {
    const adapter = new ControlledPreviewPort('select', []);
    const session = openSession(adapter);
    const store = new EditorStore({ session });
    const target = nodeNamed(session.document, 'target');

    render(<PreviewCanvas store={store} />);
    const generated = await screen.findByText('select preview');
    fireEvent.click(generated);

    expect(session.selectedNodeIds).toEqual([target]);
    expect(store.getSnapshot().selection).toEqual([target]);
    expect(session.selection).toEqual([session.locatorFor(target)]);
  });

  it('does not select from the last-good rendered preview while the source draft is stale', async () => {
    const adapter = new ControlledPreviewPort('stale selection', []);
    const session = openSession(adapter);
    const scheduler = new CapturingScheduler();
    const coordinator = new SourceEditCoordinator(session, { scheduler });
    adapter.parseDiagnostics = [diagnostic('malformed draft', 'parse')];
    coordinator.replace(`${UXML} `);
    scheduler.flush();
    expect(coordinator.getSnapshot().status).toBe('stale');

    render(<PreviewCanvas store={new EditorStore({ session })} coordinator={coordinator} />);
    fireEvent.click(await screen.findByText('stale selection preview'));

    expect(session.selectedNodeIds).toEqual([]);
    coordinator.dispose();
  });
});

describe('PreviewCanvas rendering and viewport controls', () => {
  it('exposes manipulation commands and persists modified keyboard nudging through history', async () => {
    const absolute = UXML.replace(
      'name="target" text="Choose"',
      'name="target" text="Choose" style="position: absolute; left: 0px; top: 0px; width: 90px; height: 28px;"',
    );
    const adapter = new ControlledPreviewPort('manipulate', []);
    const session = openSession(adapter, absolute);
    const store = new EditorStore({ session });
    render(<PreviewCanvas store={store} />);
    fireEvent.click(await screen.findByText('manipulate preview'));

    expect(screen.getByRole('button', { name: 'Align left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Distribute horizontally' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bring to front' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy selection' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Paste' })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId('canvas-field'), { key: 'ArrowRight', shiftKey: true });

    expect(
      session.snapshot().files.get(ENTRY)?.text,
      screen.queryByRole('status')?.textContent ?? 'no interaction diagnostic',
    ).toContain('left: 10px; top: 0px;');
    expect(session.history.undoDepth).toBe(1);
  });

  it('drags and resizes an absolute selection through the interactive canvas layer', async () => {
    const absolute = UXML.replace(
      'name="target" text="Choose"',
      'name="target" text="Choose" style="position: absolute; left: 0px; top: 0px; width: 90px; height: 28px;"',
    );
    const adapter = new ControlledPreviewPort('direct gesture', []);
    const session = openSession(adapter, absolute);
    const store = new EditorStore({ session });
    render(<PreviewCanvas store={store} />);
    const target = await screen.findByText('direct gesture preview');
    const field = screen.getByTestId('canvas-field');

    fireEvent.pointerDown(target, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(field, { pointerId: 7, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(field, { pointerId: 7, clientX: 30, clientY: 20 });

    expect(session.snapshot().files.get(ENTRY)?.text).toContain('left: 20px; top: 10px;');
    expect(session.history.undoDepth).toBe(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resize selection' })).toBeVisible());

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize selection' }), {
      button: 0, pointerId: 8, clientX: 100, clientY: 100,
    });
    fireEvent.pointerMove(field, { pointerId: 8, clientX: 110, clientY: 105 });
    fireEvent.pointerUp(field, { pointerId: 8, clientX: 110, clientY: 105 });

    expect(session.snapshot().files.get(ENTRY)?.text).toContain('width: 100px; height: 33px;');
    expect(session.history.undoDepth).toBe(2);
    expect(await screen.findByTestId('canvas-overlay')).toHaveStyle({ pointerEvents: 'none' });
  });

  it('cancels an active manipulation when the authoritative session changes', async () => {
    const absolute = UXML.replace(
      'name="target" text="Choose"',
      'name="target" text="Choose" style="position: absolute; left: 0px; top: 0px; width: 90px; height: 28px;"',
    );
    const firstAdapter = new ControlledPreviewPort('first gesture session', []);
    const first = openSession(firstAdapter, absolute);
    const secondAdapter = new ControlledPreviewPort('second gesture session', []);
    const second = openSession(secondAdapter, absolute);
    const store = new EditorStore({ session: first });
    render(<PreviewCanvas store={store} />);
    const target = await screen.findByText('first gesture session preview');
    const field = screen.getByTestId('canvas-field');

    fireEvent.pointerDown(target, { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
    act(() => store.dispatch({ type: 'context/set', session: second, host: null }));
    await screen.findByText('second gesture session preview');
    fireEvent.pointerMove(field, { pointerId: 9, clientX: 30, clientY: 20 });

    expect(first.snapshot().files.get(ENTRY)?.text).toBe(absolute);
    expect(second.snapshot().files.get(ENTRY)?.text).toBe(absolute);
    expect(first.history.undoDepth).toBe(0);
    expect(second.history.undoDepth).toBe(0);
  });

  it('forms a Shift multi-selection once across the pointer-down and click sequence', async () => {
    const source = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:Button name="first" style="position: absolute; left: 0px; top: 0px; width: 40px; height: 20px;" />',
      '    <ui:Button name="second" style="position: absolute; left: 60px; top: 30px; width: 40px; height: 20px;" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n');
    const adapter = new ControlledPreviewPort('multi', [], false, ['first', 'second']);
    const session = openSession(adapter, source);
    const store = new EditorStore({ session });
    render(<PreviewCanvas store={store} />);
    const field = screen.getByTestId('canvas-field');
    const first = await screen.findByText('multi first');
    const second = await screen.findByText('multi second');

    fireEvent.pointerDown(first, { button: 0, pointerId: 31, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(field, { pointerId: 31, clientX: 10, clientY: 10 });
    fireEvent.click(first, { detail: 1 });
    fireEvent.pointerDown(second, { button: 0, pointerId: 32, clientX: 70, clientY: 40, shiftKey: true });
    fireEvent.pointerUp(field, { pointerId: 32, clientX: 70, clientY: 40, shiftKey: true });
    fireEvent.click(second, { detail: 1, shiftKey: true });

    expect(session.selectedNodeIds).toEqual([
      nodeNamed(session.document, 'first'),
      nodeNamed(session.document, 'second'),
    ]);
    expect(store.getSnapshot().selection).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Align top' })).toBeEnabled();
  });

  it('discards a deferred paste when the authoritative session changes before clipboard read resolves', async () => {
    const sourceAdapter = new ControlledPreviewPort('clipboard source', []);
    const sourceSession = openSession(sourceAdapter);
    const sourceNode = findNode(sourceSession.document.root, nodeNamed(sourceSession.document, 'target'));
    if (sourceNode === null) throw new Error('Missing clipboard source node.');
    const copied = new ClipboardService().copy(sourceSession, [sourceNode]);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;

    let resolveRead!: (items: readonly ClipboardItemLike[]) => void;
    const read = vi.fn(() => new Promise<readonly ClipboardItemLike[]>((resolve) => { resolveRead = resolve; }));
    const clipboardPort: ClipboardPort = { write: vi.fn(), read };
    const firstAdapter = new ControlledPreviewPort('stale paste session', []);
    const first = openSession(firstAdapter);
    const secondAdapter = new ControlledPreviewPort('current paste session', []);
    secondAdapter.parseDiagnostics = [diagnostic('current paste diagnostic', 'parse')];
    const second = openSession(secondAdapter);
    const store = new EditorStore({ session: first });
    render(<PreviewCanvas store={store} clipboardPort={clipboardPort} />);
    await screen.findByText('stale paste session preview');

    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    act(() => store.dispatch({ type: 'context/set', session: second, host: null }));
    await screen.findByText('current paste session preview');
    await waitFor(() => expect(store.getSnapshot().diagnostics.map((item) => item.message)).toEqual([
      'current paste diagnostic',
    ]));
    await act(async () => {
      resolveRead([copied.item]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(first.snapshot().files.get(ENTRY)?.text).toBe(UXML);
    expect(second.snapshot().files.get(ENTRY)?.text).toBe(UXML);
    expect(first.history.undoDepth).toBe(0);
    expect(second.history.undoDepth).toBe(0);
    expect(store.getSnapshot().diagnostics.map((item) => item.message)).toEqual(['current paste diagnostic']);
  });

  it('re-reads the injected clipboard port after Copy and pastes its newest successful item', async () => {
    const externalSource = UXML.replace('name="target" text="Choose"', 'name="external" text="External"');
    const externalSession = openSession(new ControlledPreviewPort('external clipboard', []), externalSource);
    const externalNode = findNode(externalSession.document.root, nodeNamed(externalSession.document, 'external'));
    if (externalNode === null) throw new Error('Missing external clipboard node.');
    const external = new ClipboardService().copy(externalSession, [externalNode]);
    expect(external.ok).toBe(true);
    if (!external.ok) return;
    const clipboardPort: ClipboardPort = {
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => [external.item]),
    };
    const adapter = new ControlledPreviewPort('current clipboard', []);
    const session = openSession(adapter);
    const store = new EditorStore({ session });
    render(<PreviewCanvas store={store} clipboardPort={clipboardPort} />);
    fireEvent.click(await screen.findByText('current clipboard preview'));

    fireEvent.click(screen.getByRole('button', { name: 'Copy selection' }));
    await waitFor(() => expect(clipboardPort.write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));

    await waitFor(() => expect(clipboardPort.read).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(session.snapshot().files.get(ENTRY)?.text).toContain('name="external"'));
    expect(session.snapshot().files.get(ENTRY)?.text).not.toContain('name="target-copy"');
  });

  it('attempts the current clipboard read and uses the local copy only when that read fails', async () => {
    const clipboardPort: ClipboardPort = {
      write: vi.fn(async () => { throw new Error('clipboard write denied'); }),
      read: vi.fn(async () => { throw new Error('clipboard read denied'); }),
    };
    const adapter = new ControlledPreviewPort('clipboard fallback', []);
    const session = openSession(adapter);
    const store = new EditorStore({ session });
    render(<PreviewCanvas store={store} clipboardPort={clipboardPort} />);
    fireEvent.click(await screen.findByText('clipboard fallback preview'));

    fireEvent.click(screen.getByRole('button', { name: 'Copy selection' }));
    await waitFor(() => expect(clipboardPort.write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));

    await waitFor(() => expect(clipboardPort.read).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(session.snapshot().files.get(ENTRY)?.text).toContain('name="target-copy"'));
    expect(session.history.undoDepth).toBe(1);
  });

  it('keeps renderer dimensions fixed while zoom transforms only the outer surface', async () => {
    const adapter = new ControlledPreviewPort('fixed', []);
    const store = new EditorStore({ session: openSession(adapter) });
    render(<PreviewCanvas store={store} />);
    await screen.findByText('fixed preview');

    act(() => store.dispatch({ type: 'zoom/set', zoom: 2 }));

    expect(screen.getByTestId('canvas-renderer')).toHaveStyle({ width: '640px', height: '480px' });
    expect(screen.getByTestId('canvas-transform')).toHaveStyle({
      transform: 'translate(0px, 0px) scale(2)',
    });
    expect(adapter.renderOptions).toHaveLength(1);
    expect(adapter.renderOptions[0].size).toEqual({ width: 640, height: 480 });
  });

  it('draws independent hover, selection, selected-parent bounds, and four handles from frame boxes', async () => {
    const adapter = new ControlledPreviewPort('overlay', []);
    const store = new EditorStore({ session: openSession(adapter) });
    render(<PreviewCanvas store={store} />);
    const target = await screen.findByText('overlay preview');

    fireEvent.mouseOver(target);
    fireEvent.click(target);

    expect(screen.getByTestId('canvas-overlay')).toHaveStyle({ pointerEvents: 'none' });
    expect(screen.getByTestId('hover-bounds')).toHaveStyle({ left: '24px', top: '36px', width: '90px', height: '28px' });
    expect(screen.getByTestId('selected-bounds')).toHaveStyle({ left: '24px', top: '36px', width: '90px', height: '28px' });
    expect(screen.getByTestId('selected-parent-bounds')).toHaveStyle({ left: '8px', top: '12px', width: '180px', height: '96px' });
    expect(screen.getAllByTestId('selection-handle')).toHaveLength(4);
  });

  it('zooms around the wheel cursor and pans with the pan tool or middle button', async () => {
    const adapter = new ControlledPreviewPort('gesture', []);
    const store = new EditorStore({ session: openSession(adapter) });
    render(<PreviewCanvas store={store} />);
    await screen.findByText('gesture preview');
    const field = screen.getByTestId('canvas-field');
    field.getBoundingClientRect = () => ({
      x: 100, y: 50, left: 100, top: 50, right: 700, bottom: 450,
      width: 600, height: 400, toJSON: () => ({}),
    });

    fireEvent.wheel(field, { clientX: 300, clientY: 200, deltaY: -100 });
    expect(store.getSnapshot().zoom).toBe(1.1);
    expect(screen.getByTestId('canvas-transform')).toHaveStyle({
      transform: 'translate(-20px, -15px) scale(1.1)',
    });

    act(() => store.dispatch({ type: 'tool/set', tool: 'pan' }));
    fireEvent.pointerDown(field, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 130, clientY: 120 });
    fireEvent.pointerUp(field, { pointerId: 1, clientX: 130, clientY: 120 });
    expect(screen.getByTestId('canvas-transform')).toHaveStyle({
      transform: 'translate(10px, 5px) scale(1.1)',
    });

    act(() => store.dispatch({ type: 'tool/set', tool: 'select' }));
    fireEvent.pointerDown(field, { button: 1, pointerId: 2, clientX: 200, clientY: 180 });
    fireEvent.pointerMove(field, { pointerId: 2, clientX: 190, clientY: 170 });
    fireEvent.pointerUp(field, { pointerId: 2, clientX: 190, clientY: 170 });
    expect(screen.getByTestId('canvas-transform')).toHaveStyle({
      transform: 'translate(0px, -5px) scale(1.1)',
    });
  });

  it('supports presets, orientation, custom dimensions, fit, 100%, and rejects invalid dimensions', async () => {
    const user = userEvent.setup();
    const adapter = new ControlledPreviewPort('controls', []);
    const store = new EditorStore({ session: openSession(adapter) });
    render(<PreviewCanvas store={store} />);
    await screen.findByText('controls preview');
    const field = screen.getByTestId('canvas-field');
    field.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400,
      width: 600, height: 400, toJSON: () => ({}),
    });

    await user.selectOptions(screen.getByLabelText('Device preset'), 'mobile');
    await waitFor(() => expect(adapter.renderOptions.at(-1)?.size).toEqual({ width: 390, height: 844 }));
    expect(screen.getByLabelText('Canvas width')).toHaveValue(390);
    expect(screen.getByLabelText('Canvas height')).toHaveValue(844);

    await user.click(screen.getByRole('button', { name: 'Swap orientation' }));
    await waitFor(() => expect(adapter.renderOptions.at(-1)?.size).toEqual({ width: 844, height: 390 }));
    expect(screen.getByRole('button', { name: 'Swap orientation' }).querySelector('svg')).toBeInTheDocument();

    const width = screen.getByLabelText('Canvas width');
    const rendersBeforeInvalid = adapter.renderOptions.length;
    await user.clear(width);
    await user.type(width, '0');
    await user.tab();
    expect(width).toHaveAttribute('aria-invalid', 'true');
    expect(adapter.renderOptions).toHaveLength(rendersBeforeInvalid);

    await user.clear(width);
    await user.type(width, '412');
    await user.tab();
    await waitFor(() => expect(adapter.renderOptions.at(-1)?.size).toEqual({ width: 412, height: 390 }));

    await user.click(screen.getByRole('button', { name: 'Fit canvas' }));
    expect(store.getSnapshot().zoom).toBeCloseTo(0.9, 1);
    await user.click(screen.getByRole('button', { name: 'Actual size' }));
    expect(store.getSnapshot().zoom).toBe(1);
    expect(screen.getByRole('button', { name: 'Fit canvas' })).toHaveAttribute('title', 'Fit canvas');
    expect(screen.getByRole('button', { name: 'Actual size' })).toHaveAttribute('title', 'Actual size (100%)');
  });

  it('renders safe area and sends all seven states only to the selected named element', async () => {
    const user = userEvent.setup();
    const adapter = new ControlledPreviewPort('states', []);
    const store = new EditorStore({ session: openSession(adapter) });
    render(<PreviewCanvas store={store} />);
    await user.click(await screen.findByText('states preview'));

    await user.click(screen.getByLabelText('Show safe area'));
    expect(screen.getByTestId('safe-area')).toBeVisible();

    for (const state of ['Hover', 'Active', 'Focus', 'Disabled', 'Checked', 'Selected', 'Inactive']) {
      await user.click(screen.getByLabelText(state));
    }
    await waitFor(() => expect(adapter.renderOptions.at(-1)?.states).toEqual({
      '#target': ['hover', 'active', 'focus', 'disabled', 'checked', 'selected', 'inactive'],
    }));
    expect(adapter.renderOptions.at(-1)?.activeStates).toBeUndefined();
  });

  it('clears selected pseudo states when a different session reuses document-local node IDs', async () => {
    const user = userEvent.setup();
    const firstAdapter = new ControlledPreviewPort('first states', []);
    const first = openSession(firstAdapter);
    const store = new EditorStore({ session: first });
    render(<PreviewCanvas store={store} />);
    await user.click(await screen.findByText('first states preview'));
    await user.click(screen.getByLabelText('Hover'));
    await waitFor(() => expect(firstAdapter.renderOptions.at(-1)?.states).toEqual({ '#target': ['hover'] }));

    const secondAdapter = new ControlledPreviewPort('second states', [], false, 'replacement');
    const second = openSession(secondAdapter, UXML.replace('name="target"', 'name="replacement"'));
    act(() => store.dispatch({ type: 'context/set', session: second, host: null }));

    await screen.findByText('second states preview');
    expect(secondAdapter.renderOptions.at(-1)?.states).toBeUndefined();

    act(() => store.dispatch({ type: 'context/set', session: first, host: null }));
    await screen.findByText('first states preview');
    expect(firstAdapter.renderOptions.at(-1)?.states).toBeUndefined();
  });

  it('clears pseudo states when reparsing the same session no longer resolves the original locator', async () => {
    const user = userEvent.setup();
    const adapter = new ControlledPreviewPort('reparse states', []);
    const session = openSession(adapter);
    const store = new EditorStore({ session });
    render(<PreviewCanvas store={store} />);
    await user.click(await screen.findByText('reparse states preview'));
    await user.click(screen.getByLabelText('Hover'));
    await waitFor(() => expect(adapter.renderOptions.at(-1)?.states).toEqual({ '#target': ['hover'] }));

    const start = UXML.indexOf('target');
    act(() => {
      session.history.execute({
        id: 'rename-target',
        label: 'Rename target',
        patchesByFile: new Map([[ENTRY, [{ start, end: start + 6, replacement: 'replacement' }]]]),
      });
      store.dispatch({ type: 'session/sync' });
    });

    await waitFor(() => expect(adapter.renderOptions.at(-1)?.states).toBeUndefined());
  });

  it('clears pseudo states when the same authored name is replaced by a different tag', async () => {
    const user = userEvent.setup();
    const adapter = new ControlledPreviewPort('tag replacement states', []);
    const session = openSession(adapter);
    const store = new EditorStore({ session });
    render(<PreviewCanvas store={store} />);
    await user.click(await screen.findByText('tag replacement states preview'));
    await user.click(screen.getByLabelText('Hover'));
    await waitFor(() => expect(adapter.renderOptions.at(-1)?.states).toEqual({ '#target': ['hover'] }));

    const start = UXML.indexOf('ui:Button');
    act(() => {
      session.history.execute({
        id: 'replace-state-tag',
        label: 'Replace state tag',
        patchesByFile: new Map([[ENTRY, [{ start, end: start + 'ui:Button'.length, replacement: 'ui:Label' }]]]),
      });
      store.dispatch({ type: 'session/sync' });
    });

    await waitFor(() => expect(adapter.renderOptions.at(-1)?.states).toBeUndefined());
    expect(store.getSnapshot().activeStates).toEqual([]);
  });

  it('escapes authored names for pseudo states without targeting sibling identifiers', async () => {
    const user = userEvent.setup();
    const adapter = new ControlledPreviewPort('escaped states', [], false, '-1state');
    const document = UXML.replace('name="target"', 'name="-1state"').replace(
      '</ui:VisualElement>',
      '  <ui:Button name="-1state-sibling" text="Other" />\n  </ui:VisualElement>',
    );
    const store = new EditorStore({ session: openSession(adapter, document) });
    render(<PreviewCanvas store={store} />);
    await user.click(await screen.findByText('escaped states preview'));
    await user.click(screen.getByLabelText('Hover'));

    await waitFor(() => expect(adapter.renderOptions.at(-1)?.states).toEqual({ '#-\\31 state': ['hover'] }));
    const host = window.document.createElement('div');
    const target = window.document.createElement('button');
    const sibling = window.document.createElement('button');
    target.id = '-1state';
    sibling.id = '-1state-sibling';
    host.append(target, sibling);
    expect(host.querySelector(Object.keys(adapter.renderOptions.at(-1)?.states ?? {})[0])).toBe(target);
  });

  it('uses standards-correct selectors for leading digits and punctuation in authored names', async () => {
    const user = userEvent.setup();
    const adapter = new ControlledPreviewPort('punctuation states', [], false, '1state');
    const document = UXML.replace('name="target"', 'name="1state"');
    const store = new EditorStore({ session: openSession(adapter, document) });
    render(<PreviewCanvas store={store} />);
    await user.click(await screen.findByText('punctuation states preview'));
    await user.click(screen.getByLabelText('Hover'));
    await waitFor(() => expect(adapter.renderOptions.at(-1)?.states).toEqual({ '#\\31 state': ['hover'] }));

    const punctuationAdapter = new ControlledPreviewPort('punctuation states two', [], false, 'item:state');
    const punctuationStore = new EditorStore({
      session: openSession(punctuationAdapter, UXML.replace('name="target"', 'name="item:state"')),
    });
    render(<PreviewCanvas store={punctuationStore} />);
    await user.click(await screen.findByText('punctuation states two preview'));
    await user.click(screen.getAllByLabelText('Hover').at(-1)!);
    await waitFor(() => expect(punctuationAdapter.renderOptions.at(-1)?.states).toEqual({ '#item\\:state': ['hover'] }));
  });

  it('delegates pointer panning to ViewportModel.panBy', async () => {
    const panBy = vi.spyOn(ViewportModel.prototype, 'panBy');
    const adapter = new ControlledPreviewPort('pan model', []);
    const store = new EditorStore({ session: openSession(adapter) });
    render(<PreviewCanvas store={store} />);
    await screen.findByText('pan model preview');
    const field = screen.getByTestId('canvas-field');
    act(() => store.dispatch({ type: 'tool/set', tool: 'pan' }));

    fireEvent.pointerDown(field, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 130, clientY: 120 });

    expect(panBy).toHaveBeenCalledWith({ x: 30, y: 20 });
    panBy.mockRestore();
  });

  it('describes why pseudo-state controls are disabled for an unnamed selection', async () => {
    const user = userEvent.setup();
    const adapter = new ControlledPreviewPort('unnamed state', [], false, null);
    const document = UXML.replace(' name="target"', '');
    const store = new EditorStore({ session: openSession(adapter, document) });
    render(<PreviewCanvas store={store} />);
    await user.click(await screen.findByText('unnamed state preview'));

    expect(screen.getByLabelText('Hover')).toBeDisabled();
    expect(screen.getByText('A unique authored name is required for pseudo states.')).toBeVisible();
  });

  it('combines parse and current render diagnostics without render loops and replaces old render warnings', async () => {
    const user = userEvent.setup();
    const adapter = new ControlledPreviewPort('diagnostics', []);
    adapter.parseDiagnostics = [diagnostic('parse warning', 'parse')];
    adapter.renderDiagnostics = [diagnostic('first render warning', 'render')];
    const store = new EditorStore({ session: openSession(adapter) });
    render(<PreviewCanvas store={store} />);

    await waitFor(() => expect(store.getSnapshot().diagnostics.map((item) => item.message)).toEqual([
      'parse warning',
      'first render warning',
    ]));
    expect(adapter.renderOptions).toHaveLength(1);
    await user.click(screen.getByText('diagnostics preview'));

    adapter.renderDiagnostics = [diagnostic('replacement warning', 'render')];
    await user.click(screen.getByLabelText('Hover'));
    await waitFor(() => expect(store.getSnapshot().diagnostics.map((item) => item.message)).toEqual([
      'parse warning',
      'replacement warning',
    ]));
    expect(adapter.renderOptions).toHaveLength(2);
  });

  it('shows no-document and current render error states and supports injected browser services', async () => {
    const emptyStore = new EditorStore();
    const empty = render(<PreviewCanvas store={emptyStore} />);
    expect(screen.getByText('No document')).toBeVisible();
    expect(screen.queryByTestId('canvas-renderer')).not.toBeInTheDocument();
    empty.unmount();

    const adapter = new ControlledPreviewPort('error', []);
    adapter.failure = new Error('layout failed');
    const resolveAsset = () => 'blob:asset';
    const measureText = () => ({ width: 10, height: 12 });
    const store = new EditorStore({ session: openSession(adapter) });
    render(<PreviewCanvas store={store} resolveAsset={resolveAsset} measureText={measureText} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable: layout failed');
    expect(adapter.renderOptions[0]).toEqual(expect.objectContaining({ resolveAsset, measureText }));
  });
});

function diagnostic(message: string, origin: EditorDiagnostic['origin']): EditorDiagnostic {
  return { origin, severity: 'warning', kind: 'malformed', message };
}

class CapturingScheduler implements SourceEditScheduler {
  private callback: (() => void) | null = null;

  schedule(_delayMs: number, callback: () => void): SourceEditScheduledTask {
    this.callback = callback;
    return Object.freeze({ cancel: () => { this.callback = null; } });
  }

  flush(): void {
    const callback = this.callback;
    this.callback = null;
    callback?.();
  }
}

function openSession(adapter: UxmlPreviewPort, document = UXML): DocumentSession {
  return DocumentSession.open(new Map([[ENTRY, document]]), ENTRY, adapter);
}

function nodeNamed(document: ParsedPreviewDocument, name: string): EditorNodeId {
  const visit = (node: ParsedPreviewDocument['root']): EditorNodeId | null => {
    if (node.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name)) {
      return node.id;
    }
    for (const child of node.children) {
      const found = visit(child);
      if (found !== null) return found;
    }
    return null;
  };
  const found = visit(document.root);
  if (found === null) throw new Error(`Missing fixture node ${name}.`);
  return found;
}

function nodeWithoutName(document: ParsedPreviewDocument): EditorNodeId {
  const visit = (node: ParsedPreviewDocument['root']): EditorNodeId | null => {
    if (node.id !== document.root.id && !node.attributes.some((attribute) => attribute.name === 'name')) return node.id;
    for (const child of node.children) {
      const found = visit(child);
      if (found !== null) return found;
    }
    return null;
  };
  const found = visit(document.root);
  if (found === null) throw new Error('Missing unnamed button fixture node.');
  return found;
}

function nodeNamedOrFirstChild(document: ParsedPreviewDocument, name: string): EditorNodeId {
  try {
    return nodeNamed(document, name);
  } catch {
    const parent = findNode(document.root, nodeNamed(document, 'parent'));
    const fallback = parent?.children[0]?.id;
    if (fallback === undefined) throw new Error(`Missing fixture node ${name}.`);
    return fallback;
  }
}

function findNode(root: ParsedPreviewDocument['root'], nodeId: EditorNodeId): ParsedPreviewDocument['root'] | null {
  if (root.id === nodeId) return root;
  for (const child of root.children) {
    const found = findNode(child, nodeId);
    if (found !== null) return found;
  }
  return null;
}

class ControlledPreviewPort implements UxmlPreviewPort {
  private readonly base = new UxmlPreviewAdapter();
  private readonly pending: Array<{
    document: ParsedPreviewDocument;
    container: HTMLElement;
    resolve: (frame: PreviewFrame) => void;
  }> = [];
  readonly renderOptions: PreviewRenderOptions[] = [];
  parseDiagnostics: readonly EditorDiagnostic[] = [];
  renderDiagnostics: readonly EditorDiagnostic[] = [];
  failure: Error | null = null;

  constructor(
    private readonly label: string,
    private readonly events: string[],
    private readonly deferred = false,
    private readonly targetName: string | null | readonly string[] = 'target',
  ) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  supportedControlNames(): readonly string[] {
    return this.base.supportedControlNames();
  }

  parseProject(input: ProjectParseInput): ParsedPreviewDocument {
    const parsed = this.base.parseProject(input);
    return this.parseDiagnostics.length === 0
      ? parsed
      : freezeParsedPreviewDocument({ ...parsed, diagnostics: this.parseDiagnostics });
  }

  serializeEntry(document: ParsedPreviewDocument) {
    return this.base.serializeEntry(document);
  }

  parseStylesheet(path: string, source: string) {
    return this.base.parseStylesheet(path, source);
  }

  parseDeclarationList(path: string, source: string, start: number, end: number) {
    return this.base.parseDeclarationList(path, source, start, end);
  }

  explain(
    document: ParsedPreviewDocument,
    nodeId: EditorNodeId,
    property: string,
    options?: StyleExplanationOptions,
  ) {
    return this.base.explain(document, nodeId, property, options);
  }

  render(
    document: ParsedPreviewDocument,
    container: HTMLElement,
    options: PreviewRenderOptions,
  ): Promise<PreviewFrame> {
    this.events.push(`${this.label}:render`);
    this.renderOptions.push(options);
    if (this.failure !== null) return Promise.reject(this.failure);
    if (!this.deferred) return Promise.resolve(this.createFrame(document, container));
    return new Promise((resolve) => this.pending.push({ document, container, resolve }));
  }

  resolveNext(): void {
    const pending = this.pending.shift();
    if (pending === undefined) throw new Error('No pending frame.');
    pending.resolve(this.createFrame(pending.document, pending.container));
  }

  private createFrame(parsed: ParsedPreviewDocument, container: HTMLElement): PreviewFrame {
    const parentId = nodeNamed(parsed, 'parent');
    const parent = document.createElement('div');
    const targetNames = typeof this.targetName === 'string' || this.targetName === null
      ? [this.targetName]
      : this.targetName;
    const targets = targetNames.map((targetName, index) => {
      const targetId = targetName === null ? nodeWithoutName(parsed) : nodeNamedOrFirstChild(parsed, targetName);
      const target = document.createElement('button');
      const generated = document.createElement('span');
      generated.textContent = targetNames.length === 1 ? `${this.label} preview` : `${this.label} ${targetName}`;
      target.append(generated);
      parent.append(target);
      return { target, targetId, index };
    });
    container.append(parent);
    const nodes = new Map<Element, EditorNodeId>([
      [parent, parentId],
      ...targets.map(({ target, targetId }) => [target, targetId] as const),
    ]);
    let disposed = false;
    return {
      elements: new Map<EditorNodeId, HTMLElement>([
        [parentId, parent],
        ...targets.map(({ target, targetId }) => [targetId, target] as const),
      ]),
      boxes: new Map([
        [parentId, { left: 8, top: 12, width: 180, height: 96 }],
        ...targets.map(({ targetId, index }) => [
          targetId,
          targetNames.length === 1
            ? { left: 24, top: 36, width: 90, height: 28 }
            : { left: 24 + (index * 60), top: 36 + (index * 30), width: 40, height: 20 },
        ] as const),
      ]),
      diagnostics: [...this.renderDiagnostics],
      nodeForElement: (element) => nodes.get(element) ?? null,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.events.push(`${this.label}:dispose`);
        parent.remove();
      },
    };
  }
}
