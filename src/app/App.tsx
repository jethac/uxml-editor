import { useEffect, useRef } from 'react';
import { createBrowserLayoutStorage } from '../core/store/EditorLayoutStorage';
import { EditorStore } from '../core/store/EditorStore';
import { Workbench } from '../features/workspace/Workbench';
import './app.css';

export interface AppProps {
  readonly store?: EditorStore;
}

export function App({ store: providedStore }: AppProps = {}) {
  const storeRef = useRef<EditorStore | null>(null);
  if (providedStore === undefined && storeRef.current === null) {
    storeRef.current = new EditorStore({
      storage: createBrowserLayoutStorage(),
      viewport: readBrowserViewport(),
    });
  }
  const store = providedStore ?? storeRef.current!;

  useEffect(() => {
    const updateViewport = () => {
      const viewport = readBrowserViewport();
      store.dispatch({ type: 'viewport/set', width: viewport.width, height: viewport.height });
    };
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, [store]);

  return <Workbench store={store} />;
}

function readBrowserViewport(): Readonly<{ width: number; height: number }> {
  if (typeof window === 'undefined') return Object.freeze({ width: 1366, height: 768 });
  return Object.freeze({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  });
}
