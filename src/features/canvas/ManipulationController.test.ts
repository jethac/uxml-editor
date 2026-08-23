import { describe, expect, it } from 'vitest';
import type { EditorElement, PreviewFrame } from '../../core/adapter/types';
import { openSession } from '../../core/commands/uxmlCommands.testUtils';
import { ManipulationController, snapPosition } from './ManipulationController';

describe('ManipulationController', () => {
  it('coalesces a pointer drag into one undo entry', () => {
    const session = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="absolute" style="position: absolute; left: 0px; top: 0px; width: 40px; height: 20px;" />',
      '</ui:UXML>',
    ].join('\n'));
    const node = elementNamed(session.document.root, 'absolute');
    const frame = previewFrame(node, { left: 0, top: 0, width: 40, height: 20 });
    const drag = new ManipulationController(session, frame);

    expect(drag.start(node, { x: 0, y: 0 })).toEqual({ ok: true });
    expect(drag.update({ x: 5, y: 4 }).ok).toBe(true);
    expect(drag.update({ x: 20, y: 10 }).ok).toBe(true);
    drag.finish();

    expect(session.history.undoDepth).toBe(1);
    expect(session.snapshot().files.get(session.entryPath)?.text).toContain('left: 20px; top: 10px;');
  });

  it('snaps moving edges and centers to parent and sibling geometry', () => {
    const siblingEdge = snapPosition(
      { left: 0, top: 0, width: 20, height: 20 },
      { x: 78, y: 35 },
      [{ left: 100, top: 10, width: 40, height: 80 }],
      3,
    );
    const parentCenter = snapPosition(
      { left: 0, top: 0, width: 20, height: 20 },
      { x: 41, y: 39 },
      [{ left: 0, top: 0, width: 100, height: 100 }],
      2,
    );

    expect(siblingEdge).toEqual({ x: 80, y: 35, guides: [{ axis: 'x', value: 100 }] });
    expect(parentCenter).toEqual({
      x: 40,
      y: 40,
      guides: [{ axis: 'x', value: 50 }, { axis: 'y', value: 50 }],
    });
  });

  it('refuses a resize when the source-backed selection is not absolutely positioned', () => {
    const source = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="relative" style="width: 40px; height: 20px;" />',
      '</ui:UXML>',
    ].join('\n');
    const session = openSession(source);
    const node = elementNamed(session.document.root, 'relative');
    const resize = new ManipulationController(session, previewFrame(node, { left: 0, top: 0, width: 40, height: 20 }));

    expect(resize.startResize(node, { x: 40, y: 20 })).toEqual({
      ok: false,
      diagnostic: {
        code: 'AMBIGUOUS_LAYOUT_WRITE',
        message: 'Free movement requires computed position to be exactly absolute.',
        nodeId: node.id,
      },
    });
    expect(session.snapshot().files.get(session.entryPath)?.text).toBe(source);
    expect(session.history.undoDepth).toBe(0);
  });
});

function previewFrame(node: EditorElement, box: { left: number; top: number; width: number; height: number }): PreviewFrame {
  return {
    elements: new Map([[node.id, document.createElement('div')]]),
    boxes: new Map([[node.id, box]]),
    diagnostics: [],
    nodeForElement: () => null,
    dispose: () => undefined,
  };
}

function elementNamed(root: EditorElement, name: string): EditorElement {
  const match = walk(root).find((element) =>
    element.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name),
  );
  if (match === undefined) throw new Error(`Missing fixture element ${name}.`);
  return match;
}

function walk(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walk)];
}
