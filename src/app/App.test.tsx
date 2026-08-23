import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EDITOR_LAYOUT_STORAGE_KEY } from '../core/store/EditorLayoutStorage';
import { EditorStore } from '../core/store/EditorStore';
import { MemoryHost } from '../core/host/MemoryHost';
import { createBrowserEditorStore } from './createBrowserEditorStore';
import { App } from './App';

describe('application workbench', () => {
  it('renders the real editor regions as the first screen without native APIs', () => {
    render(<App store={new EditorStore()} />);
    expect(screen.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
    expect(screen.getByTestId('commandbar')).toBeVisible();
    expect(screen.getByTestId('canvas-pane')).toBeVisible();
  });

  it('keeps one stable EditorStore instance across rerenders', async () => {
    const user = userEvent.setup();
    const store = new EditorStore();
    const { rerender } = render(<App store={store} />);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));

    rerender(<App store={store} />);

    expect(screen.getByText('110%')).toBeVisible();
  });

  it('uses an injected EditorStore as the observable application boundary', () => {
    const store = new EditorStore();
    store.dispatch({ type: 'zoom/set', zoom: 1.5 });

    render(<App store={store} />);

    expect(screen.getByText('150%')).toBeVisible();
  });

  it('restores one browser store before StrictMode renders App', () => {
    const getItem = vi.fn(() => JSON.stringify({
      version: 1,
      panes: { left: 300, right: 320, bottom: 200 },
    }));
    const storage: Storage = {
      length: 1,
      clear: vi.fn(),
      getItem,
      key: vi.fn(() => EDITOR_LAYOUT_STORAGE_KEY),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });

    try {
      const store = createBrowserEditorStore();
      render(
        <StrictMode>
          <App store={store} />
        </StrictMode>,
      );

      expect(store.getSnapshot().panes).toEqual({ left: 300, right: 320, bottom: 200 });
      expect(getItem).toHaveBeenCalledOnce();
      expect(getItem).toHaveBeenCalledWith(EDITOR_LAYOUT_STORAGE_KEY);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(window, 'localStorage');
      else Object.defineProperty(window, 'localStorage', descriptor);
    }
  });

  it('uses one injected workflow owner for rendered state and registry execution without disposing it', async () => {
    const user = userEvent.setup();
    const host = new MemoryHost();
    const openProject = vi.fn();
    const dispose = vi.fn();
    const owner = injectedWorkflowOwner({ openProject, dispose });
    const rendered = render(<App store={new EditorStore({ host })} task16FileLifecycle={owner} />);

    expect(screen.getByLabelText('Project status')).toHaveTextContent('Injected Project');
    await user.click(screen.getByRole('button', { name: 'Open Project' }));

    expect(openProject).toHaveBeenCalledOnce();
    rendered.unmount();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('disposes an internally owned workflow watcher on unmount', async () => {
    const user = userEvent.setup();
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Assets/Main.uxml': '<UXML />' } }],
    });
    const dispose = vi.fn();
    const watch = vi.spyOn(host, 'watch').mockResolvedValue(Object.freeze({ dispose }));
    const rendered = render(<App store={new EditorStore({ host })} />);
    await user.click(screen.getByRole('button', { name: 'Open Project' }));
    await waitFor(() => expect(watch).toHaveBeenCalledOnce());

    rendered.unmount();

    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });
});

function injectedWorkflowOwner(overrides: Record<string, unknown> = {}) {
  const snapshot = Object.freeze({
    projectName: 'Injected Project',
    dirtyState: 'clean' as const,
    recentProjects: Object.freeze([]),
    externalChanges: Object.freeze([]),
    canReopen: false,
    canReload: false,
    capabilities: Object.freeze({
      newProject: true,
      openProject: true,
      openRecent: false,
      save: true,
      saveAs: true,
      saveAll: true,
      closeProject: true,
      reopenProject: false,
      reloadProject: false,
    }),
  });
  return Object.freeze({
    newProject: vi.fn(),
    openProject: vi.fn(),
    openRecent: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
    saveAll: vi.fn(),
    closeProject: vi.fn(),
    reopenProject: vi.fn(),
    reloadProject: vi.fn(),
    resolveExternalChange: vi.fn(),
    runExclusiveCloseState: vi.fn(),
    finalValidateCloseState: vi.fn(() => true),
    saveBeforeClose: vi.fn(() => 'saved' as const),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    dispose: vi.fn(),
    ...overrides,
  });
}
