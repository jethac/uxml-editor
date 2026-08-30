import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import type { EditorDiagnostic, EditorElement, EditorNodeId } from '../../core/adapter/types';
import { DocumentSession } from '../../core/documents/DocumentSession';
import { SourceEditCoordinator } from '../../core/documents/SourceEditCoordinator';
import { EditorStore } from '../../core/store/EditorStore';
import { DiagnosticsPanel } from './DiagnosticsPanel';

const entryPath = 'Assets/UI/Main.uxml';
const sheetPath = 'Assets/UI/Main.uss';
const uxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="Assets/UI/Main.uss" />
  <ui:FancyChart name="chart" />
  <ui:Label name="title" text="Title" />
</ui:UXML>\n`;
const uss = '.title { mystery-property: 2px; }\n';
const coordinators: SourceEditCoordinator[] = [];

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
});

describe('DiagnosticsPanel', () => {
  it('selects the current canvas node and opens the exact file span when a diagnostic is activated', async () => {
    const user = userEvent.setup();
    const { session, store, coordinator } = createContext();
    const chart = nodeNamed(session.document.root, 'chart');
    const diagnostic = warning('Unsupported FancyChart', entryPath, chart.source.start, chart.source.end, chart.id);
    render(<Harness store={store} coordinator={coordinator} diagnostics={[diagnostic]} />);

    await user.click(screen.getByRole('button', { name: /Unsupported FancyChart/i }));

    expect(store.getSnapshot().selection).toEqual([chart.id]);
    expect(coordinator.getSnapshot()).toMatchObject({
      activePath: entryPath,
      activeSpan: chart.source,
    });
    expect(screen.getByTestId('opened-source')).toHaveTextContent(entryPath);
  });

  it('groups in stable file order and supports text and file filtering plus row keyboard navigation', async () => {
    const user = userEvent.setup();
    const { store, coordinator } = createContext();
    const diagnostics = [
      warning('Unsupported selector', sheetPath, 0, 6),
      warning('Unsupported control', entryPath, 45, 53),
      { origin: 'render', severity: 'warning', kind: 'asset-unresolved', message: 'Missing asset' } as const,
    ];
    render(<Harness store={store} coordinator={coordinator} diagnostics={diagnostics} />);

    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      sheetPath,
      entryPath,
      'General',
    ]);
    const first = screen.getByRole('button', { name: /Unsupported selector/i });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: /Unsupported control/i })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByRole('button', { name: /Missing asset/i })).toHaveFocus();

    await user.type(screen.getByRole('searchbox', { name: 'Filter diagnostics' }), 'asset');
    expect(screen.getByRole('button', { name: /Missing asset/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Unsupported selector/i })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Filter diagnostics' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Diagnostic file' }), sheetPath);
    expect(screen.getByRole('button', { name: /Unsupported selector/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Unsupported control/i })).not.toBeInTheDocument();
  });

  it('still opens a current source when the diagnostic node is stale and still selects a current node when its path is stale', async () => {
    const user = userEvent.setup();
    const { session, store, coordinator } = createContext();
    const title = nodeNamed(session.document.root, 'title');
    const staleNode = 'removed-node' as EditorNodeId;
    const diagnostics = [
      warning('Stale node', entryPath, title.source.start, title.source.end, staleNode),
      warning('Stale file', 'Assets/UI/Removed.uss', 0, 1, title.id),
    ];
    render(<Harness store={store} coordinator={coordinator} diagnostics={diagnostics} />);

    await user.click(screen.getByRole('button', { name: /Stale node/i }));
    expect(store.getSnapshot().selection).toEqual([]);
    expect(coordinator.getSnapshot().activeSpan).toEqual(title.source);
    expect(screen.getByTestId('opened-source')).toHaveTextContent(entryPath);

    await user.click(screen.getByRole('button', { name: /Stale file/i }));
    expect(store.getSnapshot().selection).toEqual([title.id]);
    expect(coordinator.getSnapshot().activePath).toBe(entryPath);
  });
});

function Harness({
  store,
  coordinator,
  diagnostics,
}: {
  readonly store: EditorStore;
  readonly coordinator: SourceEditCoordinator;
  readonly diagnostics: readonly EditorDiagnostic[];
}) {
  const [opened, setOpened] = useState('none');
  return (
    <>
      <DiagnosticsPanel
        store={store}
        coordinator={coordinator}
        diagnostics={diagnostics}
        onOpenSource={(path) => setOpened(path)}
      />
      <output data-testid="opened-source">{opened}</output>
    </>
  );
}

function createContext() {
  const session = DocumentSession.open(new Map([[entryPath, uxml], [sheetPath, uss]]), entryPath, new UxmlPreviewAdapter());
  const store = new EditorStore({ session });
  const coordinator = new SourceEditCoordinator(session);
  coordinators.push(coordinator);
  return { session, store, coordinator };
}

function warning(
  message: string,
  path: string,
  start: number,
  end: number,
  nodeId?: EditorNodeId,
): EditorDiagnostic {
  return {
    origin: 'parse',
    severity: 'warning',
    kind: 'unsupported-control',
    message,
    source: { path, start, end },
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function nodeNamed(root: EditorElement, name: string): EditorElement {
  const authoredName = root.attributes.find((attribute) => attribute.name === 'name')?.value;
  if (authoredName === name) return root;
  for (const child of root.children) {
    try { return nodeNamed(child, name); } catch { /* Continue depth-first. */ }
  }
  throw new Error(`Missing node ${name}.`);
}
