import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App';
import { UxmlPreviewAdapter } from '../../../src/core/adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../../../src/core/documents/DocumentSession';
import { EditorStore } from '../../../src/core/store/EditorStore';

const entryPath = 'Assets/UI/task-12.uxml';
const session = DocumentSession.open(new Map([[entryPath, [
  '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
  '  <ui:VisualElement name="surface" style="position: relative; width: 520px; height: 360px;">',
  '    <ui:Button name="target" text="Target" style="position: absolute; left: 20px; top: 30px; width: 100px; height: 40px;" />',
  '    <ui:Button name="peer" text="Peer" style="position: absolute; left: 220px; top: 130px; width: 90px; height: 40px;" />',
  '  </ui:VisualElement>',
  '</ui:UXML>',
].join('\n')]]), entryPath, new UxmlPreviewAdapter());
const store = new EditorStore({
  session,
  viewport: { width: window.innerWidth, height: window.innerHeight },
});

Object.assign(window, {
  __task12: {
    source: () => session.snapshot().files.get(entryPath)?.text ?? '',
    undoDepth: () => session.history.undoDepth,
  },
});

const root = document.getElementById('root');
if (root === null) throw new Error('Missing browser fixture root.');
createRoot(root).render(<App store={store} />);
