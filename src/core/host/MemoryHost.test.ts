import { describe, expect, it } from 'vitest';
import { projectId, projectPath } from './HostPort';
import { MemoryHost } from './MemoryHost';

describe('MemoryHost', () => {
  it('publishes frozen deterministic host capabilities', () => {
    const host = new MemoryHost();

    expect(host.capabilities).toEqual({
      mode: 'memory',
      projectSelection: 'deterministic',
      atomicReplace: 'guaranteed',
      watch: 'deterministic',
      appData: 'memory',
      dialogs: 'deterministic',
    });
    expect(Object.isFrozen(host.capabilities)).toBe(true);
  });

  it('selects a granted project and reads an exact immutable text snapshot', async () => {
    const host = new MemoryHost({
      projects: [{
        id: 'project-a',
        name: 'Project A',
        files: { 'Assets\\UI\\Main.uxml': '<UXML>\r\n</UXML>\r\n' },
      }],
    });

    const root = await host.chooseProject();
    expect(root).toEqual({ id: 'project-a', name: 'Project A' });
    expect(Object.isFrozen(root)).toBe(true);

    const read = await host.readText(projectPath(root!, 'Assets/UI/./Main.uxml'));
    expect(read.text).toBe('<UXML>\r\n</UXML>\r\n');
    expect(read.path.relativePath).toBe('Assets/UI/Main.uxml');
    expect(read.revision).toMatch(/^memory:v1:/);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.path)).toBe(true);
  });

  it('enumerates one project root in frozen deterministic path order', async () => {
    const host = new MemoryHost({
      projects: [
        {
          id: 'project-a',
          name: 'Project A',
          files: {
            'Packages/com.example/theme.uss': 'package',
            'Assets/UI/screen.uxml': 'screen',
            'Assets/UI/base.uss': 'base',
          },
        },
        { id: 'project-b', name: 'Project B', files: { 'Assets/Other.uxml': 'other' } },
      ],
    });
    const root = (await host.chooseProject())!;

    const result = await host.enumerateFiles(root);

    expect(result).toEqual({
      status: 'supported',
      files: [
        { projectId: 'project-a', relativePath: 'Assets/UI/base.uss' },
        { projectId: 'project-a', relativePath: 'Assets/UI/screen.uxml' },
        { projectId: 'project-a', relativePath: 'Packages/com.example/theme.uss' },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === 'supported') {
      expect(Object.isFrozen(result.files)).toBe(true);
      expect(result.files.every(Object.isFrozen)).toBe(true);
    }
  });

  it.each(['../outside.uxml', '/absolute.uxml', 'C:\\outside.uxml', 'file:///outside.uxml'])(
    'rejects a path outside the granted root: %s',
    (candidate) => {
      const root = Object.freeze({ id: 'project-a', name: 'Project A' }) as Awaited<ReturnType<MemoryHost['chooseProject']>>;
      expect(() => projectPath(root!, candidate)).toThrow(expect.objectContaining({ code: 'invalid-path' }));
    },
  );

  it('compares the expected revision before replacing exact text', async () => {
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': 'original\r\n' } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const original = await host.readText(path);

    const replacement = await host.replaceTextAtomically(path, original.revision, 'new\ntext\n');
    expect(replacement).not.toBe(original.revision);
    await expect(host.replaceTextAtomically(path, original.revision, 'stale')).rejects.toMatchObject({
      code: 'stale-revision',
    });
    expect(await host.readText(path)).toMatchObject({ text: 'new\ntext\n', revision: replacement });
  });

  it.each(['before', 'during'] as const)(
    'keeps the original text and revision when replacement fails %s commit',
    async (phase) => {
      const host = new MemoryHost({
        projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': 'original' } }],
      });
      const root = (await host.chooseProject())!;
      const path = projectPath(root, 'Main.uxml');
      const original = await host.readText(path);
      host.injectFailure({ operation: 'replace', phase, message: `${phase} failure` });

      await expect(host.replaceTextAtomically(path, original.revision, 'replacement')).rejects.toMatchObject({
        code: 'replace-failed',
        message: `${phase} failure`,
      });
      expect(await host.readText(path)).toEqual(original);
    },
  );

  it('emits immutable external write/delete events and never calls a disposed watcher', async () => {
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': 'one' } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const events: unknown[] = [];
    const watcher = await host.watch(root, (event) => { events.push(event); });

    const changedRevision = await host.externalWrite(path, 'two');
    await host.externalDelete(path);
    expect(events).toEqual([
      { kind: 'changed', path, revision: changedRevision },
      { kind: 'deleted', path },
    ]);
    expect(events.every(Object.isFrozen)).toBe(true);

    watcher.dispose();
    await host.externalWrite(path, 'three');
    expect(events).toHaveLength(2);
  });

  it('keeps the revision stable when an external rewrite preserves exact content', async () => {
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': 'same\r\ntext' } }],
    });
    const root = (await host.chooseProject())!;
    const path = projectPath(root, 'Main.uxml');
    const original = await host.readText(path);

    const rewrittenRevision = await host.externalWrite(path, 'same\r\ntext');

    expect(rewrittenRevision).toBe(original.revision);
    expect(await host.readText(path)).toEqual(original);
  });

  it('advances scheduled work deterministically without wall-clock sleeps', async () => {
    const host = new MemoryHost({ initialTime: 1_000 });
    const calls: string[] = [];
    const disposed = host.schedule(10, () => { calls.push('disposed'); });
    host.schedule(20, () => { calls.push(`late:${host.now()}`); });
    host.schedule(10, () => { calls.push(`early:${host.now()}`); });
    disposed.dispose();

    await host.advanceTime(9);
    expect(calls).toEqual([]);
    await host.advanceTime(1);
    expect(calls).toEqual(['early:1010']);
    await host.advanceTime(10);
    expect(calls).toEqual(['early:1010', 'late:1020']);
  });

  it('stores exact recovery data outside the granted project tree', async () => {
    const host = new MemoryHost({
      projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': 'source' } }],
    });
    const root = (await host.chooseProject())!;
    const journal = '{"version":1}\r\n';

    await host.writeRecovery(root.id, journal);
    expect(await host.readRecovery(root.id)).toBe(journal);
    await expect(host.readText(projectPath(root, '.uxml-editor/recovery.json'))).rejects.toMatchObject({ code: 'not-found' });

    await host.clearRecovery(root.id);
    expect(await host.readRecovery(root.id)).toBeNull();
  });

  it.each(['before', 'during'] as const)(
    'keeps the prior recovery journal when app-data replacement fails %s commit',
    async (phase) => {
      const host = new MemoryHost({
        projects: [{ id: 'project-a', name: 'Project A', files: { 'Main.uxml': 'source' } }],
      });
      const root = (await host.chooseProject())!;
      await host.writeRecovery(root.id, 'old-journal');
      host.injectFailure({ operation: 'writeRecovery', phase, message: `${phase} app-data failure` });

      await expect(host.writeRecovery(root.id, 'new-journal')).rejects.toMatchObject({
        code: 'app-data-failed',
        message: `${phase} app-data failure`,
      });
      expect(await host.readRecovery(root.id)).toBe('old-journal');
    },
  );

  it('deduplicates recent projects in newest-first order and snapshots callers', async () => {
    const host = new MemoryHost({ initialTime: 10 });
    const first = { id: projectId('project-a'), name: 'Project A' };
    const second = { id: projectId('project-b'), name: 'Project B' };

    await host.rememberRecentProject(first);
    first.name = 'mutated';
    await host.advanceTime(5);
    await host.rememberRecentProject(second);
    await host.advanceTime(5);
    await host.rememberRecentProject({ id: projectId('project-a'), name: 'Project A' });

    const recent = await host.listRecentProjects();
    expect(recent).toEqual([
      { root: { id: 'project-a', name: 'Project A' }, lastOpenedAt: 20 },
      { root: { id: 'project-b', name: 'Project B' }, lastOpenedAt: 15 },
    ]);
    expect(Object.isFrozen(recent)).toBe(true);
    expect(recent.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.root))).toBe(true);
  });

  it('orders same-time recent selections by deterministic insertion sequence', async () => {
    const host = new MemoryHost({ initialTime: 10 });
    await host.rememberRecentProject({ id: projectId('project-a'), name: 'Project A' });
    await host.rememberRecentProject({ id: projectId('project-b'), name: 'Project B' });

    expect((await host.listRecentProjects()).map((entry) => entry.root.id)).toEqual(['project-b', 'project-a']);
  });

  it('snapshots confirmation and message dialog inputs and returns explicit decisions', async () => {
    const host = new MemoryHost();
    const confirmation = {
      kind: 'overwrite' as const,
      title: 'External change',
      message: 'Overwrite disk contents?',
      confirmLabel: 'Overwrite',
      cancelLabel: 'Cancel',
    };
    host.queueConfirmation(true);

    const decisionPromise = host.confirm(confirmation);
    confirmation.message = 'mutated';
    const decision = await decisionPromise;
    expect(decision).toEqual({ confirmed: true });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(host.confirmationRequests[0]?.message).toBe('Overwrite disk contents?');

    const message = { kind: 'error' as const, title: 'Save failed', message: 'Disk full' };
    const shown = host.showMessage(message);
    message.message = 'mutated';
    await shown;
    expect(host.messageRequests[0]?.message).toBe('Disk full');
  });
});
