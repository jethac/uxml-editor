import { useEffect } from 'react';
import {
  DesktopCommandBridge,
  EditorDesktopCommandController,
  type DesktopEventPort,
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
import type { Disposable } from '../core/host/HostPort';
import { Workbench } from '../features/workspace/Workbench';
import './app.css';

export interface AppProps {
  readonly store: EditorStore;
  readonly desktop?: AppDesktopPorts;
  readonly task16FileLifecycle?: Task16FileLifecyclePort;
}

export interface AppDesktopPorts {
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
    setFileWorkflowEnabled(generation: WorkflowGeneration, enabled: boolean): void | Promise<void>;
  };
  readonly errors: { report(error: unknown): void };
}

export interface Task16FileLifecyclePort extends Task16FileCommandPort {
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

export function App({ store, desktop, task16FileLifecycle }: AppProps) {
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
    const disposables: Disposable[] = [];
    const currentFileLifecycle = task16FileLifecycle ?? unboundTask16FileLifecycle(store);
    const commandBridge = new DesktopCommandBridge(
      desktop.events,
      new EditorDesktopCommandController(store, task16FileLifecycle),
      desktop.errors,
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
      for (const disposable of disposables.splice(0)) {
        disposable.dispose();
        if (disposable.completion !== undefined) {
          void disposable.completion.then((outcome) => {
            if (outcome.status === 'failed') desktop.errors.report(outcome.error);
          });
        }
      }
    };
    const disableFileWorkflow = async (reportFailure = true): Promise<boolean> => {
      try {
        await desktop.menu.setFileWorkflowEnabled(workflowGeneration, false);
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
        await desktop.menu.setFileWorkflowEnabled(
          workflowGeneration,
          task16FileLifecycle !== undefined,
        );
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
  }, [desktop, store, task16FileLifecycle]);

  return <Workbench store={store} />;
}

let workflowSequence = 1;

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
    save: async () => undefined,
    saveAll: async () => undefined,
    closeProject: async () => undefined,
  });
}

function readBrowserViewport(): Readonly<{ width: number; height: number }> {
  return Object.freeze({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  });
}
