import { useEffect, useMemo, useRef } from 'react';
import {
  DesktopCommandBridge,
  DESKTOP_FILE_COMMAND_IDS,
  EditorDesktopCommandController,
  type DesktopEventPort,
  type DesktopFileCommandAvailability,
  type Task16FileCommandPort,
} from '../core/desktop/DesktopCommandBridge';
import {
  DesktopLifecycleController,
  type CloseChoice,
  type CloseLease,
  type CloseResolution,
  type DocumentStateLease,
  type DirtyState,
  type LifecycleGeneration,
  type SaveBeforeCloseResult,
} from '../core/desktop/DesktopLifecycleController';
import { EditorStore } from '../core/store/EditorStore';
import { CommandRegistry, type EditorCommandId } from '../core/store/CommandRegistry';
import type { Disposable } from '../core/host/HostPort';
import type { SourceEditScheduler } from '../core/documents/SourceEditCoordinator';
import { FileWorkflow, type FileWorkflowPort } from '../features/workspace/FileWorkflow';
import { Workbench } from '../features/workspace/Workbench';
import { WorkspaceUiController } from '../features/workspace/WorkspaceUiController';
import { WorkspaceEditingCommands } from '../features/workspace/WorkspaceEditingCommands';
import './app.css';

export interface AppProps {
  readonly store: EditorStore;
  readonly desktop?: AppDesktopPorts;
  readonly task16FileLifecycle?: Task16FileLifecyclePort;
  readonly sourceEditScheduler?: SourceEditScheduler;
}

export interface AppDesktopPorts {
  readonly commandAuthority: object;
  readonly events: DesktopEventPort;
  readonly confirm: { confirmClose(): CloseChoice | Promise<CloseChoice> };
  readonly window: {
    setLifecycleReady(generation: LifecycleGeneration, ready: boolean): void | Promise<void>;
    resolveClose(
      lease: CloseLease,
      generation: LifecycleGeneration,
      resolution: CloseResolution,
    ): void | Promise<void>;
    abandonClose(lease: CloseLease, generation: LifecycleGeneration): void | Promise<void>;
  };
  readonly menu: {
    setFileWorkflowEnabled(
      generation: WorkflowGeneration,
      availability: DesktopFileCommandAvailability,
    ): void | Promise<void>;
  };
  readonly errors: { report(error: unknown): void };
}

export interface Task16FileLifecyclePort extends Task16FileCommandPort, FileWorkflowPort {
  runExclusiveCloseState(
    lease: CloseLease,
    operation: (lease: DocumentStateLease) => void | Promise<void>,
  ): void | Promise<void>;
  finalValidateCloseState(lease: DocumentStateLease): boolean | Promise<boolean>;
  saveBeforeClose(lease: DocumentStateLease): SaveBeforeCloseResult | Promise<SaveBeforeCloseResult>;
}

export type WorkflowGeneration = string;

export class DesktopWorkflowDisableError extends Error {
  readonly completion: Promise<Readonly<{ status: 'failed'; error: unknown }>>;

  constructor(cause: unknown, readonly retry: () => Promise<void>) {
    super('Could not disable native file-workflow commands; listeners remain attached.', { cause });
    this.name = 'DesktopWorkflowDisableError';
    this.completion = Promise.resolve(Object.freeze({ status: 'failed', error: cause }));
  }
}

export function App({ store, desktop, task16FileLifecycle, sourceEditScheduler }: AppProps) {
  const host = store.getSnapshot().host;
  const ownedFileWorkflow = useMemo(
    () => host === null || task16FileLifecycle !== undefined ? null : new FileWorkflow(store, host),
    [host, store, task16FileLifecycle],
  );
  const fileWorkflow = task16FileLifecycle ?? ownedFileWorkflow;
  const latestDesktopErrors = useRef(desktop?.errors);
  latestDesktopErrors.current = desktop?.errors;
  const workspaceUi = useMemo(() => new WorkspaceUiController(), []);
  const editingCommands = useMemo(() => new WorkspaceEditingCommands(store), [store]);
  const commandRegistry = useMemo(
    () => fileWorkflow === null ? null : new CommandRegistry({
      store,
      file: fileWorkflow,
      editing: editingCommands,
      ui: workspaceUi,
      errors: workspaceUi,
    }),
    [editingCommands, fileWorkflow, store, workspaceUi],
  );
  const currentFileLifecycle = task16FileLifecycle ?? fileWorkflow ?? unboundTask16FileLifecycle(store);

  useEffect(() => () => {
    if (ownedFileWorkflow === null) return;
    void Promise.resolve(ownedFileWorkflow.dispose()).catch((error) => {
      latestDesktopErrors.current?.report(error);
    });
  }, [ownedFileWorkflow]);

  useEffect(() => {
    const updateViewport = () => {
      const viewport = readBrowserViewport();
      store.dispatch({ type: 'viewport/set', width: viewport.width, height: viewport.height });
    };
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, [store]);

  useEffect(() => {
    if (desktop === undefined) return;
    let active = true;
    const workflowGeneration = nextWorkflowGeneration();
    const commandGenerations = commandGenerationGate(desktop);
    let commandGenerationRegistered = false;
    const disposables: Disposable[] = [];
    let menuTransitionTail = Promise.resolve();
    const commandBridge = new DesktopCommandBridge(
      desktop.events,
      commandRegistry === null
        ? new EditorDesktopCommandController(store, task16FileLifecycle)
        : { execute: async (command) => { await commandRegistry.execute(command as EditorCommandId); } },
      desktop.errors,
      () => commandGenerations.isCurrent(workflowGeneration),
    );
    const lifecycle = new DesktopLifecycleController({
      events: desktop.events,
      state: {
        runExclusive: (lease, operation) => currentFileLifecycle.runExclusiveCloseState(lease, operation),
        finalValidate: (lease) => currentFileLifecycle.finalValidateCloseState(lease),
      },
      confirm: desktop.confirm,
      save: { saveBeforeClose: (lease) => currentFileLifecycle.saveBeforeClose(lease) },
      window: desktop.window,
      errors: desktop.errors,
    });
    const disposeStarted = () => {
      if (commandGenerationRegistered) {
        commandGenerations.retire(workflowGeneration);
        commandGenerationRegistered = false;
      }
      for (const disposable of disposables.splice(0)) {
        disposable.dispose();
      }
    };
    const transitionFileWorkflow = (
      availability: DesktopFileCommandAvailability,
    ): Promise<void> => {
      const transition = menuTransitionTail.then(async () => {
        await desktop.menu.setFileWorkflowEnabled(workflowGeneration, availability);
      });
      menuTransitionTail = transition.catch(() => undefined);
      return transition;
    };
    const disableFileWorkflow = async (reportFailure = true): Promise<boolean> => {
      try {
        await transitionFileWorkflow(DISABLED_FILE_COMMAND_AVAILABILITY);
        disposeStarted();
        return true;
      } catch (error) {
        if (reportFailure) {
          desktop.errors.report(new DesktopWorkflowDisableError(error, async () => {
            if (!await disableFileWorkflow(false)) {
              throw error;
            }
          }));
        }
        return false;
      }
    };
    void (async () => {
      try {
        const lifecycleDisposable = await lifecycle.start();
        if (!active) {
          lifecycleDisposable.dispose();
          return;
        }
        disposables.push(lifecycleDisposable);
        const commandDisposable = await commandBridge.start();
        if (!active) {
          commandDisposable.dispose();
          return;
        }
        disposables.push(commandDisposable);
        commandGenerations.register(workflowGeneration);
        commandGenerationRegistered = true;
        if (commandRegistry !== null) {
          disposables.push(Object.freeze({
            dispose: commandRegistry.subscribe(() => {
              if (!active || !commandGenerationRegistered) return;
              void transitionFileWorkflow(fileCommandAvailability(commandRegistry)).catch((error) => {
                try {
                  desktop.errors.report(error);
                } catch {
                  // Registry-driven native updates stay contained at the desktop boundary.
                }
              });
            }),
          }));
        }
        await transitionFileWorkflow(fileCommandAvailability(commandRegistry));
        if (!active) await disableFileWorkflow();
      } catch (error) {
        await disableFileWorkflow();
        desktop.errors.report(error);
      }
    })();
    return () => {
      active = false;
      void disableFileWorkflow();
    };
  }, [commandRegistry, currentFileLifecycle, desktop, fileWorkflow, store, task16FileLifecycle]);

  return (
    <main className="app-main">
      <Workbench
        store={store}
        registry={commandRegistry ?? undefined}
        workflow={fileWorkflow ?? undefined}
        ui={commandRegistry === null ? undefined : workspaceUi}
        sourceEditScheduler={sourceEditScheduler}
      />
    </main>
  );
}

const DISABLED_FILE_COMMAND_AVAILABILITY = fileCommandAvailability(null);

function fileCommandAvailability(
  registry: CommandRegistry | null,
): DesktopFileCommandAvailability {
  const enabledById = new Map(
    registry?.getSnapshot().commands.map(({ id, enabled }) => [id, enabled] as const) ?? [],
  );
  return Object.freeze(Object.fromEntries(
    DESKTOP_FILE_COMMAND_IDS.map((id) => [id, enabledById.get(id) ?? false]),
  )) as DesktopFileCommandAvailability;
}

let workflowSequence = 1;
const commandGenerationGates = new WeakMap<object, DesktopCommandGenerationGate>();

interface DesktopCommandGenerationGate {
  register(generation: WorkflowGeneration): void;
  retire(generation: WorkflowGeneration): void;
  isCurrent(generation: WorkflowGeneration): boolean;
}

function commandGenerationGate(desktop: AppDesktopPorts): DesktopCommandGenerationGate {
  const existing = commandGenerationGates.get(desktop.commandAuthority);
  if (existing !== undefined) return existing;
  let highWater: WorkflowGeneration | undefined;
  let current: WorkflowGeneration | undefined;
  const gate = Object.freeze({
    register: (generation: WorkflowGeneration) => {
      if (highWater !== undefined && generation <= highWater) return;
      highWater = generation;
      current = generation;
    },
    retire: (generation: WorkflowGeneration) => {
      if (current === generation) current = undefined;
    },
    isCurrent: (generation: WorkflowGeneration) => current === generation,
  });
  commandGenerationGates.set(desktop.commandAuthority, gate);
  return gate;
}

function nextWorkflowGeneration(): WorkflowGeneration {
  const sequence = workflowSequence;
  workflowSequence += 1;
  return `workflow:v1:${sequence.toString(16).padStart(16, '0')}`;
}

function unboundTask16FileLifecycle(store: EditorStore): Task16FileLifecyclePort {
  const held = new WeakMap<DocumentStateLease, Readonly<{
    session: ReturnType<EditorStore['getSnapshot']>['session'];
    generation: number;
  }>>();
  return Object.freeze({
    runExclusiveCloseState: async (
      _nativeLease: CloseLease,
      operation: (lease: DocumentStateLease) => void | Promise<void>,
    ) => {
      const session = store.getSnapshot().session;
      const generation = session?.generation ?? 0;
      const lease = Object.freeze({
        generation,
        dirtyState: (session === null ? 'clean' : 'unknown') as DirtyState,
      });
      held.set(lease, Object.freeze({ session, generation }));
      try {
        await operation(lease);
      } finally {
        held.delete(lease);
      }
    },
    finalValidateCloseState: (lease: DocumentStateLease) => {
      const expected = held.get(lease);
      const session = store.getSnapshot().session;
      return expected !== undefined
        && expected.session === session
        && expected.generation === (session?.generation ?? 0);
    },
    saveBeforeClose: async (): Promise<SaveBeforeCloseResult> => 'cancelled',
    newProject: async () => undefined,
    openProject: async () => undefined,
    openRecent: async () => undefined,
    save: async () => undefined,
    saveAs: async () => undefined,
    saveAll: async () => undefined,
    closeProject: async () => undefined,
    reopenProject: async () => undefined,
    reloadProject: async () => undefined,
    resolveExternalChange: async () => undefined,
    getSnapshot: () => Object.freeze({
      projectName: null,
      dirtyState: 'clean' as const,
      recentProjects: Object.freeze([]),
      externalChanges: Object.freeze([]),
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
    dispose: () => undefined,
  });
}

function readBrowserViewport(): Readonly<{ width: number; height: number }> {
  return Object.freeze({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  });
}
