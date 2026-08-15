import { describe, expect, it, vi } from 'vitest';
import { MemoryHost } from '../../core/host/MemoryHost';
import { projectPath } from '../../core/host/HostPort';
import { projectId } from '../../core/host/HostPort';
import { PersistenceTestAdapter } from '../../core/persistence/persistenceTestSupport';
import { EditorStore } from '../../core/store/EditorStore';
import { FileWorkflow } from './FileWorkflow';

const ENTRY_PATH = 'Assets/Main.uxml';
const INITIAL_SOURCE = '<UXML><Button text="Play" /></UXML>\r\n';

describe('FileWorkflow', () => {
  it('opens, edits, saves, closes, and reopens the same exact source', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    expect(root).not.toBeNull();

    await workflow.openProject(root!);
    const session = store.getSnapshot().session!;
    const start = session.snapshot().files.get(ENTRY_PATH)!.text.indexOf('Play');
    session.history.execute({
      id: 'set-button-text',
      label: 'Set button text',
      patchesByFile: new Map([[ENTRY_PATH, [{ start, end: start + 4, replacement: 'Race' }]]]),
    });
    store.dispatch({ type: 'session/sync' });

    await workflow.saveAll();
    await workflow.closeProject();
    expect(store.getSnapshot().session).toBeNull();

    await workflow.reopenProject();
    expect(store.getSnapshot().session!.snapshot().files.get(ENTRY_PATH)!.text)
      .toBe('<UXML><Button text="Race" /></UXML>\r\n');
  });

  it('keeps an unedited save byte-identical without replacing the file', async () => {
    const { host, workflow } = fixture();
    const root = await host.chooseProject();
    expect(root).not.toBeNull();
    await workflow.openProject(root!);
    const before = await host.readText(projectPath(root!, ENTRY_PATH));

    await workflow.saveAll();

    const after = await host.readText(projectPath(root!, ENTRY_PATH));
    expect(after).toEqual(before);
  });

  it('creates a new unsaved document and saves it into an empty selected project', async () => {
    const host = new MemoryHost({
      projects: [{ id: 'destination', name: 'Destination', files: {} }],
    });
    const store = new EditorStore({ host, viewport: { width: 1280, height: 720 } });
    const workflow = new FileWorkflow(store, host, { adapter: new PersistenceTestAdapter() });
    const destination = await host.chooseProject();
    expect(destination).not.toBeNull();

    await workflow.newProject();
    expect(store.getSnapshot().session!.snapshot().files.get(ENTRY_PATH)!.text)
      .toBe('<ui:UXML xmlns:ui="UnityEngine.UIElements">\n</ui:UXML>\n');

    await workflow.saveAs(destination!);

    expect(await host.readText(projectPath(destination!, ENTRY_PATH))).toMatchObject({
      text: '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n</ui:UXML>\n',
    });
    expect(workflow.getSnapshot().dirtyState).toBe('clean');
  });

  it('requires an explicit overwrite decision before Save As replaces existing bytes', async () => {
    const host = new MemoryHost({
      projects: [{ id: 'destination', name: 'Destination', files: { [ENTRY_PATH]: 'existing bytes\r\n' } }],
    });
    const store = new EditorStore({ host, viewport: { width: 1280, height: 720 } });
    const workflow = new FileWorkflow(store, host, { adapter: new PersistenceTestAdapter() });
    const destination = await host.chooseProject();
    expect(destination).not.toBeNull();
    await workflow.newProject();

    host.queueConfirmation(false);
    await workflow.saveAs(destination!);
    expect((await host.readText(projectPath(destination!, ENTRY_PATH))).text).toBe('existing bytes\r\n');

    host.queueConfirmation(true);
    await workflow.saveAs(destination!);
    expect((await host.readText(projectPath(destination!, ENTRY_PATH))).text)
      .toBe('<ui:UXML xmlns:ui="UnityEngine.UIElements">\n</ui:UXML>\n');
  });

  it('reauthorizes a recent project instead of treating recent metadata as a grant', async () => {
    const { host, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    await workflow.closeProject();
    const recent = (await host.listRecentProjects())[0]!;
    const choose = vi.spyOn(host, 'chooseProject');

    await workflow.openRecent(recent);

    expect(choose).toHaveBeenCalledTimes(1);
    expect(workflow.getSnapshot().projectName).toBe('Project A');
  });

  it('appends local history to recovery before saving and clears it after a complete save', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    const session = store.getSnapshot().session!;
    session.history.execute({
      id: 'recoverable-edit',
      label: 'Recoverable edit',
      patchesByFile: new Map([[ENTRY_PATH, [{ start: 20, end: 24, replacement: 'Race' }]]]),
    });
    store.dispatch({ type: 'session/sync' });

    await vi.waitFor(async () => {
      expect(await host.readRecovery(root!.id)).not.toBeNull();
    });
    await workflow.saveAll();

    expect(await host.readRecovery(root!.id)).toBeNull();
  });

  it('auto-reloads a clean external change through the authoritative session', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);

    await host.externalWrite(projectPath(root!, ENTRY_PATH), '<UXML><Button text="External" /></UXML>\n');
    await host.advanceTime(50);

    expect(store.getSnapshot().session!.snapshot().files.get(ENTRY_PATH)!.text)
      .toBe('<UXML><Button text="External" /></UXML>\n');
    expect(workflow.getSnapshot().dirtyState).toBe('clean');
    expect(await host.readRecovery(root!.id)).toBeNull();
  });

  it('keeps a dirty external change explicit until the user resolves it', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    const session = store.getSnapshot().session!;
    session.history.execute({
      id: 'local-edit',
      label: 'Local edit',
      patchesByFile: new Map([[ENTRY_PATH, [{ start: 20, end: 24, replacement: 'Race' }]]]),
    });
    store.dispatch({ type: 'session/sync' });

    await host.externalWrite(projectPath(root!, ENTRY_PATH), '<UXML><Button text="External" /></UXML>\n');
    await host.advanceTime(50);

    expect(workflow.getSnapshot().externalChanges).toEqual([expect.objectContaining({
      path: ENTRY_PATH,
      status: 'conflict',
      localDirty: true,
    })]);
    await workflow.resolveExternalChange(ENTRY_PATH, 'reload');
    expect(store.getSnapshot().session!.snapshot().files.get(ENTRY_PATH)!.text)
      .toBe('<UXML><Button text="External" /></UXML>\n');
    expect(workflow.getSnapshot().dirtyState).toBe('clean');
    expect(await host.readRecovery(root!.id)).toBeNull();
  });

  it('saves dirty bytes when Save is selected before closing', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    host.queueConfirmation(true);

    await workflow.closeProject();

    expect(store.getSnapshot().session).toBeNull();
    expect((await host.readText(projectPath(root!, ENTRY_PATH))).text)
      .toBe('<UXML><Button text="Race" /></UXML>\r\n');
    expect(host.confirmationRequests[0]).toMatchObject({
      confirmLabel: 'Save',
      cancelLabel: 'Other Options',
    });
  });

  it('keeps a dirty project open when close is cancelled after declining Save', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    host.queueConfirmation(false);
    host.queueConfirmation(false);

    await workflow.closeProject();

    expect(store.getSnapshot().session).not.toBeNull();
    expect(host.confirmationRequests).toHaveLength(2);
    expect(host.confirmationRequests[1]).toMatchObject({
      confirmLabel: 'Discard',
      cancelLabel: 'Cancel',
    });
  });

  it('discards dirty state only after the explicit second close decision', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    host.queueConfirmation(false);
    host.queueConfirmation(true);

    await workflow.closeProject();

    expect(store.getSnapshot().session).toBeNull();
    expect((await host.readText(projectPath(root!, ENTRY_PATH))).text).toBe(INITIAL_SOURCE);
  });

  it('retains the current session when a replacement picker is cancelled', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    host.queueConfirmation(false);
    host.queueConfirmation(true);
    const session = store.getSnapshot().session;
    const choose = vi.spyOn(host, 'chooseProject').mockResolvedValueOnce(null);

    await workflow.openProject();

    expect(choose).toHaveBeenCalledOnce();
    expect(store.getSnapshot().session).toBe(session);
    expect(workflow.getSnapshot().dirtyState).toBe('dirty');
  });

  it('restores a locally edited file after an external deletion when overwrite is chosen', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    await host.externalDelete(projectPath(root!, ENTRY_PATH));
    await host.advanceTime(50);
    expect(workflow.getSnapshot().externalChanges).toEqual([expect.objectContaining({
      path: ENTRY_PATH,
      external: 'deleted',
      localDirty: true,
    })]);

    await workflow.resolveExternalChange(ENTRY_PATH, 'overwrite');

    expect((await host.readText(projectPath(root!, ENTRY_PATH))).text)
      .toBe('<UXML><Button text="Race" /></UXML>\r\n');
    expect(workflow.getSnapshot().externalChanges).toEqual([]);
    expect(workflow.getSnapshot().dirtyState).toBe('clean');
  });

  it('keeps a failed external resolution pending so it can be retried', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    await host.externalWrite(projectPath(root!, ENTRY_PATH), '<UXML external="true" />\n');
    await host.advanceTime(50);
    host.injectFailure({ operation: 'replace', phase: 'before' });

    await workflow.resolveExternalChange(ENTRY_PATH, 'overwrite');

    expect(workflow.getSnapshot().externalChanges).toEqual([expect.objectContaining({
      path: ENTRY_PATH,
      status: 'conflict',
      localDirty: true,
    })]);
    expect(host.messageRequests.at(-1)).toMatchObject({
      kind: 'error',
      title: 'External change not resolved',
    });
  });

  it('keeps exact source as untitled when desktop Save As selection revokes the old grant', async () => {
    const host = new MemoryHost({
      projects: [
        { id: 'old', name: 'Old Project', files: { [ENTRY_PATH]: INITIAL_SOURCE } },
        { id: 'destination', name: 'Destination', files: { [ENTRY_PATH]: 'existing\n' } },
      ],
    });
    Object.defineProperty(host, 'capabilities', {
      value: Object.freeze({ ...host.capabilities, mode: 'tauri' }),
    });
    const oldRoot = Object.freeze({ id: projectId('old'), name: 'Old Project' });
    const destination = Object.freeze({ id: projectId('destination'), name: 'Destination' });
    const store = new EditorStore({ host });
    const workflow = new FileWorkflow(store, host, { adapter: new PersistenceTestAdapter() });
    await workflow.openProject(oldRoot);
    editButtonText(store, 'Race');
    const session = store.getSnapshot().session;
    vi.spyOn(host, 'chooseProject').mockResolvedValueOnce(destination);
    host.queueConfirmation(false);

    await workflow.saveAs();

    expect(store.getSnapshot().session).toBe(session);
    expect(session!.snapshot().files.get(ENTRY_PATH)!.text)
      .toBe('<UXML><Button text="Race" /></UXML>\r\n');
    expect(workflow.getSnapshot()).toMatchObject({
      projectName: 'Untitled Project',
      dirtyState: 'dirty',
      canReload: false,
    });
  });

  it('keeps the current session when a selected replacement has no UXML document', async () => {
    const host = new MemoryHost({
      projects: [
        { id: 'old', name: 'Old Project', files: { [ENTRY_PATH]: INITIAL_SOURCE } },
        { id: 'invalid', name: 'Invalid Project', files: { 'README.txt': 'not a project\n' } },
      ],
    });
    const oldRoot = Object.freeze({ id: projectId('old'), name: 'Old Project' });
    const invalidRoot = Object.freeze({ id: projectId('invalid'), name: 'Invalid Project' });
    const store = new EditorStore({ host });
    const workflow = new FileWorkflow(store, host, { adapter: new PersistenceTestAdapter() });
    await workflow.openProject(oldRoot);
    const session = store.getSnapshot().session;

    await expect(workflow.openProject(invalidRoot)).rejects.toThrow(/does not contain a UXML/i);

    expect(store.getSnapshot().session).toBe(session);
    expect(workflow.getSnapshot().projectName).toBe('Old Project');
  });

  it('advances the held desktop close state only after a successful save-before-close', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    let saved: unknown;
    let validated = false;

    await workflow.runExclusiveCloseState('close:v1:0000000000000001', async (lease) => {
      expect(lease.dirtyState).toBe('dirty');
      saved = await workflow.saveBeforeClose(lease);
      validated = workflow.finalValidateCloseState(lease);
    });

    expect(saved).toBe('saved');
    expect(validated).toBe(true);
    expect(await host.readText(projectPath(root!, ENTRY_PATH))).toMatchObject({
      text: '<UXML><Button text="Race" /></UXML>\r\n',
    });
  });
});

function editButtonText(store: EditorStore, replacement: string): void {
  const session = store.getSnapshot().session!;
  const source = session.snapshot().files.get(ENTRY_PATH)!.text;
  const start = source.indexOf('Play');
  session.history.execute({
    id: `set-button-text-${replacement}`,
    label: 'Set button text',
    patchesByFile: new Map([[ENTRY_PATH, [{ start, end: start + 4, replacement }]]]),
  });
  store.dispatch({ type: 'session/sync' });
}

function fixture() {
  const host = new MemoryHost({
    projects: [{ id: 'project-a', name: 'Project A', files: { [ENTRY_PATH]: INITIAL_SOURCE } }],
  });
  const store = new EditorStore({ host, viewport: { width: 1280, height: 720 } });
  const workflow = new FileWorkflow(store, host, { adapter: new PersistenceTestAdapter() });
  return { host, store, workflow };
}
