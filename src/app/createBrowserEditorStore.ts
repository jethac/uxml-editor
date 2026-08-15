import { createBrowserLayoutStorage } from '../core/store/EditorLayoutStorage';
import { EditorStore } from '../core/store/EditorStore';

export function createBrowserEditorStore(): EditorStore {
  return new EditorStore({
    storage: createBrowserLayoutStorage(),
    viewport: readBrowserViewport(),
  });
}

function readBrowserViewport(): Readonly<{ width: number; height: number }> {
  return Object.freeze({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  });
}
