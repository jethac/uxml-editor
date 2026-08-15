import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App';
import { UxmlPreviewAdapter } from '../../../src/core/adapter/UxmlPreviewAdapter';
import type { EditorElement } from '../../../src/core/adapter/types';
import { DocumentSession } from '../../../src/core/documents/DocumentSession';
import { EditorStore } from '../../../src/core/store/EditorStore';

const entryPath = 'Assets/UI/task-13.uxml';
const sheetPath = 'Assets/UI/task-13.uss';
const session = DocumentSession.open(new Map([
  [entryPath, `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="task-13.uss" />
  <ui:Button name="primary" class="primary action" text="Save" focusable="true" custom-mode="legacy" />
</ui:UXML>
`],
  [sheetPath, `.primary {
  width: 180px;
  height: 44px;
  position: absolute;
  background-color: #2e7d4f;
  color: #ffffff;
  font-size: 16px;
}
.primary:hover { width: 200px; }
`],
]), entryPath, new UxmlPreviewAdapter());
const selected = nodeByName(session.document.root, 'primary');
session.setSelection([session.locatorFor(selected.id)!]);
const store = new EditorStore({
  session,
  viewport: { width: window.innerWidth, height: window.innerHeight },
});
store.dispatch({ type: 'panel/set', panel: 'inspector' });

Object.assign(window, {
  __task13: {
    source: (path: string) => session.snapshot().files.get(path)?.text ?? '',
    undoDepth: () => session.history.undoDepth,
  },
});

const root = document.getElementById('root');
if (root === null) throw new Error('Missing browser fixture root.');
createRoot(root).render(<App store={store} />);

function nodeByName(root: EditorElement, name: string): EditorElement {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name)) return current;
    pending.push(...current.children);
  }
  throw new Error(`Missing fixture node ${name}.`);
}
