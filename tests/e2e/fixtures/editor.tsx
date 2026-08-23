import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../../src/app/App';
import { createRuntimeEditorStore } from '../../../src/app/createRuntimeEditorStore';
import {
  projectId,
  projectPath,
  snapshotProjectRoot,
  type ConfirmationRequest,
  type ConfirmationResult,
  type Disposable,
  type FileChangeListener,
  type FileEnumerationResult,
  type FileReadResult,
  type FileRevision,
  type MessageRequest,
  type ProjectRoot,
  type RecentProject,
} from '../../../src/core/host/HostPort';
import {
  MemoryHost,
  type MemoryFailure,
  type MemoryProjectInput,
} from '../../../src/core/host/MemoryHost';
import { FileWorkflow } from '../../../src/features/workspace/FileWorkflow';
import {
  EDITOR_ASSET_URLS,
  editorFixtureProject,
  editorFixtureProjects,
  type EditorFixtureProjectKey,
} from './editorCorpus';

const INITIAL_TIME = 1_723_689_600_000;

interface FileSnapshot {
  readonly text: string;
  readonly revision: string;
}

interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly files: Readonly<Record<string, FileSnapshot>>;
}

interface HostObservations {
  readonly recovery: Readonly<Record<string, string | null>>;
  readonly recent: readonly RecentProject[];
  readonly confirmations: readonly ConfirmationRequest[];
  readonly messages: readonly MessageRequest[];
}

interface HarnessSnapshot extends HostObservations {
  readonly projects: Readonly<Record<EditorFixtureProjectKey, ProjectSnapshot>>;
}

interface RuntimeState {
  readonly activeRuntime: number;
  readonly completedTeardowns: readonly number[];
  readonly lateHostOperations: number;
}

export interface EditorFixtureBridge {
  reset(source?: Exclude<EditorFixtureProjectKey, 'blank' | 'collision'>): Promise<void>;
  restart(): Promise<void>;
  settled(): Promise<void>;
  selectProject(key: EditorFixtureProjectKey): void;
  queueConfirmation(confirmed: boolean): void;
  injectReplacementFailure(message: string): void;
  externalWrite(key: EditorFixtureProjectKey, path: string, text: string): Promise<void>;
  externalDelete(key: EditorFixtureProjectKey, path: string): Promise<void>;
  advanceTime(milliseconds: number): Promise<void>;
  project(key: EditorFixtureProjectKey): Promise<ProjectSnapshot>;
  baseline(key: EditorFixtureProjectKey): ProjectSnapshot;
  observations(): Promise<HostObservations>;
  snapshot(): Promise<HarnessSnapshot>;
  runtimeState(): RuntimeState;
}

class SelectableMemoryHost extends MemoryHost {
  private readonly selections: ProjectRoot[] = [];
  private readonly rootsByKey = new Map<EditorFixtureProjectKey, ProjectRoot>();
  private pendingOperations = 0;
  private activity = 0;
  private retired = false;
  private operationsAfterRetirement = 0;

  constructor(
    projects: readonly MemoryProjectInput[],
    private readonly defaultSelection: Exclude<EditorFixtureProjectKey, 'blank' | 'collision'>,
  ) {
    super({ projects, initialTime: INITIAL_TIME });
    for (const key of fixtureProjectKeys()) {
      const input = editorFixtureProject(key);
      this.rootsByKey.set(key, snapshotProjectRoot({ id: projectId(input.id), name: input.name }));
    }
  }

  selectProject(key: EditorFixtureProjectKey): void {
    this.selections.push(snapshotProjectRoot(this.requireRoot(key)));
    this.activity += 1;
  }

  override chooseProject(): Promise<ProjectRoot | null> {
    return this.track(async () => snapshotProjectRoot(
      this.selections.shift() ?? this.requireRoot(this.defaultSelection),
    ));
  }

  override enumerateFiles(root: ProjectRoot): Promise<FileEnumerationResult> {
    return this.track(() => super.enumerateFiles(root));
  }

  override readText(path: Parameters<MemoryHost['readText']>[0]): Promise<FileReadResult> {
    return this.track(() => super.readText(path));
  }

  override createText(path: Parameters<MemoryHost['createText']>[0], text: string): Promise<FileRevision> {
    return this.track(() => super.createText(path, text));
  }

  override replaceTextAtomically(
    path: Parameters<MemoryHost['replaceTextAtomically']>[0],
    expectedRevision: FileRevision,
    text: string,
  ): Promise<FileRevision> {
    return this.track(() => super.replaceTextAtomically(path, expectedRevision, text));
  }

  override watch(root: ProjectRoot, listener: FileChangeListener): Promise<Disposable> {
    return this.track(() => super.watch(root, listener));
  }

  override advanceTime(milliseconds: number): Promise<void> {
    return this.track(() => super.advanceTime(milliseconds));
  }

  override externalWrite(path: Parameters<MemoryHost['externalWrite']>[0], text: string): Promise<FileRevision> {
    return this.track(() => super.externalWrite(path, text));
  }

  override externalDelete(path: Parameters<MemoryHost['externalDelete']>[0]): Promise<void> {
    return this.track(() => super.externalDelete(path));
  }

  override readRecovery(id: Parameters<MemoryHost['readRecovery']>[0]): Promise<string | null> {
    return this.track(() => super.readRecovery(id));
  }

  override writeRecovery(id: Parameters<MemoryHost['writeRecovery']>[0], journal: string): Promise<void> {
    return this.track(() => super.writeRecovery(id, journal));
  }

  override clearRecovery(id: Parameters<MemoryHost['clearRecovery']>[0]): Promise<void> {
    return this.track(() => super.clearRecovery(id));
  }

  override listRecentProjects(): Promise<readonly RecentProject[]> {
    return this.track(() => super.listRecentProjects());
  }

  override rememberRecentProject(root: ProjectRoot): Promise<void> {
    return this.track(() => super.rememberRecentProject(root));
  }

  override confirm(request: ConfirmationRequest): Promise<ConfirmationResult> {
    return this.track(() => super.confirm(request));
  }

  override showMessage(request: MessageRequest): Promise<void> {
    return this.track(() => super.showMessage(request));
  }

  async projectSnapshot(key: EditorFixtureProjectKey): Promise<ProjectSnapshot> {
    const root = this.requireRoot(key);
    const enumeration = await this.enumerateFiles(root);
    if (enumeration.status !== 'supported') throw new Error(`Fixture enumeration is unsupported: ${key}`);
    const files: Record<string, FileSnapshot> = {};
    for (const path of enumeration.files) {
      const file = await this.readText(path);
      files[path.relativePath] = Object.freeze({ text: file.text, revision: file.revision });
    }
    return Object.freeze({ id: root.id, name: root.name, files: Object.freeze(files) });
  }

  async observations(): Promise<HostObservations> {
    const recovery: Record<string, string | null> = {};
    for (const key of fixtureProjectKeys()) {
      const root = this.requireRoot(key);
      recovery[root.id] = await this.readRecovery(root.id);
    }
    return Object.freeze({
      recovery: Object.freeze(recovery),
      recent: Object.freeze([...(await this.listRecentProjects())]),
      confirmations: this.confirmationRequests,
      messages: this.messageRequests,
    });
  }

  async settled(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await Promise.resolve();
      if (this.pendingOperations === 0) {
        const observedActivity = this.activity;
        await nextPaint();
        await nextPaint();
        if (this.pendingOperations === 0 && this.activity === observedActivity) return;
      } else {
        await nextPaint();
      }
    }
    throw new Error('Fixture host did not settle.');
  }

  retire(): void {
    this.retired = true;
  }

  get lateOperations(): number {
    return this.operationsAfterRetirement;
  }

  private requireRoot(key: EditorFixtureProjectKey): ProjectRoot {
    const root = this.rootsByKey.get(key);
    if (root === undefined) throw new Error(`Unknown fixture project: ${key}`);
    return root;
  }

  private async track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.retired) this.operationsAfterRetirement += 1;
    this.pendingOperations += 1;
    this.activity += 1;
    try {
      return await operation();
    } finally {
      this.pendingOperations -= 1;
      this.activity += 1;
    }
  }
}

class ProductionEditorHarness {
  private reactRoot: Root | null = null;
  private host: SelectableMemoryHost | null = null;
  private workflow: FileWorkflow | null = null;
  private baselines = new Map<EditorFixtureProjectKey, ProjectSnapshot>();
  private runtimeSequence = 0;
  private activeRuntime = 0;
  private readonly completedTeardowns: number[] = [];
  private readonly retiredHosts: SelectableMemoryHost[] = [];

  constructor(private readonly element: HTMLElement) {}

  async reset(source: Exclude<EditorFixtureProjectKey, 'blank' | 'collision'> = 'menu'): Promise<void> {
    await this.teardownCurrentRuntime(true);
    const host = new SelectableMemoryHost(editorFixtureProjects(source), source);
    const baselines = new Map<EditorFixtureProjectKey, ProjectSnapshot>();
    for (const key of fixtureProjectKeys()) baselines.set(key, await host.projectSnapshot(key));
    this.host = host;
    this.baselines = baselines;
    await this.mountRuntime(host);
  }

  async restart(): Promise<void> {
    const host = this.requireHost();
    await this.teardownCurrentRuntime(false);
    this.host = host;
    await this.mountRuntime(host);
  }

  readonly bridge: EditorFixtureBridge = Object.freeze({
    reset: (source) => this.reset(source),
    restart: () => this.restart(),
    settled: () => this.requireHost().settled(),
    selectProject: (key) => this.requireHost().selectProject(key),
    queueConfirmation: (confirmed) => this.requireHost().queueConfirmation(confirmed),
    injectReplacementFailure: (message) => this.requireHost().injectFailure(replacementFailure(message)),
    externalWrite: async (key, path, text) => {
      const project = editorFixtureProject(key);
      await this.requireHost().externalWrite(
        projectPath(snapshotProjectRoot({ id: projectId(project.id), name: project.name }), path),
        text,
      );
    },
    externalDelete: async (key, path) => {
      const project = editorFixtureProject(key);
      await this.requireHost().externalDelete(
        projectPath(snapshotProjectRoot({ id: projectId(project.id), name: project.name }), path),
      );
    },
    advanceTime: (milliseconds) => this.requireHost().advanceTime(milliseconds),
    project: (key) => this.requireHost().projectSnapshot(key),
    baseline: (key) => this.requireBaseline(key),
    observations: () => this.requireHost().observations(),
    snapshot: async () => {
      const host = this.requireHost();
      const projects = {} as Record<EditorFixtureProjectKey, ProjectSnapshot>;
      for (const key of fixtureProjectKeys()) projects[key] = await host.projectSnapshot(key);
      return Object.freeze({ projects: Object.freeze(projects), ...(await host.observations()) });
    },
    runtimeState: () => Object.freeze({
      activeRuntime: this.activeRuntime,
      completedTeardowns: Object.freeze([...this.completedTeardowns]),
      lateHostOperations: this.retiredHosts.reduce((total, host) => total + host.lateOperations, 0),
    }),
  });

  private async mountRuntime(host: SelectableMemoryHost): Promise<void> {
    const browserScope = Object.freeze({});
    const runtimeScope = Object.freeze({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    });
    const store = createRuntimeEditorStore({
      scope: runtimeScope,
      browserHostOptions: { scope: browserScope, fallback: host },
      storage: null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    const runtimeHost = store.getSnapshot().host;
    if (runtimeHost === null) throw new Error('Production editor fixture host is unavailable.');
    const workflow = new FileWorkflow(store, runtimeHost);
    this.workflow = workflow;
    this.runtimeSequence += 1;
    this.activeRuntime = this.runtimeSequence;
    this.reactRoot = createRoot(this.element);
    this.reactRoot.render(<App store={store} task16FileLifecycle={workflow} />);
    await host.settled();
  }

  private async teardownCurrentRuntime(retireHost: boolean): Promise<void> {
    if (this.reactRoot === null || this.host === null || this.workflow === null) return;
    const runtime = this.activeRuntime;
    const host = this.host;
    const workflow = this.workflow;
    this.reactRoot.unmount();
    this.reactRoot = null;
    this.workflow = null;
    await workflow.dispose();
    await host.settled();
    if (retireHost) {
      host.retire();
      this.retiredHosts.push(host);
    }
    this.completedTeardowns.push(runtime);
    this.element.replaceChildren();
  }

  private requireHost(): SelectableMemoryHost {
    if (this.host === null) throw new Error('Fixture host is not initialized.');
    return this.host;
  }

  private requireBaseline(key: EditorFixtureProjectKey): ProjectSnapshot {
    const snapshot = this.baselines.get(key);
    if (snapshot === undefined) throw new Error(`Fixture baseline is unavailable: ${key}`);
    return snapshot;
  }
}

function replacementFailure(message: string): MemoryFailure {
  return Object.freeze({ operation: 'replace', phase: 'during', message });
}

function fixtureProjectKeys(): readonly EditorFixtureProjectKey[] {
  return Object.freeze([
    'menu',
    'options',
    'nested-styles',
    'assets',
    'unsupported',
    'malformed',
    'resolution',
    'blank',
    'collision',
  ]);
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

const element = document.getElementById('root');
if (element === null) throw new Error('Missing production editor fixture root.');
const harness = new ProductionEditorHarness(element);
Object.assign(window, {
  __task17a2a: harness.bridge,
  __task17a2aAssetUrls: EDITOR_ASSET_URLS,
});
await harness.reset();
