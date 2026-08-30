import { describe, expect, it, vi } from 'vitest';
import { DocumentSession } from '../../core/documents/DocumentSession';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import { MemoryHost } from '../../core/host/MemoryHost';
import { CommandRegistry } from '../../core/store/CommandRegistry';
import { EditorStore } from '../../core/store/EditorStore';
import { WorkspaceEditingCommands } from './WorkspaceEditingCommands';

describe('WorkspaceEditingCommands', () => {
  it('drives selection-derived duplicate, copy, delete, cut, and paste through the registry', async () => {
    const source = '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button name="play" /></ui:UXML>\n';
    const session = DocumentSession.open(
      new Map([['Assets/Main.uxml', source]]),
      'Assets/Main.uxml',
      new UxmlPreviewAdapter(),
    );
    const button = session.document.root.children[0]!;
    session.setSelection([session.locatorFor(button.id)!]);
    const host = new MemoryHost();
    const store = new EditorStore({ session, host });
    const editing = new WorkspaceEditingCommands(store);
    const registry = new CommandRegistry({
      store,
      file: filePort(),
      editing,
      platform: 'windows',
      errors: { report: vi.fn() },
    });

    expect(registry.command('edit.copy').enabled).toBe(true);
    expect(registry.command('edit.duplicate').enabled).toBe(true);
    expect(registry.command('edit.delete').enabled).toBe(true);
    await registry.execute('edit.copy');
    await registry.execute('edit.duplicate');
    expect(session.document.root.children).toHaveLength(2);

    await registry.execute('edit.delete');
    expect(session.document.root.children).toHaveLength(1);
    session.setSelection([session.locatorFor(session.document.root.children[0]!.id)!]);
    store.dispatch({ type: 'session/sync' });
    await registry.execute('edit.cut');
    expect(session.document.root.children).toHaveLength(0);

    session.setSelection([session.locatorFor(session.document.root.id)!]);
    store.dispatch({ type: 'session/sync' });
    await registry.execute('edit.paste');
    expect(session.document.root.children).toHaveLength(1);
  });
});

function filePort() {
  return {
    newProject: () => undefined,
    openProject: () => undefined,
    openRecent: () => undefined,
    save: () => undefined,
    saveAs: () => undefined,
    saveAll: () => undefined,
    closeProject: () => undefined,
    reopenProject: () => undefined,
    reloadProject: () => undefined,
    getSnapshot: () => Object.freeze({
      projectName: null,
      dirtyState: 'clean' as const,
      recentProjects: Object.freeze([]),
      canReopen: false,
      canReload: false,
      capabilities: Object.freeze({
        newProject: false,
        openProject: false,
        openRecent: false,
        save: false,
        saveAs: false,
        saveAll: false,
        closeProject: false,
        reopenProject: false,
        reloadProject: false,
      }),
    }),
    subscribe: () => () => undefined,
  };
}
