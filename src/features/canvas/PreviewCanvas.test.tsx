import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
import { DocumentSession } from '../../core/documents/DocumentSession';
import { EditorStore } from '../../core/store/EditorStore';
import { PreviewCanvas } from './PreviewCanvas';

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
});

describe('PreviewCanvas rendering and viewport controls', () => {
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

function openSession(adapter: UxmlPreviewPort): DocumentSession {
  return DocumentSession.open(new Map([[ENTRY, UXML]]), ENTRY, adapter);
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
    const targetId = nodeNamed(parsed, 'target');
    const parent = document.createElement('div');
    const target = document.createElement('button');
    const generated = document.createElement('span');
    generated.textContent = `${this.label} preview`;
    target.append(generated);
    parent.append(target);
    container.append(parent);
    const nodes = new Map<Element, EditorNodeId>([[parent, parentId], [target, targetId]]);
    let disposed = false;
    return {
      elements: new Map<EditorNodeId, HTMLElement>([[parentId, parent], [targetId, target]]),
      boxes: new Map([
        [parentId, { left: 8, top: 12, width: 180, height: 96 }],
        [targetId, { left: 24, top: 36, width: 90, height: 28 }],
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
