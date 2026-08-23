import { describe, expect, it, vi } from 'vitest';
import { CommandHistory } from '../../core/commands/CommandHistory';
import { MemoryHost } from '../../core/host/MemoryHost';
import {
  HostError,
  projectPath,
  type DisposalOutcome,
  type FileChangeListener,
} from '../../core/host/HostPort';
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

  it('reports deterministic written and pending paths when Save As creation partially fails', async () => {
    const { host, store, workflow, source, destination } = saveAsFailureFixture({});
    await workflow.openProject(source);
    editButtonText(store, 'Race');
    await vi.waitFor(async () => expect(await host.readRecovery(source.id)).not.toBeNull());
    const sourceSession = store.getSnapshot().session;
    const createText = host.createText.bind(host);
    let createCount = 0;
    vi.spyOn(host, 'createText').mockImplementation(async (path, text) => {
      createCount += 1;
      if (createCount === 2) throw new HostError('replace-failed', 'Injected create failure.');
      return createText(path, text);
    });

    await expect(workflow.saveAs(destination)).rejects.toMatchObject({
      name: 'SaveAsPartialError',
      writtenPaths: [ENTRY_PATH],
      pendingPaths: ['Assets/Second.uxml'],
    });

    expect(workflow.getSnapshot()).toMatchObject({ projectName: 'Source', dirtyState: 'dirty' });
    expect(store.getSnapshot().session).toBe(sourceSession);
    expect(await host.readRecovery(source.id)).not.toBeNull();
    expect(host.messageRequests.at(-1)).toMatchObject({
      kind: 'error',
      title: 'Save As incomplete',
      message: 'Written: Assets/Main.uxml. Pending: Assets/Second.uxml.',
    });
  });

  it('reports deterministic written and pending paths when Save As replacement partially fails', async () => {
    const { host, store, workflow, source, destination } = saveAsFailureFixture({
      [ENTRY_PATH]: '<UXML destination="main" />\n',
      'Assets/Second.uxml': '<UXML destination="second" />\n',
    });
    await workflow.openProject(source);
    editButtonText(store, 'Race');
    await vi.waitFor(async () => expect(await host.readRecovery(source.id)).not.toBeNull());
    const sourceSession = store.getSnapshot().session;
    host.queueConfirmation(true);
    host.injectFailure({ operation: 'replace', phase: 'before', after: 1 });

    await expect(workflow.saveAs(destination)).rejects.toMatchObject({
      name: 'SaveAsPartialError',
      writtenPaths: [ENTRY_PATH],
      pendingPaths: ['Assets/Second.uxml'],
    });

    expect(workflow.getSnapshot()).toMatchObject({ projectName: 'Source', dirtyState: 'dirty' });
    expect(store.getSnapshot().session).toBe(sourceSession);
    expect(await host.readRecovery(source.id)).not.toBeNull();
    expect(host.messageRequests.at(-1)).toMatchObject({
      kind: 'error',
      title: 'Save As incomplete',
      message: 'Written: Assets/Main.uxml. Pending: Assets/Second.uxml.',
    });
  });

  it('preflights every known destination revision before Save As writes any path', async () => {
    const { host, store, workflow, source, destination } = saveAsFailureFixture({
      [ENTRY_PATH]: '<UXML destination="main" />\n',
      'Assets/Second.uxml': '<UXML destination="second" />\n',
    });
    await workflow.openProject(source);
    editButtonText(store, 'Race');
    const originalMain = await host.readText(projectPath(destination, ENTRY_PATH));
    vi.spyOn(host, 'confirm').mockImplementationOnce(async () => {
      await host.externalWrite(
        projectPath(destination, 'Assets/Second.uxml'),
        '<UXML destination="changed-before-preflight" />\n',
      );
      return Object.freeze({ confirmed: true });
    });

    await expect(workflow.saveAs(destination)).rejects.toMatchObject({
      name: 'SaveAsPartialError',
      writtenPaths: [],
      pendingPaths: [ENTRY_PATH, 'Assets/Second.uxml'],
    });

    expect(await host.readText(projectPath(destination, ENTRY_PATH))).toEqual(originalMain);
    expect(workflow.getSnapshot()).toMatchObject({ projectName: 'Source', dirtyState: 'dirty' });
    expect(host.messageRequests.at(-1)).toMatchObject({
      title: 'Save As incomplete',
      message: 'Written: none. Pending: Assets/Main.uxml, Assets/Second.uxml.',
    });
  });

  it('aggregates a post-write Save As readback failure without retiring source authority', async () => {
    const context = saveAsFailureFixture({});
    const { host, workflow, destination } = context;
    await openDirtySaveAsSource(context);
    const readText = host.readText.bind(host);
    vi.spyOn(host, 'readText').mockImplementation(async (path) => {
      if (path.projectId === destination.id) {
        throw new HostError('read-failed', 'Injected post-write readback failure.');
      }
      return readText(path);
    });

    const error = await captureSaveAsFailure(workflow.saveAs(destination));

    expectCompletedSaveAsFailure(error);
    await expectDirtySourceAuthority(context);
    expect(host.messageRequests.at(-1)).toMatchObject({
      title: 'Save As incomplete',
      message: 'Written: Assets/Main.uxml, Assets/Second.uxml. Pending: none.',
    });
  });

  it('aggregates a post-write destination rescan failure without retiring source authority', async () => {
    const context = saveAsFailureFixture({});
    const { host, workflow, destination } = context;
    await openDirtySaveAsSource(context);
    const enumerateFiles = host.enumerateFiles.bind(host);
    let destinationScans = 0;
    vi.spyOn(host, 'enumerateFiles').mockImplementation(async (root) => {
      if (root.id === destination.id) {
        destinationScans += 1;
        if (destinationScans === 2) {
          throw new HostError('read-failed', 'Injected destination rescan failure.');
        }
      }
      return enumerateFiles(root);
    });

    const error = await captureSaveAsFailure(workflow.saveAs(destination));

    expectCompletedSaveAsFailure(error);
    await expectDirtySourceAuthority(context);
  });

  it('aggregates target watcher preparation failure without retiring source authority', async () => {
    const context = saveAsFailureFixture({});
    const { host, workflow, destination } = context;
    await openDirtySaveAsSource(context);
    vi.spyOn(host, 'watch').mockRejectedValueOnce(
      new HostError('read-failed', 'Injected target watcher preparation failure.'),
    );

    const error = await captureSaveAsFailure(workflow.saveAs(destination));

    expectCompletedSaveAsFailure(error);
    await expectDirtySourceAuthority(context);
  });

  it('restores exact source project, watch, and recovery authority after Save As retirement failure', async () => {
    const context = saveAsFailureFixture({});
    const { host, store, workflow, source, destination } = context;
    const sourceFailure = new HostError('read-failed', 'Injected source retirement failure.');
    const sourceDispose = vi.fn();
    const targetDispose = vi.fn();
    const sourceListeners: FileChangeListener[] = [];
    const watch = host.watch.bind(host);
    let sourceWatches = 0;
    vi.spyOn(host, 'watch').mockImplementation(async (root, listener) => {
      const underlying = await watch(root, listener);
      if (root.id === source.id) {
        sourceWatches += 1;
        sourceListeners.push(listener);
        if (sourceWatches === 1) {
          return Object.freeze({
            dispose: () => {
              sourceDispose();
              underlying.dispose();
            },
            completion: Promise.resolve(Object.freeze({ status: 'failed' as const, error: sourceFailure })),
          });
        }
        return underlying;
      }
      return Object.freeze({
        dispose: () => {
          targetDispose();
          underlying.dispose();
        },
        completion: Promise.resolve(Object.freeze({ status: 'disposed' as const })),
      });
    });
    await workflow.openProject(source);
    editButtonText(store, 'Race');
    await vi.waitFor(async () => expect(await host.readRecovery(source.id)).not.toBeNull());
    const sourceSession = store.getSnapshot().session!;
    const sourceRecovery = await host.readRecovery(source.id);

    const error = await captureSaveAsFailure(workflow.saveAs(destination));

    expectCompletedSaveAsFailure(error);
    expect(store.getSnapshot().session).toBe(sourceSession);
    expect(store.getSnapshot().projectAssets.map(({ path }) => path)).toEqual([
      ENTRY_PATH,
      'Assets/Second.uxml',
    ]);
    expect(workflow.getSnapshot()).toMatchObject({
      projectName: 'Source',
      dirtyState: 'dirty',
      canReload: true,
      capabilities: { saveAll: true, reloadProject: true },
    });
    expect(await host.readRecovery(source.id)).toBe(sourceRecovery);
    expect(sourceDispose).toHaveBeenCalledOnce();
    expect(targetDispose).toHaveBeenCalledOnce();
    expect(sourceWatches).toBe(2);
    expect(host.messageRequests.at(-1)).toMatchObject({ title: 'Save As incomplete' });

    const sourceDisk = await host.readText(projectPath(source, ENTRY_PATH));
    await sourceListeners[0]!(Object.freeze({
      kind: 'changed',
      path: sourceDisk.path,
      revision: sourceDisk.revision,
    }));
    await host.advanceTime(50);
    expect(workflow.getSnapshot().externalChanges).toEqual([]);

    await host.externalWrite(projectPath(source, ENTRY_PATH), '<UXML external="true" />\n');
    await host.advanceTime(50);
    expect(workflow.getSnapshot().externalChanges).toEqual([
      expect.objectContaining({ path: ENTRY_PATH, status: 'conflict' }),
    ]);
    await workflow.resolveExternalChange(ENTRY_PATH, 'overwrite');

    replaceButtonText(store, 'Race', 'Restored');
    await vi.waitFor(async () => expect(await host.readRecovery(source.id)).not.toBeNull());
    await workflow.dispose();
    const reopenedStore = new EditorStore({ host });
    const reopenedWorkflow = new FileWorkflow(reopenedStore, host, { adapter: new PersistenceTestAdapter() });
    await reopenedWorkflow.openProject(source);
    expect(reopenedStore.getSnapshot().session?.snapshot().files.get(ENTRY_PATH)?.text)
      .toBe('<UXML><Button text="Restored" /></UXML>\r\n');
    await reopenedWorkflow.dispose();
  });

  it('aborts before the first Save As write when source changes during destination preflight', async () => {
    const context = saveAsFailureFixture({
      [ENTRY_PATH]: '<UXML destination="main" />\n',
      'Assets/Second.uxml': '<UXML destination="second" />\n',
    });
    const { host, store, workflow, destination } = context;
    await openDirtySaveAsSource(context);
    const sourceSession = store.getSnapshot().session!;
    const destinationBefore = await Promise.all([
      host.readText(projectPath(destination, ENTRY_PATH)),
      host.readText(projectPath(destination, 'Assets/Second.uxml')),
    ]);
    host.queueConfirmation(true);
    const preflight = deferred<void>();
    const releasePreflight = deferred<void>();
    const readText = host.readText.bind(host);
    let destinationReads = 0;
    vi.spyOn(host, 'readText').mockImplementation(async (path) => {
      if (path.projectId === destination.id) {
        destinationReads += 1;
        if (destinationReads === 3) {
          preflight.resolve();
          await releasePreflight.promise;
        }
      }
      return readText(path);
    });

    const saving = workflow.saveAs(destination);
    await preflight.promise;
    replaceButtonText(store, 'Race', 'Preflight');
    releasePreflight.resolve();
    const error = await captureSaveAsFailure(saving);

    expectSaveAsConcurrencyFailure(error, [], [ENTRY_PATH, 'Assets/Second.uxml']);
    await expect(Promise.all([
      host.readText(projectPath(destination, ENTRY_PATH)),
      host.readText(projectPath(destination, 'Assets/Second.uxml')),
    ])).resolves.toEqual(destinationBefore);
    await expectConcurrentSourceRecoverable(context, sourceSession, 'Preflight');
  });

  it('reports one written path and preserves source recovery when source changes between Save As writes', async () => {
    const context = saveAsFailureFixture({});
    const { host, store, workflow, destination } = context;
    await openDirtySaveAsSource(context);
    const sourceSession = store.getSnapshot().session!;
    const firstWrite = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    const createText = host.createText.bind(host);
    let creates = 0;
    vi.spyOn(host, 'createText').mockImplementation(async (...arguments_) => {
      const revision = await createText(...arguments_);
      creates += 1;
      if (creates === 1) {
        firstWrite.resolve();
        await releaseFirstWrite.promise;
      }
      return revision;
    });

    const saving = workflow.saveAs(destination);
    await firstWrite.promise;
    replaceButtonText(store, 'Race', 'Between');
    releaseFirstWrite.resolve();
    const error = await captureSaveAsFailure(saving);

    expectSaveAsConcurrencyFailure(error, [ENTRY_PATH], ['Assets/Second.uxml']);
    await expect(host.readText(projectPath(destination, ENTRY_PATH))).resolves.toMatchObject({
      text: '<UXML><Button text="Race" /></UXML>\r\n',
    });
    await expect(host.readText(projectPath(destination, 'Assets/Second.uxml')))
      .rejects.toMatchObject({ code: 'not-found' });
    await expectConcurrentSourceRecoverable(context, sourceSession, 'Between');
  });

  it('disposes staged target authority when source changes during Save As runtime preparation', async () => {
    const context = saveAsFailureFixture({});
    const { host, store, workflow, source, destination } = context;
    const targetDispose = vi.fn();
    const watch = host.watch.bind(host);
    vi.spyOn(host, 'watch').mockImplementation(async (root, listener) => {
      const underlying = await watch(root, listener);
      return root.id === destination.id
        ? Object.freeze({
            dispose: () => {
              targetDispose();
              underlying.dispose();
            },
          })
        : underlying;
    });
    await openDirtySaveAsSource(context);
    const sourceSession = store.getSnapshot().session!;
    const recentPreparation = deferred<void>();
    const releaseRecentPreparation = deferred<void>();
    const listRecentProjects = host.listRecentProjects.bind(host);
    let recentReads = 0;
    vi.spyOn(host, 'listRecentProjects').mockImplementation(async () => {
      recentReads += 1;
      if (recentReads === 1) {
        recentPreparation.resolve();
        await releaseRecentPreparation.promise;
      }
      return listRecentProjects();
    });

    const saving = workflow.saveAs(destination);
    await recentPreparation.promise;
    replaceButtonText(store, 'Race', 'Prepared');
    releaseRecentPreparation.resolve();
    const error = await captureSaveAsFailure(saving);

    expectCompletedSaveAsFailure(error);
    expect(targetDispose).toHaveBeenCalledOnce();
    await host.externalWrite(projectPath(destination, ENTRY_PATH), '<UXML stale-target="true" />\n');
    await host.advanceTime(50);
    expect(workflow.getSnapshot().externalChanges).toEqual([]);
    expect(workflow.getSnapshot().projectName).toBe('Source');
    expect(store.getSnapshot().session).toBe(sourceSession);
    expect((await host.readRecovery(source.id))).not.toBeNull();
    await expectConcurrentSourceRecoverable(context, sourceSession, 'Prepared');
  });

  it('restores source authority and recovery when source changes during watcher retirement', async () => {
    const context = saveAsFailureFixture({});
    const { host, store, workflow, source, destination } = context;
    const sourceRetirement = deferred<DisposalOutcome>();
    const sourceDisposeStarted = deferred<void>();
    const targetDispose = vi.fn();
    const watch = host.watch.bind(host);
    let sourceWatches = 0;
    vi.spyOn(host, 'watch').mockImplementation(async (root, listener) => {
      const underlying = await watch(root, listener);
      if (root.id === source.id) {
        sourceWatches += 1;
        if (sourceWatches === 1) {
          return Object.freeze({
            dispose: () => {
              underlying.dispose();
              sourceDisposeStarted.resolve();
            },
            completion: sourceRetirement.promise,
          });
        }
        return underlying;
      }
      return Object.freeze({
        dispose: () => {
          targetDispose();
          underlying.dispose();
        },
      });
    });
    await openDirtySaveAsSource(context);
    const sourceSession = store.getSnapshot().session!;

    const saving = workflow.saveAs(destination);
    await sourceDisposeStarted.promise;
    replaceButtonText(store, 'Race', 'Retiring');
    sourceRetirement.resolve(Object.freeze({ status: 'disposed' }));
    const error = await captureSaveAsFailure(saving);

    expectCompletedSaveAsFailure(error);
    expect(targetDispose).toHaveBeenCalledOnce();
    expect(sourceWatches).toBe(2);
    await expectConcurrentSourceRecoverable(context, sourceSession, 'Retiring');
  });

  it('journals a source edit after history retirement while pending recovery drains', async () => {
    const context = saveAsFailureFixture({});
    const { host, store, workflow, source, destination } = context;
    const historyUnsubscribed = deferred<void>();
    const subscribe = CommandHistory.prototype.subscribe;
    vi.spyOn(CommandHistory.prototype, 'subscribe').mockImplementationOnce(function (
      this: CommandHistory,
      listener: Parameters<CommandHistory['subscribe']>[0],
    ) {
      const dispose = subscribe.call(this, listener);
      return () => {
        dispose();
        historyUnsubscribed.resolve();
      };
    });
    const sourceRetirement = deferred<DisposalOutcome>();
    const sourceDisposeStarted = deferred<void>();
    const targetDispose = vi.fn();
    const watch = host.watch.bind(host);
    let sourceWatches = 0;
    vi.spyOn(host, 'watch').mockImplementation(async (root, listener) => {
      const underlying = await watch(root, listener);
      if (root.id === source.id) {
        sourceWatches += 1;
        if (sourceWatches === 1) {
          return Object.freeze({
            dispose: () => {
              underlying.dispose();
              sourceDisposeStarted.resolve();
            },
            completion: sourceRetirement.promise,
          });
        }
        return underlying;
      }
      return Object.freeze({
        dispose: () => {
          targetDispose();
          underlying.dispose();
        },
      });
    });
    await openDirtySaveAsSource(context);
    const sourceSession = store.getSnapshot().session!;
    const appendStarted = deferred<void>();
    const releaseAppend = deferred<void>();
    const writeRecovery = host.writeRecovery.bind(host);
    let sourceAppendBlocked = false;
    vi.spyOn(host, 'writeRecovery').mockImplementation(async (project, stored) => {
      if (project === source.id && !sourceAppendBlocked) {
        sourceAppendBlocked = true;
        appendStarted.resolve();
        await releaseAppend.promise;
      }
      await writeRecovery(project, stored);
    });

    const saving = workflow.saveAs(destination);
    let saveAsSettled = false;
    void saving.then(
      () => { saveAsSettled = true; },
      () => { saveAsSettled = true; },
    );
    await sourceDisposeStarted.promise;
    replaceButtonText(store, 'Race', 'Queued');
    await appendStarted.promise;
    sourceRetirement.resolve(Object.freeze({ status: 'disposed' }));
    await historyUnsubscribed.promise;

    expect(saveAsSettled).toBe(false);
    replaceButtonText(store, 'Queued', 'Concurrent');
    releaseAppend.resolve();
    const error = await captureSaveAsFailure(saving);

    expectCompletedSaveAsFailure(error);
    expect(targetDispose).toHaveBeenCalledOnce();
    expect(sourceWatches).toBe(2);
    await expectConcurrentSourceRecoverable(context, sourceSession, 'Concurrent');
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

  it('waits for a delayed recovery append before ordinary Save writes and clears it', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    let releaseAppend!: () => void;
    const appendBlocked = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => { markAppendStarted = resolve; });
    const writeRecovery = host.writeRecovery.bind(host);
    let writes = 0;
    vi.spyOn(host, 'writeRecovery').mockImplementation(async (project, stored) => {
      writes += 1;
      if (writes === 1) {
        markAppendStarted();
        await appendBlocked;
      }
      await writeRecovery(project, stored);
    });
    editButtonText(store, 'Race');
    await appendStarted;
    let markSaveAdvanced!: () => void;
    const saveAdvanced = new Promise<void>((resolve) => { markSaveAdvanced = resolve; });
    const replaceText = host.replaceTextAtomically.bind(host);
    vi.spyOn(host, 'replaceTextAtomically').mockImplementation(async (...arguments_) => {
      markSaveAdvanced();
      return replaceText(...arguments_);
    });

    const saving = workflow.save();
    const earlyState = await Promise.race([
      saveAdvanced.then(() => 'advanced' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);

    expect(earlyState).toBe('blocked');
    expect((await host.readText(projectPath(root!, ENTRY_PATH))).text).toBe(INITIAL_SOURCE);

    releaseAppend();
    await saving;
    await workflow.closeProject();
    await workflow.reopenProject();
    expect(store.getSnapshot().session!.snapshot().files.get(ENTRY_PATH)!.text)
      .toBe('<UXML><Button text="Race" /></UXML>\r\n');
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

  it('clears discarded recovery before close so reopening cannot restore the edits', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    await vi.waitFor(async () => expect(await host.readRecovery(root!.id)).not.toBeNull());
    host.queueConfirmation(false);
    host.queueConfirmation(true);

    await workflow.closeProject();
    await workflow.reopenProject();

    expect(store.getSnapshot().session!.snapshot().files.get(ENTRY_PATH)!.text).toBe(INITIAL_SOURCE);
    expect(await host.readRecovery(root!.id)).toBeNull();
  });

  it('clears discarded recovery before replacement so reopening the old project cannot restore the edits', async () => {
    const host = new MemoryHost({
      projects: [
        { id: 'old', name: 'Old Project', files: { [ENTRY_PATH]: INITIAL_SOURCE } },
        { id: 'replacement', name: 'Replacement', files: { [ENTRY_PATH]: '<UXML replacement="true" />\n' } },
      ],
    });
    const oldRoot = Object.freeze({ id: projectId('old'), name: 'Old Project' });
    const replacementRoot = Object.freeze({ id: projectId('replacement'), name: 'Replacement' });
    const store = new EditorStore({ host });
    const workflow = new FileWorkflow(store, host, { adapter: new PersistenceTestAdapter() });
    await workflow.openProject(oldRoot);
    editButtonText(store, 'Race');
    await vi.waitFor(async () => expect(await host.readRecovery(oldRoot.id)).not.toBeNull());
    host.queueConfirmation(false);
    host.queueConfirmation(true);

    await workflow.openProject(replacementRoot);
    await workflow.openProject(oldRoot);

    expect(store.getSnapshot().session!.snapshot().files.get(ENTRY_PATH)!.text).toBe(INITIAL_SOURCE);
    expect(await host.readRecovery(oldRoot.id)).toBeNull();
  });

  it('clears discarded recovery before replacing the project with the same root', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    await vi.waitFor(async () => expect(await host.readRecovery(root!.id)).not.toBeNull());
    host.queueConfirmation(false);
    host.queueConfirmation(true);

    await workflow.openProject(root!);

    expect(store.getSnapshot().session!.snapshot().files.get(ENTRY_PATH)!.text).toBe(INITIAL_SOURCE);
    expect(workflow.getSnapshot().dirtyState).toBe('clean');
    expect(await host.readRecovery(root!.id)).toBeNull();
  });

  it('retains exact dirty source authority when replacement recovery is malformed', async () => {
    const context = replacementFailureFixture();
    const sourceRecovery = await openDirtyReplacementSource(context);
    await context.host.writeRecovery(context.replacement.id, '{"version":999}');
    context.host.queueConfirmation(false);
    context.host.queueConfirmation(true);

    await expect(context.workflow.openProject(context.replacement)).rejects.toThrow();

    await expectDirtyWatchedReplacementSource(context, sourceRecovery);
  });

  it('retains exact dirty source authority when replacement watcher setup fails', async () => {
    const context = replacementFailureFixture();
    const sourceRecovery = await openDirtyReplacementSource(context);
    vi.spyOn(context.host, 'watch').mockRejectedValueOnce(
      new HostError('read-failed', 'Injected replacement watcher setup failure.'),
    );
    context.host.queueConfirmation(false);
    context.host.queueConfirmation(true);

    await expect(context.workflow.openProject(context.replacement)).rejects.toThrow(
      'Injected replacement watcher setup failure.',
    );

    await expectDirtyWatchedReplacementSource(context, sourceRecovery);
  });

  it('retains source authority and disposes a staged replacement watcher when discard cleanup aborts', async () => {
    const context = replacementFailureFixture();
    const sourceRecovery = await openDirtyReplacementSource(context);
    const targetDispose = wrapNextWatch(context.host);
    context.host.injectFailure({ operation: 'clearRecovery', phase: 'before' });
    context.host.queueConfirmation(false);
    context.host.queueConfirmation(true);

    await context.workflow.openProject(context.replacement);

    expect(targetDispose).toHaveBeenCalledOnce();
    await expectDirtyWatchedReplacementSource(context, sourceRecovery);
  });

  it('retains source authority and disposes the staged watcher when replacement recent metadata read fails', async () => {
    const context = replacementFailureFixture();
    const sourceRecovery = await openDirtyReplacementSource(context);
    const targetDispose = wrapNextWatch(context.host);
    vi.spyOn(context.host, 'listRecentProjects').mockRejectedValueOnce(
      new HostError('app-data-failed', 'Injected recent metadata read failure.'),
    );
    context.host.queueConfirmation(false);
    context.host.queueConfirmation(true);

    await expect(context.workflow.openProject(context.replacement)).rejects.toThrow(
      'Injected recent metadata read failure.',
    );

    expect(targetDispose).toHaveBeenCalledOnce();
    await expectDirtyWatchedReplacementSource(context, sourceRecovery);
  });

  it('keeps the current project open and reports a discard cleanup failure', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    await workflow.openProject(root!);
    editButtonText(store, 'Race');
    await vi.waitFor(async () => expect(await host.readRecovery(root!.id)).not.toBeNull());
    const session = store.getSnapshot().session;
    host.queueConfirmation(false);
    host.queueConfirmation(true);
    host.injectFailure({ operation: 'clearRecovery', phase: 'before', message: 'cleanup unavailable' });

    await workflow.closeProject();

    expect(store.getSnapshot().session).toBe(session);
    expect(workflow.getSnapshot().dirtyState).toBe('dirty');
    expect(host.messageRequests.at(-1)).toMatchObject({
      kind: 'error',
      title: 'Changes not discarded',
    });
    expect(await host.readRecovery(root!.id)).not.toBeNull();
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

  it('awaits active watcher retirement before close completes', async () => {
    const { host, workflow } = fixture();
    const root = await host.chooseProject();
    const completion = deferred<DisposalOutcome>();
    const dispose = vi.fn();
    vi.spyOn(host, 'watch').mockResolvedValue(Object.freeze({ dispose, completion: completion.promise }));
    await workflow.openProject(root!);

    let settled = false;
    const closing = workflow.closeProject();
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(settled).toBe(false);
    completion.resolve(Object.freeze({ status: 'disposed' }));
    await closing;
    expect(workflow.getSnapshot().projectName).toBeNull();
  });

  it('reports failed watcher retirement and retains the source session as untitled', async () => {
    const { host, store, workflow } = fixture();
    const root = await host.chooseProject();
    const failure = new HostError('read-failed', 'Injected watcher retirement failure.');
    vi.spyOn(host, 'watch').mockResolvedValue(Object.freeze({
      dispose: vi.fn(),
      completion: Promise.resolve(Object.freeze({ status: 'failed' as const, error: failure })),
    }));
    await workflow.openProject(root!);
    const sourceSession = store.getSnapshot().session;

    await expect(workflow.closeProject()).rejects.toBe(failure);

    expect(store.getSnapshot().session).toBe(sourceSession);
    expect(workflow.getSnapshot()).toMatchObject({
      projectName: 'Untitled Project',
      dirtyState: 'dirty',
      canReload: false,
    });
    expect(host.messageRequests.at(-1)).toMatchObject({
      kind: 'error',
      title: 'Project cleanup failed',
      message: 'Injected watcher retirement failure.',
    });
  });

  it('prevents a retired watcher callback from publishing stale state', async () => {
    const { host, workflow } = fixture();
    const root = await host.chooseProject();
    let staleListener: FileChangeListener | undefined;
    vi.spyOn(host, 'watch').mockImplementation(async (_root, listener) => {
      staleListener = listener;
      return Object.freeze({
        dispose: vi.fn(),
        completion: Promise.resolve(Object.freeze({ status: 'disposed' as const })),
      });
    });
    await workflow.openProject(root!);
    const notifications = vi.fn();
    workflow.subscribe(notifications);
    await workflow.closeProject();
    notifications.mockClear();
    const disk = await host.readText(projectPath(root!, ENTRY_PATH));

    await staleListener?.(Object.freeze({
      kind: 'changed',
      path: projectPath(root!, ENTRY_PATH),
      revision: disk.revision,
    }));
    await host.advanceTime(50);

    expect(notifications).not.toHaveBeenCalled();
    expect(workflow.getSnapshot().externalChanges).toEqual([]);
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
  replaceButtonText(store, 'Play', replacement);
}

function replaceButtonText(store: EditorStore, current: string, replacement: string): void {
  const session = store.getSnapshot().session!;
  const source = session.snapshot().files.get(ENTRY_PATH)!.text;
  const start = source.indexOf(current);
  if (start < 0) throw new Error(`Button text ${current} is not present.`);
  session.history.execute({
    id: `set-button-text-${current}-to-${replacement}`,
    label: 'Set button text',
    patchesByFile: new Map([[ENTRY_PATH, [{ start, end: start + current.length, replacement }]]]),
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

function saveAsFailureFixture(destinationFiles: Readonly<Record<string, string>>) {
  const host = new MemoryHost({
    projects: [
      {
        id: 'source',
        name: 'Source',
        files: {
          [ENTRY_PATH]: INITIAL_SOURCE,
          'Assets/Second.uxml': '<UXML><Label text="Second" /></UXML>\n',
        },
      },
      { id: 'destination', name: 'Destination', files: destinationFiles },
    ],
  });
  const store = new EditorStore({ host, viewport: { width: 1280, height: 720 } });
  const workflow = new FileWorkflow(store, host, { adapter: new PersistenceTestAdapter() });
  return {
    host,
    store,
    workflow,
    source: Object.freeze({ id: projectId('source'), name: 'Source' }),
    destination: Object.freeze({ id: projectId('destination'), name: 'Destination' }),
  };
}

function replacementFailureFixture() {
  const host = new MemoryHost({
    projects: [
      { id: 'source', name: 'Source', files: { [ENTRY_PATH]: INITIAL_SOURCE } },
      { id: 'replacement', name: 'Replacement', files: { [ENTRY_PATH]: '<UXML replacement="true" />\n' } },
    ],
  });
  const store = new EditorStore({ host });
  return {
    host,
    store,
    workflow: new FileWorkflow(store, host, { adapter: new PersistenceTestAdapter() }),
    source: Object.freeze({ id: projectId('source'), name: 'Source' }),
    replacement: Object.freeze({ id: projectId('replacement'), name: 'Replacement' }),
  };
}

async function openDirtyReplacementSource(
  context: ReturnType<typeof replacementFailureFixture>,
): Promise<string> {
  await context.workflow.openProject(context.source);
  editButtonText(context.store, 'Race');
  await vi.waitFor(async () => expect(await context.host.readRecovery(context.source.id)).not.toBeNull());
  return (await context.host.readRecovery(context.source.id))!;
}

async function expectDirtyWatchedReplacementSource(
  context: ReturnType<typeof replacementFailureFixture>,
  expectedRecovery: string,
): Promise<void> {
  expect(context.workflow.getSnapshot()).toMatchObject({
    projectName: 'Source',
    dirtyState: 'dirty',
    canReload: true,
  });
  expect(context.store.getSnapshot().session?.snapshot().files.get(ENTRY_PATH)?.text)
    .toBe('<UXML><Button text="Race" /></UXML>\r\n');
  expect(await context.host.readRecovery(context.source.id)).toBe(expectedRecovery);
  await context.host.externalWrite(projectPath(context.source, ENTRY_PATH), '<UXML external="true" />\n');
  await context.host.advanceTime(50);
  expect(context.workflow.getSnapshot().externalChanges).toEqual([
    expect.objectContaining({ path: ENTRY_PATH, status: 'conflict' }),
  ]);
}

function wrapNextWatch(host: MemoryHost) {
  const dispose = vi.fn();
  const watch = host.watch.bind(host);
  vi.spyOn(host, 'watch').mockImplementationOnce(async (root, listener) => {
    const underlying = await watch(root, listener);
    return Object.freeze({
      dispose: () => {
        dispose();
        underlying.dispose();
      },
    });
  });
  return dispose;
}

async function openDirtySaveAsSource(context: ReturnType<typeof saveAsFailureFixture>): Promise<void> {
  await context.workflow.openProject(context.source);
  editButtonText(context.store, 'Race');
  await vi.waitFor(async () => expect(await context.host.readRecovery(context.source.id)).not.toBeNull());
}

async function expectDirtySourceAuthority(context: ReturnType<typeof saveAsFailureFixture>): Promise<void> {
  expect(context.workflow.getSnapshot()).toMatchObject({
    projectName: 'Source',
    dirtyState: 'dirty',
    canReload: true,
  });
  expect(context.store.getSnapshot().session?.snapshot().files.get(ENTRY_PATH)?.text)
    .toBe('<UXML><Button text="Race" /></UXML>\r\n');
  expect(await context.host.readRecovery(context.source.id)).not.toBeNull();
}

async function captureSaveAsFailure(operation: Promise<void>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected Save As to fail.');
}

function expectCompletedSaveAsFailure(error: unknown): void {
  expect(error).toMatchObject({
    name: 'SaveAsPartialError',
    writtenPaths: [ENTRY_PATH, 'Assets/Second.uxml'],
    pendingPaths: [],
  });
  const outcome = error as { readonly writtenPaths: readonly string[]; readonly pendingPaths: readonly string[] };
  expect(Object.isFrozen(outcome.writtenPaths)).toBe(true);
  expect(Object.isFrozen(outcome.pendingPaths)).toBe(true);
}

function expectSaveAsConcurrencyFailure(
  error: unknown,
  writtenPaths: readonly string[],
  pendingPaths: readonly string[],
): void {
  expect(error).toMatchObject({
    name: 'SaveAsPartialError',
    writtenPaths,
    pendingPaths,
  });
  const outcome = error as { readonly writtenPaths: readonly string[]; readonly pendingPaths: readonly string[] };
  expect(Object.isFrozen(outcome.writtenPaths)).toBe(true);
  expect(Object.isFrozen(outcome.pendingPaths)).toBe(true);
}

async function expectConcurrentSourceRecoverable(
  context: ReturnType<typeof saveAsFailureFixture>,
  sourceSession: NonNullable<ReturnType<EditorStore['getSnapshot']>['session']>,
  replacement: string,
): Promise<void> {
  expect(context.store.getSnapshot().session).toBe(sourceSession);
  expect(context.store.getSnapshot().projectAssets.map(({ path }) => path)).toEqual([
    ENTRY_PATH,
    'Assets/Second.uxml',
  ]);
  expect(context.workflow.getSnapshot()).toMatchObject({
    projectName: 'Source',
    dirtyState: 'dirty',
    canReload: true,
    capabilities: { saveAll: true, reloadProject: true },
  });
  await vi.waitFor(async () => expect(await context.host.readRecovery(context.source.id)).not.toBeNull());
  await context.workflow.dispose();

  const reopenedStore = new EditorStore({ host: context.host });
  const reopenedWorkflow = new FileWorkflow(reopenedStore, context.host, {
    adapter: new PersistenceTestAdapter(),
  });
  await reopenedWorkflow.openProject(context.source);
  expect(reopenedStore.getSnapshot().session?.snapshot().files.get(ENTRY_PATH)?.text)
    .toBe(`<UXML><Button text="${replacement}" /></UXML>\r\n`);
  await reopenedWorkflow.dispose();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
