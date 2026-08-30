import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, type Mock } from 'vitest';
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
    const search = screen.getByRole('searchbox', { name: 'Search commands' });
    expect(search).toHaveFocus();

    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true });
    const enabledOptions = screen.getAllByRole('option').filter((option) => !option.hasAttribute('disabled'));
    expect(enabledOptions.at(-1)).toHaveFocus();
    fireEvent.keyDown(enabledOptions.at(-1)!, { key: 'Tab' });
    expect(search).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command Palette' })).not.toBeInTheDocument();
    expect(paletteButton).toHaveFocus();
  }, 15_000);

  it('describes dirty state on the visible project status control', async () => {
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
      id: 'dirty-status',
      label: 'Dirty status',
      patchesByFile: new Map([['Assets/Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    store.dispatch({ type: 'session/sync' });

    await waitFor(() => expect(screen.getByLabelText('Project status')).toHaveAttribute(
      'aria-description',
      'Project has unsaved changes.',
    ));
  }, 15_000);

  it('preserves global file and pane shortcuts in editable targets while suppressing text conflicts', async () => {
    const session = openSession();
    session.history.execute({
      id: 'undoable-edit',
      label: 'Undoable edit',
      patchesByFile: new Map([['Assets/Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const host = new MemoryHost();
    const store = new EditorStore({ session, host, viewport: { width: 1280, height: 720 } });
    const file = fileCommands();
    const registry = new CommandRegistry({
      store,
      file,
      platform: 'windows',
      errors: { report: vi.fn() },
    });
    render(
      <>
        <KeyboardShortcuts registry={registry} />
        <input aria-label="Inspector value" />
        <div contentEditable aria-label="Editable label" />
        <div className="cm-editor" tabIndex={0} aria-label="Source editor" />
      </>,
    );

    const input = screen.getByLabelText('Inspector value');
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(session.history.canUndo).toBe(true);

    fireEvent.keyDown(input, { key: 's', ctrlKey: true });
    await waitFor(() => expect(file.save).toHaveBeenCalledOnce());

    fireEvent.keyDown(screen.getByLabelText('Editable label'), { key: '2', ctrlKey: true });
    expect(store.getSnapshot().activePanel).toBe('inspector');

    fireEvent.keyDown(screen.getByLabelText('Source editor'), { key: 'c', ctrlKey: true });
    expect(session.history.canUndo).toBe(true);
  });

  it('normalizes the physical Shift modifier required for focused-input zoom in', async () => {
    const session = openSession();
    const host = new MemoryHost();
    const store = new EditorStore({ session, host, viewport: { width: 1280, height: 720 } });
    const registry = new CommandRegistry({
      store,
      file: fileCommands(),
      platform: 'windows',
      errors: { report: vi.fn() },
    });
    render(
      <>
        <KeyboardShortcuts registry={registry} />
        <input aria-label="Focused value" />
      </>,
    );

    fireEvent.keyDown(screen.getByLabelText('Focused value'), {
      key: '+',
      code: 'Equal',
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => expect(store.getSnapshot().zoom).toBe(1.1));
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
    const returnTarget = screen.getByRole('button', { name: 'Save' });
    returnTarget.focus();

    await host.externalWrite(projectPath(root, 'Assets/Main.uxml'), '<UXML external="true" />\n');
    await host.advanceTime(50);

    const dialog = screen.getByRole('dialog', { name: 'External file changes' });
    expect(dialog).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload Assets/Main.uxml from disk' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Reload Assets/Main.uxml from disk' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'External file changes' })).not.toBeInTheDocument());
    expect(session.snapshot().files.get('Assets/Main.uxml')!.text).toBe('<UXML external="true" />\n');
    expect(returnTarget).toHaveFocus();
  }, 15_000);

  it('traps external-change focus and resolves Escape through the safe cancel decision', async () => {
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
    const returnTarget = screen.getByRole('button', { name: 'Save' });
    returnTarget.focus();
    const root = (await host.listRecentProjects())[0]!.root;

    await host.externalWrite(projectPath(root, 'Assets/Main.uxml'), '<UXML external="true" />\n');
    await host.advanceTime(50);

    const dialog = screen.getByRole('dialog', { name: 'External file changes' });
    const reload = within(dialog).getByRole('button', { name: 'Reload Assets/Main.uxml from disk' });
    const dismiss = within(dialog).getByRole('button', { name: 'Dismiss Assets/Main.uxml external change' });
    expect(reload).toHaveFocus();
    fireEvent.keyDown(reload, { key: 'Tab', shiftKey: true });
    expect(dismiss).toHaveFocus();
    fireEvent.keyDown(dismiss, { key: 'Tab' });
    expect(reload).toHaveFocus();

    fireEvent.keyDown(reload, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'External file changes' })).not.toBeInTheDocument());
    expect(session.snapshot().files.get('Assets/Main.uxml')!.text).not.toContain('external="true"');
    expect(returnTarget).toHaveFocus();
  }, 15_000);

  it.each([
    ['toolbar', async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Save' }));
    }],
    ['palette', async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Command Palette' }));
      await user.click(screen.getByRole('option', { name: /^SaveFileCtrl\+S$/ }));
    }],
    ['shortcut', async () => {
      fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
    }],
  ])('shows rejected %s commands through one contained error boundary', async (_surface, invoke) => {
    const user = userEvent.setup();
    const host = new MemoryHost();
    const save = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('injected save failure'));
    render(<App store={new EditorStore({ host })} task16FileLifecycle={failingWorkflowOwner(save)} />);

    await invoke(user);

    const dialog = await screen.findByRole('alertdialog', { name: 'Command failed' });
    expect(dialog).toHaveTextContent('Save failed');
    expect(dialog).toHaveTextContent('injected save failure');
    expect(save).toHaveBeenCalledOnce();
  });
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
      capabilities: Object.freeze({
        newProject: true,
        openProject: true,
        openRecent: false,
        save: true,
        saveAs: true,
        saveAll: true,
        closeProject: true,
        reopenProject: false,
        reloadProject: true,
      }),
    }),
    subscribe: () => () => undefined,
  };
}

function failingWorkflowOwner(save: Mock<() => Promise<void>>) {
  const snapshot = Object.freeze({
    projectName: 'Injected Project',
    dirtyState: 'dirty' as const,
    recentProjects: Object.freeze([]),
    externalChanges: Object.freeze([]),
    canReopen: false,
    canReload: true,
    capabilities: Object.freeze({
      newProject: true,
      openProject: true,
      openRecent: false,
      save: true,
      saveAs: true,
      saveAll: true,
      closeProject: true,
      reopenProject: false,
      reloadProject: true,
    }),
  });
  return Object.freeze({
    newProject: vi.fn(),
    openProject: vi.fn(),
    openRecent: vi.fn(),
    save,
    saveAs: vi.fn(),
    saveAll: vi.fn(),
    closeProject: vi.fn(),
    reopenProject: vi.fn(),
    reloadProject: vi.fn(),
    resolveExternalChange: vi.fn(),
    runExclusiveCloseState: vi.fn(),
    finalValidateCloseState: vi.fn(() => true),
    saveBeforeClose: vi.fn(() => 'failed' as const),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    dispose: vi.fn(),
  });
}
