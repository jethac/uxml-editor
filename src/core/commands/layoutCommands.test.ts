import { describe, expect, it } from 'vitest';
import type { EditorElement, PreviewFrame } from '../adapter/types';
import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import { DocumentSession } from '../documents/DocumentSession';
import { layoutCommands } from './layoutCommands';
import { entryPath, openSession } from './uxmlCommands.testUtils';

describe('layoutCommands', () => {
  it('refuses free movement for a flex-flow child and explains why', () => {
    const session = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:VisualElement name="flex-child" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n'));
    const flexChild = elementNamed(session.document.root, 'flex-child');

    const result = layoutCommands.move(session, flexChild, { x: 20, y: 10 });

    expect(result).toEqual({
      ok: false,
      diagnostic: expect.objectContaining({ code: 'AMBIGUOUS_LAYOUT_WRITE' }),
    });
    expect(session.snapshot().files.get(session.entryPath)?.text).toContain('name="flex-child" />');
  });

  it('writes movement to the unique winning authored rule and preserves unrelated source', () => {
    const ussPath = 'Assets/UI/screen.uss';
    const session = DocumentSession.open(new Map([
      [entryPath, [
        '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
        '  <Style src="screen.uss" />',
        '  <!-- preserve me -->',
        '  <ui:VisualElement name="absolute" />',
        '</ui:UXML>',
      ].join('\n')],
      [ussPath, '#absolute { position: absolute; left: 2px; top: 3px; color: red; }'],
    ]), entryPath, new UxmlPreviewAdapter());
    const node = elementNamed(session.document.root, 'absolute');

    const result = layoutCommands.move(session, node, { x: 20, y: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    session.history.execute(result.transaction);
    expect(session.snapshot().files.get(ussPath)?.text).toBe(
      '#absolute { position: absolute; left: 20px; top: 10px; color: red; }',
    );
    expect(session.snapshot().files.get(entryPath)?.text).toContain('<!-- preserve me -->');
    expect(session.history.undoDepth).toBe(1);
  });

  it('allows direct size writes for a flex-flow child through its safe inline target', () => {
    const session = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="flex-child" />',
      '</ui:UXML>',
    ].join('\n'));
    const node = elementNamed(session.document.root, 'flex-child');

    const result = layoutCommands.resize(session, node, { width: 120, height: 30 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    session.history.execute(result.transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toContain(
      'name="flex-child" style="width: 120px; height: 30px;"',
    );
    expect(session.history.undoDepth).toBe(1);
  });

  it('moves contiguous siblings to the source front and back losslessly', () => {
    const source = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:Label name="first" />',
      '    <!-- exact gap -->',
      '    <ui:Label name="second" />',
      '    <ui:Label name="third" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n');
    const session = openSession(source);
    const first = elementNamed(session.document.root, 'first');

    const front = layoutCommands.order(session, [first], 'front');

    expect(front.ok).toBe(true);
    if (!front.ok) return;
    session.history.execute(front.transaction);
    const moved = session.snapshot().files.get(entryPath)?.text ?? '';
    expect(moved.indexOf('name="first"')).toBeGreaterThan(moved.indexOf('name="third"'));
    expect(moved).toContain('<!-- exact gap -->');
  });

  it('aligns and distributes multiple absolute elements as one history operation', () => {
    const source = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:VisualElement name="a" style="position: absolute; left: 0px; top: 0px; width: 10px; height: 10px;" />',
      '    <ui:VisualElement name="b" style="position: absolute; left: 30px; top: 20px; width: 10px; height: 10px;" />',
      '    <ui:VisualElement name="c" style="position: absolute; left: 100px; top: 40px; width: 10px; height: 10px;" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n');
    const alignSession = openSession(source);
    const alignNodes = ['a', 'b', 'c'].map((name) => elementNamed(alignSession.document.root, name));
    const alignResult = layoutCommands.align(alignSession, alignNodes, 'top', frameFor(alignNodes));
    expect(alignResult.ok).toBe(true);
    if (!alignResult.ok) return;
    expect(alignResult.transaction.patchesByFile.get(entryPath)).toHaveLength(2);
    alignSession.history.execute(alignResult.transaction);
    expect(alignSession.snapshot().files.get(entryPath)?.text.match(/top: 0px;/g)).toHaveLength(3);
    expect(alignSession.history.undoDepth).toBe(1);

    const distributeSession = openSession(source);
    const distributeNodes = ['a', 'b', 'c'].map((name) => elementNamed(distributeSession.document.root, name));
    const distributeResult = layoutCommands.distribute(
      distributeSession,
      distributeNodes,
      'horizontal',
      frameFor(distributeNodes),
    );
    expect(distributeResult.ok).toBe(true);
    if (!distributeResult.ok) return;
    distributeSession.history.execute(distributeResult.transaction);
    expect(distributeSession.snapshot().files.get(entryPath)?.text).toContain('name="b" style="position: absolute; left: 50px;');
    expect(distributeSession.history.undoDepth).toBe(1);
  });

  it('refuses distribution when any geometry endpoint is not absolutely positioned', () => {
    const session = openSession([
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">',
      '  <ui:VisualElement name="parent">',
      '    <ui:VisualElement name="a" style="width: 10px; height: 10px;" />',
      '    <ui:VisualElement name="b" style="position: absolute; left: 30px; top: 20px; width: 10px; height: 10px;" />',
      '    <ui:VisualElement name="c" style="position: absolute; left: 100px; top: 40px; width: 10px; height: 10px;" />',
      '  </ui:VisualElement>',
      '</ui:UXML>',
    ].join('\n'));
    const nodes = ['a', 'b', 'c'].map((name) => elementNamed(session.document.root, name));

    const result = layoutCommands.distribute(session, nodes, 'horizontal', frameFor(nodes));

    expect(result).toEqual({
      ok: false,
      diagnostic: expect.objectContaining({ code: 'AMBIGUOUS_LAYOUT_WRITE' }),
    });
  });
});

function frameFor(nodes: readonly EditorElement[]): PreviewFrame {
  const positions = new Map([
    ['a', { left: 0, top: 0, width: 10, height: 10 }],
    ['b', { left: 30, top: 20, width: 10, height: 10 }],
    ['c', { left: 100, top: 40, width: 10, height: 10 }],
  ]);
  return {
    elements: new Map(),
    boxes: new Map(nodes.map((node) => [node.id, positions.get(authoredName(node))!])),
    diagnostics: [],
    nodeForElement: () => null,
    dispose: () => undefined,
  };
}

function authoredName(node: EditorElement): string {
  return node.attributes.find((attribute) => attribute.name === 'name')?.value ?? '';
}

function elementNamed(root: EditorElement, name: string): EditorElement {
  const match = [root, ...root.children.flatMap(walk)].find((element) =>
    element.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name),
  );
  if (match === undefined) throw new Error(`Missing fixture element ${name}.`);
  return match;
}

function walk(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walk)];
}
