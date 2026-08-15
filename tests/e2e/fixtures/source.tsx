import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App';
import { UxmlPreviewAdapter } from '../../../src/core/adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../../../src/core/documents/DocumentSession';
import { EditorStore } from '../../../src/core/store/EditorStore';

const entryPath = 'Assets/UI/task-14.uxml';
const sheetPath = 'Assets/UI/task-14.uss';
const original = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="task-14.uss" />
  <ui:VisualElement name="root">
    <ui:Label name="title" text="Source workflow" />
    <ui:Button name="save" text="Save" />
  </ui:VisualElement>
</ui:UXML>
`;
const session = DocumentSession.open(new Map([
  [entryPath, original],
  [sheetPath, `.root { padding: 16px; }
.title { color: #245f3a; font-size: 18px; }
`],
]), entryPath, new UxmlPreviewAdapter());
const store = new EditorStore({
  session,
  viewport: { width: window.innerWidth, height: window.innerHeight },
});

Object.assign(window, {
  __task14: {
    original,
    source: (path: string) => session.snapshot().files.get(path)?.text ?? '',
    undoDepth: () => session.history.undoDepth,
  },
});

const root = document.getElementById('root');
if (root === null) throw new Error('Missing browser fixture root.');
createRoot(root).render(<App store={store} />);
