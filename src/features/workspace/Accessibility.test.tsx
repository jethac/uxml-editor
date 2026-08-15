import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { DocumentSession } from '../../core/documents/DocumentSession';
import { MemoryHost } from '../../core/host/MemoryHost';
import { projectPath } from '../../core/host/HostPort';
import { PersistenceTestAdapter } from '../../core/persistence/persistenceTestSupport';
import { CommandRegistry } from '../../core/store/CommandRegistry';
import { EditorStore } from '../../core/store/EditorStore';
import { PreviewCanvas } from '../canvas/PreviewCanvas';
import { KeyboardShortcuts } from './KeyboardShortcuts';

describe('workspace accessibility', () => {
  it('opens a project through the unified toolbar and returns focus from the command palette', async () => {
    const user = userEvent.setup();
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Assets/Main.uxml': '<UXML />\n' } }],
    });
    const store = new EditorStore({ host, viewport: { width: 1280, height: 720 } });
    render(<App store={store} />);

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Open Project' }));
    await waitFor(() => expect(store.getSnapshot().session).not.toBeNull());
    expect(save).toBeEnabled();

    const paletteButton = screen.getByRole('button', { name: 'Command Palette' });
    paletteButton.focus();
    await user.click(paletteButton);
    const dialog = screen.getByRole('dialog', { name: 'Command Palette' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search commands' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command Palette' })).not.toBeInTheDocument();
    expect(paletteButton).toHaveFocus();
  }, 15_000);

  it('runs registry shortcuts without hijacking inputs, contenteditable, or CodeMirror', async () => {
    const session = openSession();
    const host = new MemoryHost();
    const store = new EditorStore({ session, host, viewport: { width: 1280, height: 720 } });
    const file = fileCommands();
    const registry = new CommandRegistry({ store, file, platform: 'windows' });
    render(
      <>
        <KeyboardShortcuts registry={registry} />
        <input aria-label="Inspector value" />
        <div contentEditable aria-label="Editable label" />
        <div className="cm-editor" tabIndex={0} aria-label="Source editor" />
      </>,
    );

    fireEvent.keyDown(screen.getByLabelText('Inspector value'), { key: 's', ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText('Editable label'), { key: 's', ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText('Source editor'), { key: 's', ctrlKey: true });
    expect(file.save).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
    await waitFor(() => expect(file.save).toHaveBeenCalledTimes(1));
  });

  it('routes the global Search command to the source pane', async () => {
    const session = openSession();
    const host = new MemoryHost();
    const store = new EditorStore({ session, host, viewport: { width: 1280, height: 720 } });
    render(<App store={store} />);

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

    await waitFor(() => expect(store.getSnapshot().activePanel).toBe('source'));
    expect(screen.queryByRole('dialog', { name: 'Command Palette' })).not.toBeInTheDocument();
  });

  it('gives the canvas an accessible name and Escape clears selection while retaining focus', () => {
    const session = openSession();
    session.setSelection([session.locatorFor(session.document.root.id)!]);
    const store = new EditorStore({ session, viewport: { width: 1280, height: 720 } });
    render(<PreviewCanvas store={store} />);
    const canvas = screen.getByLabelText('Canvas editing area');
    canvas.focus();

    fireEvent.keyDown(canvas, { key: 'Escape' });

    expect(session.selectedNodeIds).toEqual([]);
    expect(document.activeElement).toBe(canvas);
  });

  it('exposes explicit accessible actions for a dirty external file change', async () => {
    const user = userEvent.setup();
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Assets/Main.uxml': '<UXML />\n' } }],
    });
    const store = new EditorStore({ host, viewport: { width: 1280, height: 720 } });
    render(<App store={store} />);
    await user.click(screen.getByRole('button', { name: 'Open Project' }));
    await waitFor(() => expect(store.getSnapshot().session).not.toBeNull());
    const session = store.getSnapshot().session!;
    session.history.execute({
      id: 'local-source-change',
      label: 'Local source change',
      patchesByFile: new Map([['Assets/Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });
    store.dispatch({ type: 'session/sync' });
    const root = (await host.listRecentProjects())[0]!.root;

    await host.externalWrite(projectPath(root, 'Assets/Main.uxml'), '<UXML external="true" />\n');
    await host.advanceTime(50);

    expect(screen.getByRole('dialog', { name: 'External file changes' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload Assets/Main.uxml from disk' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'External file changes' })).not.toBeInTheDocument());
    expect(session.snapshot().files.get('Assets/Main.uxml')!.text).toBe('<UXML external="true" />\n');
  }, 15_000);
});

function openSession(): DocumentSession {
  return DocumentSession.open(
    new Map([['Assets/Main.uxml', '<UXML />']]),
    'Assets/Main.uxml',
    new PersistenceTestAdapter(),
  );
}

function fileCommands() {
  const save = vi.fn<() => void>();
  return {
    newProject: vi.fn(),
    openProject: vi.fn(),
    openRecent: vi.fn(),
    save,
    saveAs: vi.fn(),
    saveAll: vi.fn(),
    closeProject: vi.fn(),
    reopenProject: vi.fn(),
    reloadProject: vi.fn(),
    getSnapshot: () => Object.freeze({
      projectName: 'Project',
      dirtyState: 'clean' as const,
      recentProjects: Object.freeze([]),
      canReopen: false,
      canReload: true,
    }),
    subscribe: () => () => undefined,
  };
}
