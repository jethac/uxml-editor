import { describe, expect, it } from 'vitest';
import { HostError, projectId, projectPath } from '../host/HostPort';
import { MemoryHost } from '../host/MemoryHost';
import { SaveCoordinator } from './SaveCoordinator';
import { RecoveryJournal } from './RecoveryJournal';
import { openTestSession, PersistenceTestAdapter } from './persistenceTestSupport';

describe('SaveCoordinator', () => {
  it('rejects an initial revision snapshot from a different project root', async () => {
    const host = new MemoryHost({
      projects: [
        { id: 'project-a', name: 'Project A', files: { 'Main.uxml': '<UXML />' } },
        { id: 'project-b', name: 'Project B', files: { 'Main.uxml': '<UXML />' } },
      ],
    });
    const rootA = (await host.chooseProject())!;
    const rootB = Object.freeze({ id: projectId('project-b'), name: 'Project B' });
    const readFromB = await host.readText(projectPath(rootB, 'Main.uxml'));

    expect(() => new SaveCoordinator(host, rootA, [readFromB])).toThrow(expect.objectContaining({ code: 'root-not-granted' }));
  });

  it('returns an exact no-op without replacing byte-identical source', async () => {
    const source = '<UXML>\r\n</UXML>\r\n';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': source } }],
    });
    const root = (await host.chooseProject())!;
    const initial = await host.readText(projectPath(root, 'Main.uxml'));
    const session = openTestSession(new Map([['Main.uxml', source]]));
    const coordinator = new SaveCoordinator(host, root, [initial]);

    const outcome = await coordinator.save(session);

    expect(outcome).toEqual({
      status: 'noop',
      files: [{ path: 'Main.uxml', status: 'noop', revision: initial.revision }],
      dirtyPaths: [],
      recovery: 'not-requested',
      recoveryRequired: false,
    });
    expect((await host.readText(initial.path)).revision).toBe(initial.revision);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.files)).toBe(true);
  });

  it('does not clear recovery for a no-op that performed no confirmed write', async () => {
    const source = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': source } }],
    });
    const root = (await host.chooseProject())!;
    const initial = await host.readText(projectPath(root, 'Main.uxml'));
    await host.writeRecovery(root.id, 'pending-recovery');
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));

    const outcome = await coordinator.save(openTestSession(new Map([['Main.uxml', source]])));

    expect(outcome.recovery).toBe('not-requested');
    expect(await host.readRecovery(root.id)).toBe('pending-recovery');
  });

  it('refuses a dirty project write when durable recovery preparation is unavailable', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'requires-recovery',
      label: 'Edit main',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);

    const outcome = await coordinator.save(session);

    expect(outcome).toEqual({
      status: 'failed',
      files: [{
        path: 'Main.uxml',
        status: 'failed',
        error: {
          code: 'recovery-unsupported',
          message: 'Durable recovery preparation is required before project writes.',
        },
      }],
      dirtyPaths: ['Main.uxml'],
      recovery: 'failed',
      recoveryRequired: true,
      recoveryError: {
        code: 'recovery-unsupported',
        message: 'Durable recovery preparation is required before project writes.',
      },
    });
    expect(await host.readText(path)).toEqual(initial);
  });

  it('saves edited exact text with the recorded expected revision', async () => {
    const original = '<UXML>\r\n</UXML>\r\n';
    const edited = '<UXML><Button /></UXML>\n';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const initial = await host.readText(projectPath(root, 'Main.uxml'));
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'edit-main',
      label: 'Edit main',
      patchesByFile: new Map([['Main.uxml', [{ start: 0, end: original.length, replacement: edited }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));

    const outcome = await coordinator.save(session);

    const disk = await host.readText(initial.path);
    expect(outcome).toEqual({
      status: 'saved',
      files: [{ path: 'Main.uxml', status: 'saved', revision: disk.revision }],
      dirtyPaths: [],
      recovery: 'cleared',
      recoveryRequired: false,
    });
    expect(disk.text).toBe(edited);
  });

  it('reports a concurrent stale revision as a conflict without replacing external text', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'local-edit',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));
    await host.externalWrite(path, '<UXML><External /></UXML>');

    const outcome = await coordinator.save(session);

    expect(outcome).toEqual({
      status: 'conflict',
      files: [{
        path: 'Main.uxml',
        status: 'conflict',
        error: { code: 'stale-revision', message: 'File changed before replacement: Main.uxml' },
      }],
      dirtyPaths: ['Main.uxml'],
      recovery: 'not-requested',
      recoveryRequired: true,
    });
    expect((await host.readText(path)).text).toBe('<UXML><External /></UXML>');
  });

  it('aborts a save when the exact session generation changes during the preflight read', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'save-generation-1',
      label: 'First local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const journal = new RecoveryJournal(host, root);
    const coordinator = new SaveCoordinator(host, root, [initial], journal);
    const readGate = deferred<void>();
    let readStarted = false;
    let replacements = 0;
    const readText = host.readText.bind(host);
    const replaceText = host.replaceTextAtomically.bind(host);
    host.readText = async (candidate) => {
      readStarted = true;
      await readGate.promise;
      return readText(candidate);
    };
    host.replaceTextAtomically = async (...args) => {
      replacements += 1;
      return replaceText(...args);
    };

    const saving = coordinator.save(session);
    await waitFor(() => readStarted);
    expect(readStarted).toBe(true);
    session.history.execute({
      id: 'save-generation-2',
      label: 'Second local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });
    readGate.resolve();

    expect(await saving).toEqual({
      status: 'conflict',
      files: [{
        path: 'Main.uxml',
        status: 'conflict',
        error: { code: 'local-changed', message: 'Local source changed while preparing save: Main.uxml' },
      }],
      dirtyPaths: ['Main.uxml'],
      recovery: 'not-requested',
      recoveryRequired: true,
    });
    expect(replacements).toBe(0);
    expect((await readText(path)).text).toBe(original);
    const restored = openTestSession(new Map([['Main.uxml', original]]));
    await journal.recover(restored);
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe('<UXML   />');
  });

  it('replans recovery when local source changes while replacement is in flight', async () => {
    const original = '<UXML />';
    const firstEdit = '<UXML  />';
    const latestEdit = '<UXML   />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'replacement-generation-1',
      label: 'First local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const journal = new RecoveryJournal(host, root);
    const coordinator = new SaveCoordinator(host, root, [initial], journal);
    const replaceGate = deferred<void>();
    const replaceStarted = deferred<void>();
    const replaceText = host.replaceTextAtomically.bind(host);
    host.replaceTextAtomically = async (...args) => {
      replaceStarted.resolve();
      await replaceGate.promise;
      return replaceText(...args);
    };

    const saving = coordinator.save(session);
    await replaceStarted.promise;
    session.history.execute({
      id: 'replacement-generation-2',
      label: 'Second local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });
    replaceGate.resolve();

    expect(await saving).toMatchObject({
      status: 'partial',
      dirtyPaths: ['Main.uxml'],
      recoveryRequired: true,
      writeState: { writtenPaths: ['Main.uxml'], pendingPaths: ['Main.uxml'] },
    });
    expect((await host.readText(path)).text).toBe(firstEdit);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(latestEdit);

    const restored = openTestSession(new Map([['Main.uxml', firstEdit]]));
    await journal.recover(restored);
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe(latestEdit);
  });

  it('publishes a conflict when local state changes during an external read', async () => {
    const original = '<UXML />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    const coordinator = new SaveCoordinator(host, root, [initial]);
    await host.externalWrite(path, external);
    const readGate = deferred<void>();
    const readText = host.readText.bind(host);
    host.readText = async (candidate) => {
      await readGate.promise;
      return readText(candidate);
    };

    const processing = coordinator.processExternalChanges(session, ['Main.uxml']);
    await Promise.resolve();
    session.history.execute({
      id: 'edit-during-external-read',
      label: 'Edit during external read',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    readGate.resolve();

    expect(await processing).toEqual([{
      path: 'Main.uxml',
      status: 'conflict',
      external: 'changed',
      revision: (await readText(path)).revision,
      localDirty: true,
    }]);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe('<UXML  />');
  });

  it.each(['before', 'during'] as const)(
    'reports replacement failure %s commit and keeps the original file intact',
    async (phase) => {
      const original = '<UXML />';
      const host = new MemoryHost({
        projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
      });
      const root = (await host.chooseProject())!;
      const path = projectPath(root, 'Main.uxml');
      const initial = await host.readText(path);
      const session = openTestSession(new Map([['Main.uxml', original]]));
      session.commit({
        id: `edit-${phase}`,
        label: 'Edit main',
        patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
      });
      const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));
      host.injectFailure({ operation: 'replace', phase, message: `${phase} failure` });

      const outcome = await coordinator.save(session);

      expect(outcome).toEqual({
        status: 'failed',
        files: [{ path: 'Main.uxml', status: 'failed', error: { code: 'replace-failed', message: `${phase} failure` } }],
        dirtyPaths: ['Main.uxml'],
        recovery: 'not-requested',
        recoveryRequired: true,
      });
      expect(await host.readText(path)).toEqual(initial);
    },
  );

  it('saves all in canonical path order and reports a recoverable partial write', async () => {
    const originals = new Map([
      ['Main.uxml', '<UXML />'],
      ['A.uss', '.a { color: red; }'],
      ['B.uss', '.b { color: blue; }'],
    ]);
    const edited = new Map([
      ['Main.uxml', '<UXML> </UXML>'],
      ['A.uss', '.a { color: green; }'],
      ['B.uss', '.b { color: yellow; }'],
    ]);
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: Object.fromEntries(originals) }],
    });
    const root = (await host.chooseProject())!;
    const initial = await Promise.all([...originals.keys()].map((path) => host.readText(projectPath(root, path))));
    const session = openTestSession(originals);
    const committed = session.commit({
      id: 'edit-all',
      label: 'Edit all',
      patchesByFile: new Map([...originals].map(([path, text]) => [
        path,
        [{ start: 0, end: text.length, replacement: edited.get(path)! }],
      ])),
    });
    const journal = new RecoveryJournal(host, root);
    await journal.appendCommitted(committed);
    const coordinator = new SaveCoordinator(host, root, initial, journal);
    host.injectFailure({ operation: 'replace', phase: 'before', after: 1, message: 'second write failed' });

    const outcome = await coordinator.saveAll(session);

    const diskA = await host.readText(projectPath(root, 'A.uss'));
    expect(outcome).toEqual({
      status: 'partial',
      files: [
        { path: 'A.uss', status: 'saved', revision: diskA.revision },
        { path: 'B.uss', status: 'failed', error: { code: 'replace-failed', message: 'second write failed' } },
        { path: 'Main.uxml', status: 'skipped' },
      ],
      dirtyPaths: ['B.uss', 'Main.uxml'],
      recovery: 'not-requested',
      recoveryRequired: true,
      writeState: {
        writtenPaths: ['A.uss'],
        pendingPaths: ['B.uss', 'Main.uxml'],
      },
    });
    expect(diskA.text).toBe(edited.get('A.uss'));
    expect((await host.readText(projectPath(root, 'B.uss'))).text).toBe(originals.get('B.uss'));
    expect((await host.readText(projectPath(root, 'Main.uxml'))).text).toBe(originals.get('Main.uxml'));
    expect(await host.readRecovery(root.id)).not.toBeNull();

    const restored = openTestSession(new Map([
      ['Main.uxml', (await host.readText(projectPath(root, 'Main.uxml'))).text],
      ['A.uss', diskA.text],
      ['B.uss', (await host.readText(projectPath(root, 'B.uss'))).text],
    ]));
    await expect(journal.recover(restored)).resolves.toMatchObject({ status: 'recovered' });
    expect(new Map([...restored.snapshot().files].map(([path, buffer]) => [path, buffer.text]))).toEqual(edited);
  });

  it('persists recovery before the first save-all replacement and stops if checkpointing fails', async () => {
    const originals = new Map([
      ['Main.uxml', '<UXML />'],
      ['A.uss', '.a { color: red; }'],
    ]);
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: Object.fromEntries(originals) }],
    });
    const root = (await host.chooseProject())!;
    const initial = await Promise.all([...originals.keys()].map((path) => host.readText(projectPath(root, path))));
    const session = openTestSession(originals);
    session.commit({
      id: 'checkpoint-before-write',
      label: 'Edit all',
      patchesByFile: new Map([
        ['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]],
        ['A.uss', [{ start: 12, end: 15, replacement: 'green' }]],
      ]),
    });
    const journal = new RecoveryJournal(host, root);
    const coordinator = new SaveCoordinator(host, root, initial, journal);
    host.injectFailure({ operation: 'writeRecovery', phase: 'before' });

    expect(await coordinator.saveAll(session)).toEqual({
      status: 'failed',
      files: [
        {
          path: 'A.uss',
          status: 'failed',
          error: {
            code: 'recovery-prepare-failed',
            message: 'Recovery state could not be persisted before save.',
          },
        },
        { path: 'Main.uxml', status: 'skipped' },
      ],
      dirtyPaths: ['A.uss', 'Main.uxml'],
      recovery: 'failed',
      recoveryRequired: true,
      recoveryError: {
        code: 'recovery-prepare-failed',
        message: 'Recovery state could not be persisted before save.',
      },
    });
    for (const [path, text] of originals) {
      expect((await host.readText(projectPath(root, path))).text).toBe(text);
    }
  });

  it('replans a checkpoint when local source changes while app-data persistence is pending', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'checkpoint-generation-1',
      label: 'First local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const journal = new RecoveryJournal(host, root);
    const coordinator = new SaveCoordinator(host, root, [initial], journal);
    const checkpointGate = deferred<void>();
    const checkpointStarted = deferred<void>();
    const writeRecovery = host.writeRecovery.bind(host);
    let firstCheckpoint = true;
    host.writeRecovery = async (...args) => {
      if (firstCheckpoint) {
        firstCheckpoint = false;
        checkpointStarted.resolve();
        await checkpointGate.promise;
      }
      return writeRecovery(...args);
    };

    const saving = coordinator.save(session);
    await checkpointStarted.promise;
    session.history.execute({
      id: 'checkpoint-generation-2',
      label: 'Second local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });
    checkpointGate.resolve();

    expect(await saving).toMatchObject({ status: 'conflict', dirtyPaths: ['Main.uxml'], recoveryRequired: true });
    expect((await host.readText(path)).text).toBe(original);
    const restored = openTestSession(new Map([['Main.uxml', original]]));
    await journal.recover(restored);
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe('<UXML   />');
  });

  it('reloads a clean external change atomically through DocumentSession', async () => {
    const original = '<UXML />\r\n';
    const external = '<UXML><Button /></UXML>\n';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const revision = await host.externalWrite(path, external);

    const outcomes = await coordinator.processExternalChanges(session, ['Main.uxml']);

    expect(outcomes).toEqual([{
      path: 'Main.uxml',
      status: 'reloaded',
      external: 'changed',
      revision,
      localDirty: false,
    }]);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(external);
    expect(coordinator.dirtyPaths(session)).toEqual([]);
    expect(Object.isFrozen(outcomes)).toBe(true);
    expect(Object.isFrozen(outcomes[0])).toBe(true);
  });

  it('records a clean external reload as an undoable and redoable history transaction', async () => {
    const original = '<UXML />';
    const locallySaved = '<UXML  />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'saved-before-clean-reload',
      label: 'Saved edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));
    await coordinator.save(session);
    await host.externalWrite(path, external);

    await coordinator.processExternalChanges(session, ['Main.uxml']);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(external);
    session.history.undo();
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(locallySaved);
    session.history.redo();
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(external);
  });

  it('reports a dirty external edit as a conflict without changing local or disk text', async () => {
    const original = '<UXML />';
    const local = '<UXML  />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'local-edit',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const revision = await host.externalWrite(path, external);

    expect(await coordinator.processExternalChanges(session, ['Main.uxml'])).toEqual([{
      path: 'Main.uxml',
      status: 'conflict',
      external: 'changed',
      revision,
      localDirty: true,
    }]);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(local);
    expect((await host.readText(path)).text).toBe(external);
  });

  it('treats a same-content same-revision rewrite as unchanged even while locally dirty', async () => {
    const original = '<UXML />\r\n';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'local-edit',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const rewrittenRevision = await host.externalWrite(path, original);

    expect(await coordinator.processExternalChanges(session, ['Main.uxml'])).toEqual([{
      path: 'Main.uxml',
      status: 'unchanged',
      external: 'changed',
      revision: initial.revision,
      localDirty: true,
    }]);
    expect(rewrittenRevision).toBe(initial.revision);
    expect(coordinator.dirtyPaths(session)).toEqual(['Main.uxml']);
  });

  it('adopts a changed revision when disk and dirty local text converge exactly', async () => {
    const original = '<UXML />';
    const converged = '<UXML  />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'converged-local',
      label: 'Converged local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const revision = await host.externalWrite(path, converged);

    expect(await coordinator.processExternalChanges(session, ['Main.uxml'])).toEqual([{
      path: 'Main.uxml',
      status: 'unchanged',
      external: 'changed',
      revision,
      localDirty: false,
    }]);
    expect(coordinator.dirtyPaths(session)).toEqual([]);
    expect(await coordinator.save(session)).toMatchObject({
      status: 'noop',
      files: [{ path: 'Main.uxml', status: 'noop', revision }],
    });
  });

  it('reports external deletion without discarding the in-memory source', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    const coordinator = new SaveCoordinator(host, root, [initial]);
    await host.externalDelete(path);

    expect(await coordinator.processExternalChanges(session, ['Main.uxml'])).toEqual([{
      path: 'Main.uxml',
      status: 'deleted',
      external: 'deleted',
      localDirty: false,
    }]);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(original);
  });

  it('reports deletion of a locally dirty file as a conflict', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'dirty-delete',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    await host.externalDelete(path);

    expect(await coordinator.processExternalChanges(session, ['Main.uxml'])).toEqual([{
      path: 'Main.uxml',
      status: 'conflict',
      external: 'deleted',
      localDirty: true,
    }]);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe('<UXML  />');
  });

  it('cancels a dirty external conflict without changing either side', async () => {
    const original = '<UXML />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'local-cancel',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const revision = await host.externalWrite(path, external);
    await coordinator.processExternalChanges(session, ['Main.uxml']);

    const outcome = await coordinator.resolveExternalChange(session, 'Main.uxml', 'cancel');

    expect(outcome).toEqual({
      path: 'Main.uxml',
      decision: 'cancel',
      status: 'cancelled',
      external: 'changed',
      revision,
      localDirty: true,
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe('<UXML  />');
    expect((await host.readText(path)).text).toBe(external);
  });

  it('reloads the observed external text when the user chooses reload', async () => {
    const original = '<UXML />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'local-reload',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const revision = await host.externalWrite(path, external);
    await coordinator.processExternalChanges(session, ['Main.uxml']);

    expect(await coordinator.resolveExternalChange(session, 'Main.uxml', 'reload')).toEqual({
      path: 'Main.uxml',
      decision: 'reload',
      status: 'reloaded',
      external: 'changed',
      revision,
      localDirty: false,
    });
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(external);
    expect(coordinator.dirtyPaths(session)).toEqual([]);
  });

  it('returns a deleted resolution when the file disappears before explicit reload', async () => {
    const original = '<UXML />';
    const local = '<UXML  />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'reload-after-delete',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    await host.externalWrite(path, '<UXML><External /></UXML>');
    await coordinator.processExternalChanges(session, ['Main.uxml']);
    await host.externalDelete(path);

    expect(await coordinator.resolveExternalChange(session, 'Main.uxml', 'reload')).toEqual({
      path: 'Main.uxml',
      decision: 'reload',
      status: 'deleted',
      external: 'deleted',
      localDirty: true,
    });
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(local);
    expect((await coordinator.resolveExternalChange(session, 'Main.uxml', 'reload')).status).toBe('deleted');
  });

  it('returns a failed resolution when explicit reload cannot read the file', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'reload-after-read-failure',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const externalRevision = await host.externalWrite(path, '<UXML><External /></UXML>');
    await coordinator.processExternalChanges(session, ['Main.uxml']);
    host.readText = async () => { throw new HostError('read-failed', 'Project permission was lost.'); };

    expect(await coordinator.resolveExternalChange(session, 'Main.uxml', 'reload')).toEqual({
      path: 'Main.uxml',
      decision: 'reload',
      status: 'failed',
      external: 'changed',
      revision: externalRevision,
      localDirty: true,
      error: { code: 'read-failed', message: 'Project permission was lost.' },
    });
  });

  it('records an explicit dirty-conflict reload with coherent undo and redo semantics', async () => {
    const original = '<UXML />';
    const local = '<UXML  />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'dirty-before-history-reload',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    await host.externalWrite(path, external);
    await coordinator.processExternalChanges(session, ['Main.uxml']);

    expect((await coordinator.resolveExternalChange(session, 'Main.uxml', 'reload')).status).toBe('reloaded');
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(external);
    session.history.undo();
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(local);
    session.history.redo();
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(external);
  });

  it('overwrites the observed external revision when the user chooses overwrite', async () => {
    const original = '<UXML />';
    const local = '<UXML  />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'local-overwrite',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));
    await host.externalWrite(path, external);
    await coordinator.processExternalChanges(session, ['Main.uxml']);

    const outcome = await coordinator.resolveExternalChange(session, 'Main.uxml', 'overwrite');
    const disk = await host.readText(path);

    expect(outcome).toEqual({
      path: 'Main.uxml',
      decision: 'overwrite',
      status: 'overwritten',
      external: 'changed',
      revision: disk.revision,
      localDirty: false,
    });
    expect(disk.text).toBe(local);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(local);
    expect(coordinator.dirtyPaths(session)).toEqual([]);
  });

  it('refuses an external overwrite when durable recovery preparation is unavailable', async () => {
    const original = '<UXML />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'local-overwrite-without-recovery',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const externalRevision = await host.externalWrite(path, external);
    await coordinator.processExternalChanges(session, ['Main.uxml']);

    const outcome = await coordinator.resolveExternalChange(session, 'Main.uxml', 'overwrite');

    expect(outcome).toEqual({
      path: 'Main.uxml',
      decision: 'overwrite',
      status: 'failed',
      external: 'changed',
      revision: externalRevision,
      localDirty: true,
      error: {
        code: 'recovery-unsupported',
        message: 'Durable recovery preparation is required before project writes.',
      },
    });
    expect((await host.readText(path)).text).toBe(external);
  });

  it('prepares exact recovery before an external overwrite replacement', async () => {
    const original = '<UXML />';
    const local = '<UXML  />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'recoverable-overwrite',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const journal = new RecoveryJournal(host, root);
    const coordinator = new SaveCoordinator(host, root, [initial], journal);
    const externalRevision = await host.externalWrite(path, external);
    await coordinator.processExternalChanges(session, ['Main.uxml']);
    host.injectFailure({ operation: 'replace', phase: 'before', message: 'replacement failed' });

    expect(await coordinator.resolveExternalChange(session, 'Main.uxml', 'overwrite')).toEqual({
      path: 'Main.uxml',
      decision: 'overwrite',
      status: 'failed',
      external: 'changed',
      revision: externalRevision,
      localDirty: true,
      error: { code: 'replace-failed', message: 'replacement failed' },
    });
    expect((await host.readText(path)).text).toBe(external);

    const restored = openTestSession(new Map([['Main.uxml', external]]));
    expect(await journal.recover(restored)).toMatchObject({ status: 'recovered', recordCount: 1 });
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe(local);
  });

  it('does not publish a synchronized overwrite when local source changes in flight', async () => {
    const original = '<UXML />';
    const capturedLocal = '<UXML  />';
    const latestLocal = '<UXML   />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'overwrite-generation-1',
      label: 'First local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));
    await host.externalWrite(path, external);
    await coordinator.processExternalChanges(session, ['Main.uxml']);
    const replaceGate = deferred<void>();
    const replaceStarted = deferred<void>();
    const replaceText = host.replaceTextAtomically.bind(host);
    host.replaceTextAtomically = async (...args) => {
      replaceStarted.resolve();
      await replaceGate.promise;
      return replaceText(...args);
    };

    const overwriting = coordinator.resolveExternalChange(session, 'Main.uxml', 'overwrite');
    await replaceStarted.promise;
    session.history.execute({
      id: 'overwrite-generation-2',
      label: 'Second local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });
    replaceGate.resolve();
    const disk = await overwriting.then(async (outcome) => ({ outcome, read: await host.readText(path) }));

    expect(disk.outcome).toEqual({
      path: 'Main.uxml',
      decision: 'overwrite',
      status: 'conflict',
      external: 'changed',
      revision: disk.read.revision,
      localDirty: true,
      error: { code: 'local-changed', message: 'Local source changed while preparing overwrite: Main.uxml' },
    });
    expect(disk.read.text).toBe(capturedLocal);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(latestLocal);
    expect(coordinator.dirtyPaths(session)).toEqual(['Main.uxml']);
  });

  it('debounces watcher bursts deterministically and suppresses callbacks after disposal', async () => {
    const original = '<UXML />';
    const second = '<UXML><Second /></UXML>';
    const third = '<UXML><Third /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const deliveries: unknown[] = [];
    const watcher = await coordinator.watch(() => session, (outcomes) => { deliveries.push(outcomes); }, 50);

    await host.externalWrite(path, '<UXML><First /></UXML>');
    const secondRevision = await host.externalWrite(path, second);
    await host.advanceTime(49);
    expect(deliveries).toEqual([]);
    await host.advanceTime(1);
    expect(deliveries).toEqual([[
      { path: 'Main.uxml', status: 'reloaded', external: 'changed', revision: secondRevision, localDirty: false },
    ]]);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(second);

    await host.externalWrite(path, third);
    watcher.dispose();
    await host.advanceTime(50);
    expect(deliveries).toHaveLength(1);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(second);
  });

  it('does not mutate the session when disposal occurs during a debounced external read', async () => {
    const original = '<UXML />';
    const external = '<UXML><External /></UXML>';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const deliveries: unknown[] = [];
    const watcher = await coordinator.watch(() => session, (outcomes) => { deliveries.push(outcomes); }, 10);
    const readGate = deferred<void>();
    const readStarted = deferred<void>();
    const readText = host.readText.bind(host);
    host.readText = async (candidate) => {
      readStarted.resolve();
      await readGate.promise;
      return readText(candidate);
    };

    await host.externalWrite(path, external);
    const advancing = host.advanceTime(10);
    await readStarted.promise;
    watcher.dispose();
    readGate.resolve();
    await advancing;

    expect(deliveries).toEqual([]);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(original);
    expect(coordinator.dirtyPaths(session)).toEqual([]);
  });

  it('ignores watched paths outside the exact open session, including prefix-confusable names', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{
        id: 'project-a',
        name: 'Project A',
        files: {
          'Main.uxml': original,
          'Main.uxml.backup': 'backup',
          'Other.txt': 'other',
        },
      }],
    });
    const root = (await host.chooseProject())!;
    const mainPath = projectPath(root, 'Main.uxml');
    const initial = await host.readText(mainPath);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const deliveries: unknown[] = [];
    const watcher = await coordinator.watch(() => session, (outcomes) => { deliveries.push(outcomes); }, 10);

    await host.externalWrite(projectPath(root, 'Main.uxml.backup'), 'changed backup');
    await host.externalWrite(projectPath(root, 'Other.txt'), 'changed other');
    await expect(host.advanceTime(10)).resolves.toBeUndefined();
    expect(deliveries).toEqual([]);

    const revision = await host.externalWrite(mainPath, '<UXML><External /></UXML>');
    await host.externalWrite(projectPath(root, 'Main.uxml.backup'), 'changed again');
    await host.advanceTime(10);
    expect(deliveries).toEqual([[
      { path: 'Main.uxml', status: 'reloaded', external: 'changed', revision, localDirty: false },
    ]]);
    watcher.dispose();
  });

  it('reports a failed clean reload without publishing a partial DocumentSession', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const adapter = new PersistenceTestAdapter();
    const session = openTestSession(new Map([['Main.uxml', original]]), 'Main.uxml', adapter);
    const coordinator = new SaveCoordinator(host, root, [initial]);
    adapter.failWhenSourceIncludes = '<broken';
    const revision = await host.externalWrite(path, '<broken />');

    expect(await coordinator.processExternalChanges(session, ['Main.uxml'])).toEqual([{
      path: 'Main.uxml',
      status: 'reload-failed',
      external: 'changed',
      revision,
      localDirty: false,
      error: { code: 'reload-failed', message: 'External reload failed for Main.uxml.' },
    }]);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(original);
  });

  it('clears recovery only after a fully confirmed successful save', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'save-and-clean',
      label: 'Edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    await host.writeRecovery(root.id, '{"version":1}');
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));

    const outcome = await coordinator.save(session);

    expect(outcome.recovery).toBe('cleared');
    expect(outcome.recoveryRequired).toBe(false);
    expect(await host.readRecovery(root.id)).toBeNull();
  });

  it('clears recovery after save-all confirms every dirty file', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const initial = await host.readText(projectPath(root, 'Main.uxml'));
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'save-all-clean',
      label: 'Edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    await host.writeRecovery(root.id, '{"version":1}');
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));

    const outcome = await coordinator.saveAll(session);

    expect(outcome.recovery).toBe('cleared');
    expect(await host.readRecovery(root.id)).toBeNull();
  });

  it('retries cleanup on the next no-op without rewriting a synchronized file', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const initial = await host.readText(projectPath(root, 'Main.uxml'));
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'cleanup-failure',
      label: 'Edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));
    host.injectFailure({ operation: 'clearRecovery', phase: 'before', message: 'app-data unavailable' });

    const outcome = await coordinator.save(session);

    expect(outcome.status).toBe('saved');
    expect(outcome.recovery).toBe('failed');
    expect(outcome.recoveryError).toEqual({ code: 'cleanup-failed', message: 'Recovery journal cleanup failed.' });
    expect(outcome.recoveryRequired).toBe(true);
    expect(await host.readRecovery(root.id)).not.toBeNull();
    const savedRevision = (await host.readText(initial.path)).revision;

    const retried = await coordinator.save(session);

    expect(retried).toEqual({
      status: 'noop',
      files: [{ path: 'Main.uxml', status: 'noop', revision: savedRevision }],
      dirtyPaths: [],
      recovery: 'cleared',
      recoveryRequired: false,
    });
    expect((await host.readText(initial.path)).revision).toBe(savedRevision);
    expect(await host.readRecovery(root.id)).toBeNull();
  });

  it('exposes an immutable explicit retry outcome for pending recovery cleanup', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const initial = await host.readText(projectPath(root, 'Main.uxml'));
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.commit({
      id: 'explicit-cleanup-retry',
      label: 'Edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial], new RecoveryJournal(host, root));
    host.injectFailure({ operation: 'clearRecovery', phase: 'before' });
    expect((await coordinator.save(session)).recovery).toBe('failed');
    const savedRevision = (await host.readText(initial.path)).revision;

    const retried = await coordinator.retryRecoveryCleanup(session);

    expect(retried).toEqual({ status: 'cleared', recoveryRequired: false });
    expect(Object.isFrozen(retried)).toBe(true);
    expect((await host.readText(initial.path)).revision).toBe(savedRevision);
    expect(await host.readRecovery(root.id)).toBeNull();
  });

  it('recreates recovery when local source changes during an explicit cleanup retry', async () => {
    const original = '<UXML />';
    const saved = '<UXML  />';
    const latest = '<UXML   />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'retry-cleanup-generation-1',
      label: 'Saved edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const journal = new RecoveryJournal(host, root);
    const coordinator = new SaveCoordinator(host, root, [initial], journal);
    host.injectFailure({ operation: 'clearRecovery', phase: 'before' });
    expect((await coordinator.save(session)).recovery).toBe('failed');
    const cleanupGate = deferred<void>();
    const cleanupStarted = deferred<void>();
    const clearRecovery = host.clearRecovery.bind(host);
    host.clearRecovery = async (id) => {
      cleanupStarted.resolve();
      await cleanupGate.promise;
      return clearRecovery(id);
    };

    const retrying = coordinator.retryRecoveryCleanup(session);
    await cleanupStarted.promise;
    session.history.execute({
      id: 'retry-cleanup-generation-2',
      label: 'Edit during cleanup retry',
      patchesByFile: new Map([['Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });
    cleanupGate.resolve();

    expect(await retrying).toEqual({ status: 'retained', recoveryRequired: true });
    expect((await host.readText(path)).text).toBe(saved);
    const restored = openTestSession(new Map([['Main.uxml', saved]]));
    await journal.recover(restored);
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe(latest);
  });

  it('recreates recovery before publishing when local source changes during cleanup', async () => {
    const original = '<UXML />';
    const saved = '<UXML  />';
    const latest = '<UXML   />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'cleanup-generation-1',
      label: 'First edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const journal = new RecoveryJournal(host, root);
    const coordinator = new SaveCoordinator(host, root, [initial], journal);
    const cleanupGate = deferred<void>();
    const cleanupStarted = deferred<void>();
    const clearRecovery = host.clearRecovery.bind(host);
    host.clearRecovery = async (id) => {
      cleanupStarted.resolve();
      await cleanupGate.promise;
      return clearRecovery(id);
    };

    const saving = coordinator.save(session);
    await cleanupStarted.promise;
    session.history.execute({
      id: 'cleanup-generation-2',
      label: 'Second edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });
    cleanupGate.resolve();

    expect(await saving).toMatchObject({
      status: 'partial',
      dirtyPaths: ['Main.uxml'],
      recovery: 'retained',
      recoveryRequired: true,
      writeState: { writtenPaths: ['Main.uxml'], pendingPaths: ['Main.uxml'] },
    });
    expect((await host.readText(path)).text).toBe(saved);
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe(latest);
    const restored = openTestSession(new Map([['Main.uxml', saved]]));
    await journal.recover(restored);
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe(latest);
  });

  it('refreshes retained recovery when cleanup fails after a concurrent local edit', async () => {
    const original = '<UXML />';
    const saved = '<UXML  />';
    const latest = '<UXML   />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const session = openTestSession(new Map([['Main.uxml', original]]));
    session.history.execute({
      id: 'failed-cleanup-generation-1',
      label: 'First edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const journal = new RecoveryJournal(host, root);
    const coordinator = new SaveCoordinator(host, root, [initial], journal);
    const cleanupGate = deferred<void>();
    const cleanupStarted = deferred<void>();
    host.clearRecovery = async () => {
      cleanupStarted.resolve();
      await cleanupGate.promise;
      throw Object.assign(new Error('cleanup unavailable'), { code: 'app-data-failed' });
    };

    const saving = coordinator.save(session);
    await cleanupStarted.promise;
    session.history.execute({
      id: 'failed-cleanup-generation-2',
      label: 'Second edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 7, end: 7, replacement: ' ' }]]]),
    });
    cleanupGate.resolve();

    expect(await saving).toMatchObject({
      status: 'partial',
      dirtyPaths: ['Main.uxml'],
      recovery: 'failed',
      recoveryRequired: true,
      recoveryError: { code: 'cleanup-failed', message: 'Recovery journal cleanup failed.' },
    });
    expect((await host.readText(path)).text).toBe(saved);
    const restored = openTestSession(new Map([['Main.uxml', saved]]));
    await journal.recover(restored);
    expect(restored.snapshot().files.get('Main.uxml')?.text).toBe(latest);
  });

  it('reports parse failure during an explicit reload decision without changing local text', async () => {
    const original = '<UXML />';
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': original } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const initial = await host.readText(path);
    const adapter = new PersistenceTestAdapter();
    const session = openTestSession(new Map([['Main.uxml', original]]), 'Main.uxml', adapter);
    session.commit({
      id: 'dirty-before-broken-reload',
      label: 'Local edit',
      patchesByFile: new Map([['Main.uxml', [{ start: 6, end: 6, replacement: ' ' }]]]),
    });
    const coordinator = new SaveCoordinator(host, root, [initial]);
    const revision = await host.externalWrite(path, '<broken />');
    await coordinator.processExternalChanges(session, ['Main.uxml']);
    adapter.failWhenSourceIncludes = '<broken';

    expect(await coordinator.resolveExternalChange(session, 'Main.uxml', 'reload')).toEqual({
      path: 'Main.uxml',
      decision: 'reload',
      status: 'failed',
      external: 'changed',
      revision,
      localDirty: true,
      error: { code: 'reload-failed', message: 'External reload failed for Main.uxml.' },
    });
    expect(session.snapshot().files.get('Main.uxml')?.text).toBe('<UXML  />');
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition did not become true within deterministic microtask bound.');
}
