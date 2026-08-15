import {
  HostError,
  fileRevision,
  normalizeRelativePath,
  projectId,
  projectPath,
  snapshotProjectRoot,
  type FileReadResult,
  type FileEnumerationResult,
  type FileChangeEvent,
  type FileChangeListener,
  type FileRevision,
  type Disposable,
  type HostPort,
  type HostCapabilities,
  type ProjectId,
  type ProjectPath,
  type ProjectRoot,
  type RecentProject,
  type ScheduledCallback,
  type ConfirmationRequest,
  type ConfirmationResult,
  type MessageRequest,
} from './HostPort';

export interface MemoryProjectInput {
  readonly id: string;
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface MemoryHostOptions {
  readonly projects?: readonly MemoryProjectInput[];
  readonly initialTime?: number;
}

export interface MemoryFailure {
  readonly operation: 'replace' | 'writeRecovery' | 'clearRecovery';
  readonly phase: 'before' | 'during';
  readonly after?: number;
  readonly message?: string;
}

interface MemoryFile {
  readonly text: string;
  readonly revision: FileRevision;
}

interface MemoryProject {
  readonly root: ProjectRoot;
  readonly files: Map<string, MemoryFile>;
}

interface MemoryWatcher {
  readonly listener: FileChangeListener;
  active: boolean;
}

interface MemoryScheduledTask {
  readonly id: number;
  readonly due: number;
  readonly callback: ScheduledCallback;
  active: boolean;
}

interface MemoryRecentProject {
  readonly recent: RecentProject;
  readonly sequence: number;
}

export class MemoryHost implements HostPort {
  readonly capabilities: HostCapabilities = Object.freeze({
    mode: 'memory',
    projectSelection: 'deterministic',
    atomicReplace: 'guaranteed',
    watch: 'deterministic',
    appData: 'memory',
    dialogs: 'deterministic',
  });
  private readonly projects = new Map<ProjectId, MemoryProject>();
  private readonly projectOrder: ProjectId[] = [];
  private readonly failures: MemoryFailure[] = [];
  private readonly watchers = new Map<ProjectId, MemoryWatcher[]>();
  private readonly recovery = new Map<ProjectId, string>();
  private readonly recent = new Map<ProjectId, MemoryRecentProject>();
  private readonly confirmations: boolean[] = [];
  private readonly recordedConfirmations: ConfirmationRequest[] = [];
  private readonly recordedMessages: MessageRequest[] = [];
  private readonly scheduled: MemoryScheduledTask[] = [];
  private nextRevision = 1;
  private nextTaskId = 1;
  private nextRecentSequence = 1;
  private currentTime: number;

  constructor(options: MemoryHostOptions = {}) {
    this.currentTime = options.initialTime ?? 0;
    for (const input of options.projects ?? []) {
      const root = snapshotProjectRoot({ id: projectId(input.id), name: input.name });
      const files = new Map<string, MemoryFile>();
      for (const [path, text] of Object.entries(input.files)) {
        if (typeof text !== 'string') throw new HostError('invalid-path', `File ${path} must contain exact text.`);
        files.set(normalizeRelativePath(path), Object.freeze({ text, revision: this.createRevision() }));
      }
      this.projects.set(root.id, { root, files });
      this.projectOrder.push(root.id);
    }
  }

  async chooseProject(): Promise<ProjectRoot | null> {
    const first = this.projectOrder[0];
    return first === undefined ? null : snapshotProjectRoot(this.projects.get(first)!.root);
  }

  async enumerateFiles(root: ProjectRoot): Promise<FileEnumerationResult> {
    const project = this.requireProject(root.id);
    const files = Object.freeze([...project.files.keys()]
      .sort()
      .map((relativePath) => projectPath(project.root, relativePath)));
    return Object.freeze({ status: 'supported', files });
  }

  async readText(path: ProjectPath): Promise<FileReadResult> {
    const project = this.requireProject(path.projectId);
    const normalizedPath = projectPath(project.root, path.relativePath);
    const file = project.files.get(normalizedPath.relativePath);
    if (!file) throw new HostError('not-found', `File does not exist: ${normalizedPath.relativePath}`);
    return Object.freeze({ path: normalizedPath, text: file.text, revision: file.revision });
  }

  async replaceTextAtomically(
    path: ProjectPath,
    expectedRevision: FileRevision,
    text: string,
  ): Promise<FileRevision> {
    this.throwInjectedFailure('replace', 'before');
    const project = this.requireProject(path.projectId);
    const normalizedPath = projectPath(project.root, path.relativePath);
    const current = project.files.get(normalizedPath.relativePath);
    if (!current) throw new HostError('not-found', `File does not exist: ${normalizedPath.relativePath}`);
    if (current.revision !== expectedRevision) {
      throw new HostError('stale-revision', `File changed before replacement: ${normalizedPath.relativePath}`);
    }
    const revision = this.createRevision();
    const replacement = Object.freeze({ text, revision });
    this.throwInjectedFailure('replace', 'during');
    project.files.set(normalizedPath.relativePath, replacement);
    return revision;
  }

  async watch(root: ProjectRoot, listener: FileChangeListener): Promise<Disposable> {
    const project = this.requireProject(root.id);
    const watcher: MemoryWatcher = { listener, active: true };
    const watchers = this.watchers.get(project.root.id) ?? [];
    watchers.push(watcher);
    this.watchers.set(project.root.id, watchers);
    return Object.freeze({
      dispose: () => {
        watcher.active = false;
      },
    });
  }

  now(): number {
    return this.currentTime;
  }

  schedule(delayMs: number, callback: ScheduledCallback): Disposable {
    const task: MemoryScheduledTask = {
      id: this.nextTaskId++,
      due: this.currentTime + delayMs,
      callback,
      active: true,
    };
    this.scheduled.push(task);
    return Object.freeze({ dispose: () => { task.active = false; } });
  }

  async advanceTime(milliseconds: number): Promise<void> {
    const target = this.currentTime + milliseconds;
    for (;;) {
      const next = this.scheduled
        .filter((task) => task.active && task.due <= target)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (!next) break;
      next.active = false;
      this.currentTime = next.due;
      await next.callback();
    }
    this.currentTime = target;
  }

  async externalWrite(path: ProjectPath, text: string): Promise<FileRevision> {
    const project = this.requireProject(path.projectId);
    const normalizedPath = projectPath(project.root, path.relativePath);
    const current = project.files.get(normalizedPath.relativePath);
    const revision = current?.text === text ? current.revision : this.createRevision();
    project.files.set(normalizedPath.relativePath, Object.freeze({ text, revision }));
    await this.dispatch(Object.freeze({ kind: 'changed', path: normalizedPath, revision }));
    return revision;
  }

  async externalDelete(path: ProjectPath): Promise<void> {
    const project = this.requireProject(path.projectId);
    const normalizedPath = projectPath(project.root, path.relativePath);
    if (!project.files.delete(normalizedPath.relativePath)) {
      throw new HostError('not-found', `File does not exist: ${normalizedPath.relativePath}`);
    }
    await this.dispatch(Object.freeze({ kind: 'deleted', path: normalizedPath }));
  }

  async readRecovery(id: ProjectId): Promise<string | null> {
    this.requireProject(id);
    return this.recovery.get(id) ?? null;
  }

  async writeRecovery(id: ProjectId, journal: string): Promise<void> {
    this.throwInjectedFailure('writeRecovery', 'before');
    this.requireProject(id);
    const replacement = journal;
    this.throwInjectedFailure('writeRecovery', 'during');
    this.recovery.set(id, replacement);
  }

  async clearRecovery(id: ProjectId): Promise<void> {
    this.throwInjectedFailure('clearRecovery', 'before');
    this.requireProject(id);
    this.recovery.delete(id);
  }

  async listRecentProjects(): Promise<readonly RecentProject[]> {
    return Object.freeze([...this.recent.values()]
      .sort((left, right) => right.recent.lastOpenedAt - left.recent.lastOpenedAt || right.sequence - left.sequence)
      .map(({ recent }) => Object.freeze({
        root: snapshotProjectRoot(recent.root),
        lastOpenedAt: recent.lastOpenedAt,
      })));
  }

  async rememberRecentProject(root: ProjectRoot): Promise<void> {
    const snapshot = snapshotProjectRoot(root);
    this.recent.set(snapshot.id, Object.freeze({
      recent: Object.freeze({ root: snapshot, lastOpenedAt: this.currentTime }),
      sequence: this.nextRecentSequence++,
    }));
  }

  get confirmationRequests(): readonly ConfirmationRequest[] {
    return Object.freeze(this.recordedConfirmations.map(snapshotConfirmation));
  }

  get messageRequests(): readonly MessageRequest[] {
    return Object.freeze(this.recordedMessages.map(snapshotMessage));
  }

  queueConfirmation(confirmed: boolean): void {
    this.confirmations.push(confirmed);
  }

  async confirm(request: ConfirmationRequest): Promise<ConfirmationResult> {
    this.recordedConfirmations.push(snapshotConfirmation(request));
    return Object.freeze({ confirmed: this.confirmations.shift() ?? false });
  }

  async showMessage(request: MessageRequest): Promise<void> {
    this.recordedMessages.push(snapshotMessage(request));
  }

  injectFailure(failure: MemoryFailure): void {
    this.failures.push(Object.freeze({
      operation: failure.operation,
      phase: failure.phase,
      ...(failure.after === undefined ? {} : { after: failure.after }),
      ...(failure.message === undefined ? {} : { message: failure.message }),
    }));
  }

  private requireProject(id: ProjectId): MemoryProject {
    const project = this.projects.get(id);
    if (!project) throw new HostError('root-not-granted', `Project root is not granted: ${id}`);
    return project;
  }

  private createRevision(): FileRevision {
    return fileRevision(`memory:v1:${this.nextRevision++}`);
  }

  private throwInjectedFailure(operation: MemoryFailure['operation'], phase: MemoryFailure['phase']): void {
    const index = this.failures.findIndex((failure) => failure.operation === operation && failure.phase === phase);
    if (index === -1) return;
    const queued = this.failures[index];
    if ((queued.after ?? 0) > 0) {
      this.failures[index] = Object.freeze({ ...queued, after: queued.after! - 1 });
      return;
    }
    const [failure] = this.failures.splice(index, 1);
    throw new HostError(
      operation === 'replace' ? 'replace-failed' : 'app-data-failed',
      failure.message ?? `Injected ${operation} ${phase} failure.`,
    );
  }

  private async dispatch(event: FileChangeEvent): Promise<void> {
    const watchers = [...(this.watchers.get(event.path.projectId) ?? [])];
    for (const watcher of watchers) {
      if (watcher.active) await watcher.listener(event);
    }
  }
}

function snapshotConfirmation(request: ConfirmationRequest): ConfirmationRequest {
  return Object.freeze({
    kind: request.kind,
    title: request.title,
    message: request.message,
    confirmLabel: request.confirmLabel,
    cancelLabel: request.cancelLabel,
  });
}

function snapshotMessage(request: MessageRequest): MessageRequest {
  return Object.freeze({ kind: request.kind, title: request.title, message: request.message });
}
