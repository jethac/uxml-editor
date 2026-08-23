import type { UxmlPreviewPort } from '../../core/adapter/types';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import type {
  CloseLease,
  DocumentStateLease,
  DirtyState,
  SaveBeforeCloseResult,
} from '../../core/desktop/DesktopLifecycleController';
import { DocumentSession, type CommitResult } from '../../core/documents/DocumentSession';
import {
  HostError,
  projectPath,
  snapshotProjectRoot,
  type Disposable,
  type FileReadResult,
  type HostPort,
  type ProjectRoot,
  type RecentProject,
} from '../../core/host/HostPort';
import { RecoveryJournal } from '../../core/persistence/RecoveryJournal';
import {
  SaveCoordinator,
  type ExternalChangeDecision,
  type ExternalChangeOutcome,
  type SaveOutcome,
} from '../../core/persistence/SaveCoordinator';
import { ProjectIndex } from '../../core/project/ProjectIndex';
import type { EditorStore } from '../../core/store/EditorStore';
import type {
  EditorFileCommandCapabilities,
  EditorFileCommandPort,
} from '../../core/store/CommandRegistry';

export interface FileWorkflowOptions {
  readonly adapter?: UxmlPreviewPort;
}

export interface FileWorkflowSnapshot {
  readonly projectName: string | null;
  readonly dirtyState: DirtyState;
  readonly recentProjects: readonly RecentProject[];
  readonly externalChanges: readonly ExternalChangeOutcome[];
  readonly canReopen: boolean;
  readonly canReload: boolean;
  readonly capabilities: EditorFileCommandCapabilities;
}

export interface FileWorkflowPort extends EditorFileCommandPort {
  resolveExternalChange(path: string, decision: ExternalChangeDecision): Promise<void>;
  getSnapshot(): FileWorkflowSnapshot;
  dispose(): void | Promise<void>;
}

export class SaveAsPartialError extends Error {
  readonly writtenPaths: readonly string[];
  readonly pendingPaths: readonly string[];

  constructor(
    writtenPaths: readonly string[],
    pendingPaths: readonly string[],
    readonly originalError: unknown,
  ) {
    super('Save As did not complete for every project file.');
    this.name = 'SaveAsPartialError';
    this.writtenPaths = Object.freeze([...writtenPaths]);
    this.pendingPaths = Object.freeze([...pendingPaths]);
  }
}

interface ActiveProject {
  readonly root: ProjectRoot;
  readonly session: DocumentSession;
  readonly save: SaveCoordinator;
  readonly recovery: RecoveryJournal;
  historyDispose: () => void;
  watch?: Disposable;
  recoveryTail: Promise<void>;
  recoveryError: unknown | null;
  retired: boolean;
  retirement: Promise<void> | null;
}

interface HeldCloseState {
  readonly active: ActiveProject | null;
  readonly session: DocumentSession | null;
  readonly generation: number;
}

interface SaveAsSourceState {
  readonly active: ActiveProject | null;
  readonly session: DocumentSession;
  readonly generation: number;
  readonly assetPaths: readonly string[];
}

type ReplacementPreparation = 'proceed' | 'discard' | 'cancel';

export class FileWorkflow implements FileWorkflowPort {
  private readonly adapter: UxmlPreviewPort;
  private readonly heldCloseStates = new WeakMap<DocumentStateLease, HeldCloseState>();
  private readonly listeners = new Map<number, () => void>();
  private nextListenerId = 1;
  private operationTail: Promise<void> = Promise.resolve();
  private active: ActiveProject | null = null;
  private unsavedSession: DocumentSession | null = null;
  private lastClosedRoot: ProjectRoot | null = null;
  private recentProjects: readonly RecentProject[] = Object.freeze([]);
  private externalChanges: readonly ExternalChangeOutcome[] = Object.freeze([]);
  private snapshot: FileWorkflowSnapshot;

  constructor(
    private readonly store: EditorStore,
    private readonly host: HostPort,
    options: FileWorkflowOptions = {},
  ) {
    this.adapter = options.adapter ?? new UxmlPreviewAdapter();
    this.snapshot = this.createSnapshot();
  }

  readonly getSnapshot = (): FileWorkflowSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    const id = this.nextListenerId++;
    this.listeners.set(id, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(id);
    };
  };

  newProject(): Promise<void> {
    return this.enqueue(async () => {
      const preparation = await this.prepareForReplacement();
      if (preparation === 'cancel' || !await this.finalizeDiscard(preparation)) return;
      await this.closeActiveProject();
      const session = DocumentSession.open(
        new Map([[NEW_PROJECT_ENTRY_PATH, NEW_PROJECT_SOURCE]]),
        NEW_PROJECT_ENTRY_PATH,
        this.adapter,
      );
      this.active = null;
      this.unsavedSession = session;
      this.externalChanges = Object.freeze([]);
      this.store.dispatch({ type: 'context/set', session, host: this.host });
      this.store.dispatch({ type: 'project-assets/set', paths: [] });
      this.publish();
    });
  }

  openProject(root?: ProjectRoot): Promise<void> {
    return this.enqueue(async () => {
      const preparation = await this.prepareForReplacement();
      if (preparation === 'cancel') return;
      const selected = root ?? await this.host.chooseProject();
      if (selected === null) return;
      try {
        await this.openGrantedRoot(selected, preparation);
      } catch (error) {
        if (root === undefined && this.host.capabilities.mode === 'tauri') await this.detachRevokedActiveGrant();
        throw error;
      }
    });
  }

  openRecent(recent?: RecentProject): Promise<void> {
    return this.enqueue(async () => {
      await this.refreshRecentProjects();
      const requested = recent === undefined
        ? this.recentProjects[0]
        : this.recentProjects.find((entry) => entry.root.id === recent.root.id
          && entry.root.name === recent.root.name);
      if (requested === undefined) return;
      const preparation = await this.prepareForReplacement();
      if (preparation === 'cancel') return;
      const selected = await this.host.chooseProject();
      if (selected === null) return;
      if (selected.id !== requested.root.id) {
        if (this.host.capabilities.mode === 'tauri') await this.detachRevokedActiveGrant();
        await this.host.showMessage({
          kind: 'warning',
          title: 'Different project selected',
          message: `Select ${requested.root.name} to open this recent project.`,
        });
        return;
      }
      try {
        await this.openGrantedRoot(selected, preparation);
      } catch (error) {
        if (this.host.capabilities.mode === 'tauri') await this.detachRevokedActiveGrant();
        throw error;
      }
    });
  }

  reopenProject(): Promise<void> {
    return this.enqueue(async () => {
      const root = this.lastClosedRoot;
      if (root === null) return;
      const preparation = await this.prepareForReplacement();
      if (preparation === 'cancel') return;
      await this.openGrantedRoot(root, preparation);
    });
  }

  save(): Promise<void> {
    return this.enqueue(async () => {
      const active = this.active;
      if (active === null) {
        if (this.unsavedSession !== null) await this.saveAsActive();
        return;
      }
      if (this.store.getSnapshot().session !== active.session) return;
      await active.recoveryTail;
      if (active.recoveryError !== null) throw active.recoveryError;
      this.requireSuccessfulSave(await active.save.save(active.session));
      this.store.dispatch({ type: 'session/sync' });
      this.publish();
    });
  }

  saveAs(root?: ProjectRoot): Promise<void> {
    return this.enqueue(() => this.saveAsActive(root));
  }

  saveAll(): Promise<void> {
    return this.enqueue(async () => {
      this.requireSuccessfulSave(await this.saveAllActive());
    });
  }

  closeProject(): Promise<void> {
    return this.enqueue(async () => {
      const preparation = await this.prepareForReplacement();
      if (preparation === 'cancel' || !await this.finalizeDiscard(preparation)) return;
      await this.closeActiveProject();
    });
  }

  reloadProject(): Promise<void> {
    return this.enqueue(async () => {
      const active = this.active;
      if (active === null || this.store.getSnapshot().session !== active.session) return;
      const outcomes = await active.save.processExternalChanges(
        active.session,
        [...active.session.snapshot().files.keys()],
      );
      this.acceptExternalOutcomes(active, outcomes);
    });
  }

  resolveExternalChange(path: string, decision: ExternalChangeDecision): Promise<void> {
    return this.enqueue(async () => {
      const active = this.active;
      if (active === null || this.store.getSnapshot().session !== active.session) return;
      const outcome = await active.save.resolveExternalChange(active.session, path, decision);
      if (this.active !== active) return;
      if (outcome.status === 'reloaded' || outcome.status === 'overwritten' || outcome.status === 'cancelled') {
        this.externalChanges = Object.freeze(this.externalChanges.filter((entry) => entry.path !== path));
      }
      this.store.dispatch({ type: 'session/sync' });
      this.publish();
      if (outcome.status === 'failed' || outcome.status === 'conflict' || outcome.status === 'deleted') {
        await this.host.showMessage({
          kind: outcome.status === 'deleted' ? 'warning' : 'error',
          title: 'External change not resolved',
          message: outcome.error?.message ?? `Could not resolve the external change for ${path}.`,
        });
      }
    });
  }

  dispose(): Promise<void> {
    return this.enqueue(async () => {
      try {
        if (this.active !== null || this.unsavedSession !== null) await this.closeActiveProject();
      } finally {
        this.listeners.clear();
      }
    });
  }

  runExclusiveCloseState(
    _nativeLease: CloseLease,
    operation: (lease: DocumentStateLease) => void | Promise<void>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const session = this.store.getSnapshot().session;
      const lease = Object.freeze({
        generation: session?.generation ?? 0,
        dirtyState: this.dirtyState(session),
      });
      this.heldCloseStates.set(lease, Object.freeze({
        active: this.active,
        session,
        generation: lease.generation,
      }));
      try {
        await operation(lease);
      } finally {
        this.heldCloseStates.delete(lease);
      }
    });
  }

  finalValidateCloseState(lease: DocumentStateLease): boolean {
    const held = this.heldCloseStates.get(lease);
    const session = this.store.getSnapshot().session;
    return held !== undefined
      && held.active === this.active
      && held.session === session
      && held.generation === (session?.generation ?? 0);
  }

  async saveBeforeClose(lease: DocumentStateLease): Promise<SaveBeforeCloseResult> {
    if (!this.finalValidateCloseState(lease)) return 'cancelled';
    try {
      const outcome = await this.saveAllActive();
      return outcome !== null && outcome.dirtyPaths.length === 0
        && (outcome.status === 'saved' || outcome.status === 'noop')
        ? 'saved'
        : 'failed';
    } catch {
      return 'failed';
    }
  }

  private async openGrantedRoot(
    root: ProjectRoot,
    preparation: ReplacementPreparation = 'proceed',
  ): Promise<void> {
    const index = await ProjectIndex.scan(this.host, root);
    const initialFiles = index.files
      .filter((file): file is typeof file & { readonly text: string; readonly revision: NonNullable<typeof file.revision> } => (
        file.text !== null && file.revision !== null
      ))
      .map((file): FileReadResult => Object.freeze({
        path: projectPath(index.root, file.path),
        text: file.text,
        revision: file.revision,
      }));
    const entryPath = chooseEntryPath(initialFiles);
    let session = DocumentSession.open(
      new Map(initialFiles.map((file) => [file.path.relativePath, file.text])),
      entryPath,
      this.adapter,
    );
    const recovery = new RecoveryJournal(this.host, index.root);
    await recovery.recover(session);
    if (preparation === 'discard' && this.active?.root.id === index.root.id) {
      session = DocumentSession.open(
        new Map(initialFiles.map((file) => [file.path.relativePath, file.text])),
        entryPath,
        this.adapter,
      );
    }
    const active = this.createActiveProject(index.root, session, initialFiles, recovery);
    try {
      const recentProjects = await this.prepareActiveProject(active);
      if (!await this.finalizeDiscard(preparation)) {
        await this.disposeStagedActiveProject(active);
        return;
      }
      await this.retireCurrentActiveProject();
      this.activatePreparedProject(active, index.files.map((file) => file.path), recentProjects);
    } catch (error) {
      await this.disposeStagedActiveProject(active);
      throw error;
    }
  }

  private async prepareForReplacement(): Promise<ReplacementPreparation> {
    if (this.store.getSnapshot().session === null) return 'proceed';
    const session = this.store.getSnapshot().session;
    const state = this.dirtyState(session);
    if (state === 'clean') return 'proceed';
    if (state === 'unknown') return 'cancel';
    const save = await this.host.confirm({
      kind: 'discard-changes',
      title: 'Unsaved changes',
      message: 'Save project changes before continuing?',
      confirmLabel: 'Save',
      cancelLabel: 'Other Options',
    });
    if (save.confirmed) {
      try {
        if (this.active === null) await this.saveAsActive();
        else this.requireSuccessfulSave(await this.saveAllActive());
      } catch (error) {
        await this.host.showMessage({
          kind: 'error',
          title: 'Project not saved',
          message: error instanceof Error ? error.message : 'The project could not be saved.',
        });
        return 'cancel';
      }
      return this.dirtyState(this.store.getSnapshot().session) === 'clean' ? 'proceed' : 'cancel';
    }
    return (await this.host.confirm({
      kind: 'discard-changes',
      title: 'Unsaved changes',
      message: 'Discard unsaved project changes?',
      confirmLabel: 'Discard',
      cancelLabel: 'Cancel',
    })).confirmed ? 'discard' : 'cancel';
  }

  private async finalizeDiscard(preparation: ReplacementPreparation): Promise<boolean> {
    if (preparation !== 'discard') return true;
    const active = this.active;
    if (active === null || this.store.getSnapshot().session !== active.session) return true;
    try {
      await active.recoveryTail;
      if (active.recoveryError !== null) throw active.recoveryError;
      await active.recovery.clear();
      return true;
    } catch (error) {
      await this.host.showMessage({
        kind: 'error',
        title: 'Changes not discarded',
        message: error instanceof Error ? error.message : 'Recovery state could not be cleared.',
      });
      return false;
    }
  }

  private createActiveProject(
    root: ProjectRoot,
    session: DocumentSession,
    initialFiles: readonly FileReadResult[],
    recovery: RecoveryJournal,
  ): ActiveProject {
    return {
      root: snapshotProjectRoot(root),
      session,
      save: new SaveCoordinator(this.host, root, initialFiles, recovery),
      recovery,
      historyDispose: () => undefined,
      recoveryTail: Promise.resolve(),
      recoveryError: null,
      retired: false,
      retirement: null,
    };
  }

  private async prepareActiveProject(
    active: ActiveProject,
    checkpoint: () => void = () => undefined,
  ): Promise<readonly RecentProject[]> {
    await this.prepareActiveRuntime(active);
    checkpoint();
    await this.host.rememberRecentProject(active.root);
    checkpoint();
    const recentProjects = await this.host.listRecentProjects();
    checkpoint();
    return Object.freeze([...recentProjects]);
  }

  private async prepareActiveRuntime(active: ActiveProject): Promise<void> {
    active.historyDispose = active.session.history.subscribe((results) => {
      const localResults = results.filter((result) => !result.forward.id.startsWith('external-reload:v1:'));
      if (localResults.length === 0 || this.active !== active) return;
      if (!active.retired) this.publish();
      this.queueRecoveryResults(active, localResults);
    });
    try {
      active.watch = await active.save.watch(
        () => active.session,
        async (outcomes) => {
          if (!active.retired) this.acceptExternalOutcomes(active, outcomes);
        },
      );
    } catch (error) {
      if (!(error instanceof HostError) || error.code !== 'unsupported') throw error;
    }
  }

  private queueRecoveryResults(active: ActiveProject, results: readonly CommitResult[]): void {
    active.recoveryTail = active.recoveryTail
      .then(async () => {
        for (const result of results) await active.recovery.appendCommitted(result);
      })
      .catch((error) => {
        active.recoveryError = error;
        if (!active.retired && this.active === active) this.publish();
      });
  }

  private activatePreparedProject(
    active: ActiveProject,
    assetPaths: readonly string[],
    recentProjects: readonly RecentProject[],
  ): void {
    this.active = active;
    this.unsavedSession = null;
    this.lastClosedRoot = null;
    this.externalChanges = Object.freeze([]);
    this.recentProjects = Object.freeze([...recentProjects]);
    this.store.dispatch({ type: 'context/set', session: active.session, host: this.host });
    this.store.dispatch({ type: 'project-assets/set', paths: assetPaths });
    this.publish();
  }

  private async disposeStagedActiveProject(active: ActiveProject): Promise<void> {
    try {
      await this.retireActiveProject(active);
    } catch {
      // The primary preparation or replacement failure remains authoritative.
    }
  }

  private async retireCurrentActiveProject(restoreOnFailure = false): Promise<ActiveProject | null> {
    const active = this.active;
    if (active === null) return null;
    try {
      await this.retireActiveProject(active);
    } catch (error) {
      if (this.active === active) {
        if (restoreOnFailure) {
          try {
            await this.restoreActiveProject(active);
          } catch {
            this.fallbackToUnsavedSession(active.session);
          }
        } else {
          this.fallbackToUnsavedSession(active.session);
        }
      }
      try {
        await this.host.showMessage({
          kind: 'error',
          title: 'Project cleanup failed',
          message: error instanceof Error ? error.message : 'The active project runtime could not be retired.',
        });
      } catch {
        // The command error boundary still receives the original cleanup failure.
      }
      throw error;
    }
    if (this.active === active) this.active = null;
    return active;
  }

  private async restoreActiveProject(retired: ActiveProject): Promise<void> {
    const restored: ActiveProject = {
      root: retired.root,
      session: retired.session,
      save: retired.save,
      recovery: retired.recovery,
      historyDispose: () => undefined,
      recoveryTail: retired.recoveryTail,
      recoveryError: retired.recoveryError,
      retired: false,
      retirement: null,
    };
    this.active = restored;
    this.unsavedSession = null;
    try {
      await this.prepareActiveRuntime(restored);
    } catch (error) {
      await this.disposeStagedActiveProject(restored);
      throw error;
    }
    this.publish();
  }

  private async ensureSaveAsSourceAuthority(source: SaveAsSourceState): Promise<void> {
    if (source.active === null) {
      this.active = null;
      this.unsavedSession = source.session;
    } else if (this.active === null
      || this.active.retired
      || this.active.session !== source.session
      || this.active.root.id !== source.active.root.id) {
      await this.restoreActiveProject(source.active);
    }
    this.store.dispatch({ type: 'context/set', session: source.session, host: this.host });
    this.store.dispatch({ type: 'project-assets/set', paths: source.assetPaths });
    this.publish();
  }

  private fallbackToUnsavedSession(session: DocumentSession): void {
    this.active = null;
    this.unsavedSession = session;
    this.externalChanges = Object.freeze([]);
    this.store.dispatch({ type: 'project-assets/set', paths: [] });
    this.publish();
  }

  private retireActiveProject(active: ActiveProject): Promise<void> {
    if (active.retirement !== null) return active.retirement;
    active.retired = true;
    active.retirement = (async () => {
      let failure: unknown | null = null;
      const watch = active.watch;
      if (watch !== undefined) {
        try {
          watch.dispose();
        } catch (error) {
          failure ??= error;
        }
      }
      if (watch?.completion !== undefined) {
        try {
          const outcome = await watch.completion;
          if (outcome.status === 'failed') failure ??= outcome.error;
        } catch (error) {
          failure ??= error;
        }
      }
      let retirementHistoryDispose: (() => void) | null = null;
      try {
        retirementHistoryDispose = active.session.history.subscribe((results) => {
          const localResults = results.filter((result) => !result.forward.id.startsWith('external-reload:v1:'));
          if (localResults.length === 0 || this.active !== active) return;
          this.queueRecoveryResults(active, localResults);
        });
      } catch (error) {
        failure ??= error;
      }
      if (retirementHistoryDispose !== null) {
        try {
          active.historyDispose();
        } catch (error) {
          failure ??= error;
        }
      }
      while (true) {
        const recoveryTail = active.recoveryTail;
        try {
          await recoveryTail;
        } catch (error) {
          failure ??= error;
        }
        if (recoveryTail === active.recoveryTail) break;
      }
      if (active.recoveryError !== null) failure ??= active.recoveryError;
      try {
        if (retirementHistoryDispose === null) active.historyDispose();
        else retirementHistoryDispose();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== null) throw failure;
    })();
    return active.retirement;
  }

  private async closeActiveProject(): Promise<void> {
    const retired = await this.retireCurrentActiveProject();
    if (retired !== null) this.lastClosedRoot = snapshotProjectRoot(retired.root);
    this.unsavedSession = null;
    this.externalChanges = Object.freeze([]);
    this.store.dispatch({ type: 'context/set', session: null, host: this.host });
    this.store.dispatch({ type: 'project-assets/set', paths: [] });
    this.publish();
  }

  private dirtyState(session: DocumentSession | null): DirtyState {
    if (session === null) return 'clean';
    if (this.unsavedSession === session) return 'dirty';
    if (this.active === null || this.active.session !== session) return 'unknown';
    if (this.active.recoveryError !== null) return 'unknown';
    return this.active.save.dirtyPaths(session).length === 0 ? 'clean' : 'dirty';
  }

  private async saveAllActive(): Promise<SaveOutcome | null> {
    const active = this.active;
    if (active === null || this.store.getSnapshot().session !== active.session) return null;
    await active.recoveryTail;
    if (active.recoveryError !== null) throw active.recoveryError;
    const outcome = await active.save.saveAll(active.session);
    this.store.dispatch({ type: 'session/sync' });
    this.publish();
    return outcome;
  }

  private requireSuccessfulSave(outcome: SaveOutcome | null): void {
    if (outcome !== null && outcome.dirtyPaths.length === 0
      && (outcome.status === 'saved' || outcome.status === 'noop')) return;
    throw new Error('The project could not be saved completely.');
  }

  private async saveAsActive(root?: ProjectRoot): Promise<void> {
    const session = this.store.getSnapshot().session;
    if (session === null) return;
    const source: SaveAsSourceState = Object.freeze({
      active: this.active,
      session,
      generation: session.generation,
      assetPaths: Object.freeze(this.store.getSnapshot().projectAssets.map(({ path }) => path)),
    });
    const snapshot = session.snapshot();
    const allPaths = Object.freeze([...snapshot.files.keys()].sort((left, right) => left.localeCompare(right, 'en')));
    const selected = root ?? await this.host.chooseProject();
    if (selected === null) return;
    await this.reportIfSaveAsSourceChanged(source, [], allPaths);
    if (root === undefined && this.host.capabilities.mode === 'tauri') {
      await this.detachRevokedActiveGrant();
    }
    const index = await ProjectIndex.scan(this.host, selected);
    await this.reportIfSaveAsSourceChanged(source, [], allPaths);
    const destination = new Map(index.files
      .filter((file): file is typeof file & { readonly text: string; readonly revision: NonNullable<typeof file.revision> } => (
        file.text !== null && file.revision !== null
      ))
      .map((file) => [file.path, file]));
    const collisions = [...snapshot.files.keys()].filter((path) => destination.has(path));
    if (collisions.length > 0) {
      const confirmed = await this.host.confirm({
        kind: 'overwrite',
        title: 'Replace project files',
        message: `Replace ${collisions.length} existing project file${collisions.length === 1 ? '' : 's'}?`,
        confirmLabel: 'Replace',
        cancelLabel: 'Cancel',
      });
      if (!confirmed.confirmed) return;
      await this.reportIfSaveAsSourceChanged(source, [], allPaths);
    }

    const writes = [...snapshot.files]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([path, buffer]) => Object.freeze({ path, text: buffer.text, existing: destination.get(path) }));
    try {
      for (const write of writes) {
        if (write.existing === undefined) continue;
        const current = await this.host.readText(projectPath(selected, write.path));
        const sourceError = this.saveAsSourceError(source);
        if (sourceError !== null) throw sourceError;
        if (current.revision !== write.existing.revision) {
          throw new HostError('stale-revision', `File changed before Save As: ${write.path}`);
        }
      }
    } catch (error) {
      await this.reportSaveAsFailure([], writes.map((write) => write.path), error);
    }

    const writtenPaths: string[] = [];
    for (let index = 0; index < writes.length; index += 1) {
      const write = writes[index]!;
      let writeCompleted = false;
      try {
        const beforeWrite = this.saveAsSourceError(source);
        if (beforeWrite !== null) throw beforeWrite;
        const targetPath = projectPath(selected, write.path);
        if (write.existing === undefined) {
          await this.host.createText(targetPath, write.text);
        } else {
          await this.host.replaceTextAtomically(targetPath, write.existing.revision, write.text);
        }
        writtenPaths.push(write.path);
        writeCompleted = true;
        const afterWrite = this.saveAsSourceError(source);
        if (afterWrite !== null) throw afterWrite;
      } catch (error) {
        const firstPending = index + (writeCompleted ? 1 : 0);
        await this.reportSaveAsFailure(
          writtenPaths,
          writes.slice(firstPending).map((pending) => pending.path),
          error,
        );
      }
    }

    let stagedActive: ActiveProject | null = null;
    try {
      const assertSourceCurrent = () => {
        const error = this.saveAsSourceError(source);
        if (error !== null) throw error;
      };
      assertSourceCurrent();
      const initialFiles = await Promise.all(writes
        .map((write) => this.host.readText(projectPath(selected, write.path))));
      assertSourceCurrent();
      const recovery = new RecoveryJournal(this.host, selected);
      stagedActive = this.createActiveProject(selected, session, initialFiles, recovery);
      const savedIndex = await ProjectIndex.scan(this.host, selected);
      assertSourceCurrent();
      const recentProjects = await this.prepareActiveProject(stagedActive, assertSourceCurrent);
      assertSourceCurrent();
      await this.retireCurrentActiveProject(true);
      assertSourceCurrent();
      this.activatePreparedProject(stagedActive, savedIndex.files.map((file) => file.path), recentProjects);
      stagedActive = null;
      this.store.dispatch({ type: 'session/sync' });
      this.publish();
    } catch (error) {
      if (stagedActive !== null) await this.disposeStagedActiveProject(stagedActive);
      await this.ensureSaveAsSourceAuthority(source);
      await this.reportSaveAsFailure(writes.map((write) => write.path), [], error);
    }
  }

  private saveAsSourceError(source: SaveAsSourceState): HostError | null {
    const current = this.store.getSnapshot().session;
    return current === source.session && current.generation === source.generation
      ? null
      : new HostError('stale-revision', 'Source changed during Save As.');
  }

  private async reportIfSaveAsSourceChanged(
    source: SaveAsSourceState,
    writtenPaths: readonly string[],
    pendingPaths: readonly string[],
  ): Promise<void> {
    const error = this.saveAsSourceError(source);
    if (error !== null) await this.reportSaveAsFailure(writtenPaths, pendingPaths, error);
  }

  private async reportSaveAsFailure(
    writtenPaths: readonly string[],
    pendingPaths: readonly string[],
    error: unknown,
  ): Promise<never> {
    const partialError = new SaveAsPartialError(writtenPaths, pendingPaths, error);
    try {
      await this.host.showMessage({
        kind: 'error',
        title: 'Save As incomplete',
        message: `Written: ${formatPathOutcome(writtenPaths)}. Pending: ${formatPathOutcome(pendingPaths)}.`,
      });
    } catch {
      // The command error boundary still surfaces the aggregate outcome if the host dialog fails.
    }
    throw partialError;
  }

  private async detachRevokedActiveGrant(): Promise<void> {
    const session = this.store.getSnapshot().session;
    if (this.active === null || session !== this.active.session) return;
    await this.retireCurrentActiveProject();
    this.unsavedSession = session;
    this.externalChanges = Object.freeze([]);
    this.store.dispatch({ type: 'project-assets/set', paths: [] });
    this.publish();
  }

  private acceptExternalOutcomes(active: ActiveProject, outcomes: readonly ExternalChangeOutcome[]): void {
    if (active.retired || this.active !== active) return;
    const pending = outcomes.filter((outcome) => (
      outcome.status === 'conflict' || outcome.status === 'deleted' || outcome.status === 'reload-failed'
    ));
    const replacedPaths = new Set(outcomes.map((outcome) => outcome.path));
    this.externalChanges = Object.freeze([
      ...this.externalChanges.filter((outcome) => !replacedPaths.has(outcome.path)),
      ...pending,
    ].sort((left, right) => left.path.localeCompare(right.path, 'en')));
    this.store.dispatch({ type: 'session/sync' });
    this.publish();
  }

  private async refreshRecentProjects(): Promise<void> {
    this.recentProjects = Object.freeze([...(await this.host.listRecentProjects())]);
    this.publish();
  }

  private createSnapshot(): FileWorkflowSnapshot {
    const capabilities = this.createCapabilities();
    return Object.freeze({
      projectName: this.active?.root.name ?? (this.unsavedSession === null ? null : 'Untitled Project'),
      dirtyState: this.dirtyState(this.store.getSnapshot().session),
      recentProjects: this.recentProjects,
      externalChanges: this.externalChanges,
      canReopen: capabilities.reopenProject,
      canReload: capabilities.reloadProject,
      capabilities,
    });
  }

  private createCapabilities(): EditorFileCommandCapabilities {
    const session = this.store.getSnapshot().session;
    const active = this.active !== null && this.active.session === session;
    const unsaved = this.unsavedSession !== null && this.unsavedSession === session;
    const ownsSession = session === null || active || unsaved;
    const createSupported = this.host.capabilities.mode !== 'browser-file-system';
    return Object.freeze({
      newProject: ownsSession && createSupported,
      openProject: ownsSession,
      openRecent: ownsSession && this.recentProjects.length > 0,
      save: active || (unsaved && createSupported),
      saveAs: (active || unsaved) && createSupported,
      saveAll: active,
      closeProject: active || unsaved,
      reopenProject: this.lastClosedRoot !== null && session === null,
      reloadProject: active,
    });
  }

  private publish(): void {
    this.snapshot = this.createSnapshot();
    for (const listener of [...this.listeners.values()]) listener();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const NEW_PROJECT_ENTRY_PATH = 'Assets/Main.uxml';
const NEW_PROJECT_SOURCE = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n</ui:UXML>\n';

function chooseEntryPath(files: readonly FileReadResult[]): string {
  const entries = files
    .map((file) => file.path.relativePath)
    .filter((path) => path.toLowerCase().endsWith('.uxml'))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const preferred = entries.find((path) => path.toLowerCase() === 'assets/main.uxml');
  const entry = preferred ?? entries[0];
  if (entry === undefined) throw new Error('The selected project does not contain a UXML document.');
  return entry;
}

function formatPathOutcome(paths: readonly string[]): string {
  return paths.length === 0 ? 'none' : paths.join(', ');
}
