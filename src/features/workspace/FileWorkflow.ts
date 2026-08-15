import type { UxmlPreviewPort } from '../../core/adapter/types';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import type {
  CloseLease,
  DocumentStateLease,
  DirtyState,
  SaveBeforeCloseResult,
} from '../../core/desktop/DesktopLifecycleController';
import { DocumentSession } from '../../core/documents/DocumentSession';
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
}

interface HeldCloseState {
  readonly active: ActiveProject | null;
  readonly session: DocumentSession | null;
  readonly generation: number;
}

export class FileWorkflow {
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
      if (!await this.prepareForReplacement()) return;
      this.closeActiveProject();
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
      if (!await this.prepareForReplacement()) return;
      const selected = root ?? await this.host.chooseProject();
      if (selected === null) return;
      try {
        await this.openGrantedRoot(selected);
      } catch (error) {
        if (root === undefined && this.host.capabilities.mode === 'tauri') this.detachRevokedActiveGrant();
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
      if (requested === undefined || !await this.prepareForReplacement()) return;
      const selected = await this.host.chooseProject();
      if (selected === null) return;
      if (selected.id !== requested.root.id) {
        if (this.host.capabilities.mode === 'tauri') this.detachRevokedActiveGrant();
        await this.host.showMessage({
          kind: 'warning',
          title: 'Different project selected',
          message: `Select ${requested.root.name} to open this recent project.`,
        });
        return;
      }
      try {
        await this.openGrantedRoot(selected);
      } catch (error) {
        if (this.host.capabilities.mode === 'tauri') this.detachRevokedActiveGrant();
        throw error;
      }
    });
  }

  reopenProject(): Promise<void> {
    return this.enqueue(async () => {
      const root = this.lastClosedRoot;
      if (root === null || !await this.prepareForReplacement()) return;
      await this.openGrantedRoot(root);
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
      if (!await this.prepareForReplacement()) return;
      this.closeActiveProject();
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

  private async openGrantedRoot(root: ProjectRoot): Promise<void> {
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
    const session = DocumentSession.open(
      new Map(initialFiles.map((file) => [file.path.relativePath, file.text])),
      entryPath,
      this.adapter,
    );
    const recovery = new RecoveryJournal(this.host, index.root);
    await recovery.recover(session);
    const active: ActiveProject = {
      root: snapshotProjectRoot(index.root),
      session,
      save: new SaveCoordinator(this.host, index.root, initialFiles, recovery),
      recovery,
      historyDispose: () => undefined,
      recoveryTail: Promise.resolve(),
      recoveryError: null,
    };
    if (this.store.getSnapshot().session !== null) this.closeActiveProject();
    this.active = active;
    this.unsavedSession = null;
    this.lastClosedRoot = null;
    this.externalChanges = Object.freeze([]);
    active.historyDispose = session.history.subscribe((results) => {
      const localResults = results.filter((result) => !result.forward.id.startsWith('external-reload:v1:'));
      if (localResults.length === 0 || this.active !== active) return;
      this.publish();
      active.recoveryTail = active.recoveryTail
        .then(async () => {
          for (const result of localResults) await recovery.appendCommitted(result);
        })
        .catch((error) => {
          active.recoveryError = error;
          this.publish();
        });
    });
    this.store.dispatch({ type: 'context/set', session, host: this.host });
    this.store.dispatch({ type: 'project-assets/set', paths: index.files.map((file) => file.path) });
    await this.host.rememberRecentProject(index.root);
    await this.refreshRecentProjects();
    try {
      active.watch = await active.save.watch(
        () => active.session,
        async (outcomes) => this.acceptExternalOutcomes(active, outcomes),
      );
    } catch (error) {
      if (!(error instanceof HostError) || error.code !== 'unsupported') throw error;
    }
    this.publish();
  }

  private async prepareForReplacement(): Promise<boolean> {
    if (this.store.getSnapshot().session === null) return true;
    const session = this.store.getSnapshot().session;
    const state = this.dirtyState(session);
    if (state === 'clean') return true;
    if (state === 'unknown') return false;
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
        return false;
      }
      return this.dirtyState(this.store.getSnapshot().session) === 'clean';
    }
    return (await this.host.confirm({
      kind: 'discard-changes',
      title: 'Unsaved changes',
      message: 'Discard unsaved project changes?',
      confirmLabel: 'Discard',
      cancelLabel: 'Cancel',
    })).confirmed;
  }

  private closeActiveProject(): void {
    if (this.active !== null) {
      this.lastClosedRoot = snapshotProjectRoot(this.active.root);
      this.active.historyDispose();
      this.active.watch?.dispose();
    }
    this.active = null;
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
    const selected = root ?? await this.host.chooseProject();
    if (selected === null) return;
    if (root === undefined && this.host.capabilities.mode === 'tauri') {
      this.detachRevokedActiveGrant();
    }
    const index = await ProjectIndex.scan(this.host, selected);
    const destination = new Map(index.files
      .filter((file): file is typeof file & { readonly text: string; readonly revision: NonNullable<typeof file.revision> } => (
        file.text !== null && file.revision !== null
      ))
      .map((file) => [file.path, file]));
    const snapshot = session.snapshot();
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
    }

    for (const [path, buffer] of snapshot.files) {
      const targetPath = projectPath(selected, path);
      const existing = destination.get(path);
      if (existing === undefined) {
        await this.host.createText(targetPath, buffer.text);
      } else {
        await this.host.replaceTextAtomically(targetPath, existing.revision, buffer.text);
      }
    }

    const initialFiles = await Promise.all([...snapshot.files.keys()]
      .map((path) => this.host.readText(projectPath(selected, path))));
    const recovery = new RecoveryJournal(this.host, selected);
    const active: ActiveProject = {
      root: snapshotProjectRoot(selected),
      session,
      save: new SaveCoordinator(this.host, selected, initialFiles, recovery),
      recovery,
      historyDispose: () => undefined,
      recoveryTail: Promise.resolve(),
      recoveryError: null,
    };
    this.active?.historyDispose();
    this.active?.watch?.dispose();
    this.active = active;
    active.historyDispose = session.history.subscribe((results) => {
      const localResults = results.filter((result) => !result.forward.id.startsWith('external-reload:v1:'));
      if (localResults.length === 0 || this.active !== active) return;
      this.publish();
      active.recoveryTail = active.recoveryTail.then(async () => {
        for (const result of localResults) await recovery.appendCommitted(result);
      }).catch((error) => {
        active.recoveryError = error;
        this.publish();
      });
    });
    this.unsavedSession = null;
    this.externalChanges = Object.freeze([]);
    const savedIndex = await ProjectIndex.scan(this.host, selected);
    this.store.dispatch({ type: 'project-assets/set', paths: savedIndex.files.map((file) => file.path) });
    this.store.dispatch({ type: 'session/sync' });
    await this.host.rememberRecentProject(selected);
    await this.refreshRecentProjects();
    try {
      active.watch = await active.save.watch(
        () => active.session,
        async (outcomes) => this.acceptExternalOutcomes(active, outcomes),
      );
    } catch (error) {
      if (!(error instanceof HostError) || error.code !== 'unsupported') throw error;
    }
    this.publish();
  }

  private detachRevokedActiveGrant(): void {
    const session = this.store.getSnapshot().session;
    if (this.active === null || session !== this.active.session) return;
    this.active.historyDispose();
    this.active.watch?.dispose();
    this.active = null;
    this.unsavedSession = session;
    this.externalChanges = Object.freeze([]);
    this.store.dispatch({ type: 'project-assets/set', paths: [] });
    this.publish();
  }

  private acceptExternalOutcomes(active: ActiveProject, outcomes: readonly ExternalChangeOutcome[]): void {
    if (this.active !== active) return;
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
    return Object.freeze({
      projectName: this.active?.root.name ?? (this.unsavedSession === null ? null : 'Untitled Project'),
      dirtyState: this.dirtyState(this.store.getSnapshot().session),
      recentProjects: this.recentProjects,
      externalChanges: this.externalChanges,
      canReopen: this.lastClosedRoot !== null && this.store.getSnapshot().session === null,
      canReload: this.active !== null && this.store.getSnapshot().session === this.active.session,
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
