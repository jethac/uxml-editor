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
  type DirtyState,
  type SaveBeforeCloseResult,
} from '../core/desktop/DesktopLifecycleController';
import { EditorStore } from '../core/store/EditorStore';
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
  readonly window: { close(): void | Promise<void> };
}

export interface Task16FileLifecyclePort extends Task16FileCommandPort {
  getDirtyState(): DirtyState | Promise<DirtyState>;
  saveBeforeClose(): SaveBeforeCloseResult | Promise<SaveBeforeCloseResult>;
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
    const disposables: Array<{ dispose(): void }> = [];
    const currentFileLifecycle = task16FileLifecycle ?? unboundTask16FileLifecycle(store);
    const commandBridge = new DesktopCommandBridge(
      desktop.events,
      new EditorDesktopCommandController(store, task16FileLifecycle),
    );
    const lifecycle = new DesktopLifecycleController({
      events: desktop.events,
      dirty: { getDirtyState: () => currentFileLifecycle.getDirtyState() },
      confirm: desktop.confirm,
      save: { saveBeforeClose: () => currentFileLifecycle.saveBeforeClose() },
      window: desktop.window,
    });
    void (async () => {
      try {
        const commandDisposable = await commandBridge.start();
        if (!active) return commandDisposable.dispose();
        disposables.push(commandDisposable);
        const lifecycleDisposable = await lifecycle.start();
        if (!active) return lifecycleDisposable.dispose();
        disposables.push(lifecycleDisposable);
      } catch {
        for (const disposable of disposables.splice(0)) disposable.dispose();
      }
    })();
    return () => {
      active = false;
      for (const disposable of disposables.splice(0)) disposable.dispose();
    };
  }, [desktop, store, task16FileLifecycle]);

  return <Workbench store={store} />;
}

function unboundTask16FileLifecycle(store: EditorStore): Task16FileLifecyclePort {
  return Object.freeze({
    getDirtyState: () => store.getSnapshot().session === null ? 'clean' : 'unknown',
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
