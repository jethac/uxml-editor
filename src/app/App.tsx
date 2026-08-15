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
    setLifecycleReady(ready: boolean): void | Promise<void>;
    resolveClose(lease: CloseLease, resolution: CloseResolution): void | Promise<void>;
  };
  readonly menu: { setFileWorkflowEnabled(enabled: boolean): void | Promise<void> };
  readonly errors: { report(error: unknown): void };
}

export interface Task16FileLifecyclePort extends Task16FileCommandPort {
  acquireCloseState(lease: CloseLease): DocumentStateLease | Promise<DocumentStateLease>;
  finalValidateCloseState(lease: DocumentStateLease): boolean | Promise<boolean>;
  releaseCloseState(lease: DocumentStateLease): void | Promise<void>;
  saveBeforeClose(lease: DocumentStateLease): SaveBeforeCloseResult | Promise<SaveBeforeCloseResult>;
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
        acquire: (lease) => currentFileLifecycle.acquireCloseState(lease),
        finalValidate: (lease) => currentFileLifecycle.finalValidateCloseState(lease),
        release: (lease) => currentFileLifecycle.releaseCloseState(lease),
      },
      confirm: desktop.confirm,
      save: { saveBeforeClose: (lease) => currentFileLifecycle.saveBeforeClose(lease) },
      window: desktop.window,
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
    const disableFileWorkflow = async () => {
      try {
        await desktop.menu.setFileWorkflowEnabled(false);
      } catch (error) {
        desktop.errors.report(error);
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
        await desktop.menu.setFileWorkflowEnabled(task16FileLifecycle !== undefined);
        if (!active) await disableFileWorkflow();
      } catch (error) {
        disposeStarted();
        await disableFileWorkflow();
        desktop.errors.report(error);
      }
    })();
    return () => {
      active = false;
      disposeStarted();
      void disableFileWorkflow();
    };
  }, [desktop, store, task16FileLifecycle]);

  return <Workbench store={store} />;
}

function unboundTask16FileLifecycle(store: EditorStore): Task16FileLifecyclePort {
  const held = new WeakMap<DocumentStateLease, Readonly<{
    session: ReturnType<EditorStore['getSnapshot']>['session'];
    generation: number;
  }>>();
  return Object.freeze({
    acquireCloseState: () => {
      const session = store.getSnapshot().session;
      const generation = session?.generation ?? 0;
      const lease = Object.freeze({
        generation,
        dirtyState: (session === null ? 'clean' : 'unknown') as DirtyState,
      });
      held.set(lease, Object.freeze({ session, generation }));
      return lease;
    },
    finalValidateCloseState: (lease: DocumentStateLease) => {
      const expected = held.get(lease);
      const session = store.getSnapshot().session;
      return expected !== undefined
        && expected.session === session
        && expected.generation === (session?.generation ?? 0);
    },
    releaseCloseState: (lease: DocumentStateLease) => { held.delete(lease); },
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
