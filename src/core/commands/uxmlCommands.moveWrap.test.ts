import { describe, expect, it } from 'vitest';
import {
  insertElement,
  moveElement,
  UxmlCommandError,
  wrapElements,
} from './uxmlCommands';
import { entryPath, locatorNamed, locatorWithName, openSession } from './uxmlCommands.testUtils';

describe('UXML move and wrap commands', () => {
  it('moves an exact subtree across parents and preserves source and destination trivia', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:x="Example">\r\n'
      + '  <ui:VisualElement name="from">\r\n'
      + '    <!-- source comment -->\r\n'
      + '\t<x:Widget name="move"><Odd-Child /><!-- inside --></x:Widget>loose source\r\n'
      + '  </ui:VisualElement>\r\n'
      + '  <ui:VisualElement name="to">\r\n'
      + '    <ui:Label />\r\n'
      + '    <!-- destination comment -->\r\n'
      + '  </ui:VisualElement>\r\n'
      + '</ui:UXML>\r\n';
    const session = openSession(original);
    const widget = locatorWithName(session, 'move');
    const destination = locatorWithName(session, 'to');
    const fragmentStart = original.indexOf('<x:Widget');
    const fragmentEnd = original.indexOf('</x:Widget>') + '</x:Widget>'.length;
    const fragment = original.slice(fragmentStart, fragmentEnd);
    const destinationOffset = original.indexOf('<ui:Label') + '<ui:Label />'.length;

    const transaction = moveElement(session, widget, destination, 1);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([
      { start: fragmentStart, end: fragmentEnd, replacement: '' },
      { start: destinationOffset, end: destinationOffset, replacement: `\r\n    ${fragment}` },
    ]);
    session.history.execute(transaction);
    const moved = original.slice(0, fragmentStart)
      + original.slice(fragmentEnd, destinationOffset)
      + `\r\n    ${fragment}`
      + original.slice(destinationOffset);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(moved);
    expect(moved).toContain('<!-- source comment -->');
    expect(moved).toContain('loose source');
    expect(moved).toContain('<!-- destination comment -->');
    session.history.undo();
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
    session.history.redo();
    expect(session.snapshot().files.get(entryPath)?.text).toBe(moved);
  });

  it('reorders a sibling using a final index after removing the moving element', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n'
      + '  <ui:VisualElement name="parent">\n'
      + '    <ui:Label name="a" />\n'
      + '    <!-- between a and b -->\n'
      + '    <ui:Label name="b" />\n'
      + '    <ui:Label name="c" />\n'
      + '  </ui:VisualElement>\n'
      + '</ui:UXML>\n';
    const session = openSession(original);
    const parent = locatorWithName(session, 'parent');
    const child = locatorWithName(session, 'c');
    const fragmentStart = original.indexOf('<ui:Label name="c"');
    const fragmentEnd = fragmentStart + '<ui:Label name="c" />'.length;
    const insertion = original.indexOf('<ui:Label name="a"');

    const transaction = moveElement(session, child, parent, 0);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([
      {
        start: insertion,
        end: insertion,
        replacement: '<ui:Label name="c" />\n    ',
      },
      { start: fragmentStart, end: fragmentEnd, replacement: '' },
    ]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toContain('<!-- between a and b -->');
    expect(session.document.root.children[0].children.map((element) =>
      element.attributes.find((attribute) => attribute.name === 'name')?.value,
    )).toEqual(['c', 'a', 'b']);
    session.history.undo();
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });

  it('moves a child into a self-closing destination by converting only its delimiter', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n'
      + '  <ui:VisualElement name="from">\n'
      + '    <ui:Label name="move" />\n'
      + '  </ui:VisualElement>\n'
      + '  <ui:VisualElement name="to" />\n'
      + '</ui:UXML>\n';
    const session = openSession(original);
    const child = locatorWithName(session, 'move');
    const destination = locatorWithName(session, 'to');
    const childStart = original.indexOf('<ui:Label');
    const childEnd = childStart + '<ui:Label name="move" />'.length;
    const slash = original.indexOf('/>', original.indexOf('name="to"'));
    const replacement = '>\n    <ui:Label name="move" />\n  </ui:VisualElement>';

    const transaction = moveElement(session, child, destination, 0);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([
      { start: childStart, end: childEnd, replacement: '' },
      { start: slash, end: slash + 2, replacement },
    ]);
    session.history.execute(transaction);
    expect(session.document.root.children[1].children[0].name).toBe('ui:Label');
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, childStart)
      + original.slice(childEnd, slash)
      + replacement
      + original.slice(slash + 2),
    );
  });

  it('moves a contiguous sibling group with its exact intervening trivia', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n'
      + '  <ui:VisualElement name="from">\n'
      + '    <ui:Label name="a" />\n'
      + '    <!-- moves with group -->\n'
      + '\t<ui:Button name="b" />\n'
      + '  </ui:VisualElement>\n'
      + '  <ui:VisualElement name="to">\n'
      + '    <ui:Label name="existing" />\n'
      + '  </ui:VisualElement>\n'
      + '</ui:UXML>\n';
    const session = openSession(original);
    const first = locatorWithName(session, 'a');
    const second = locatorWithName(session, 'b');
    const destination = locatorWithName(session, 'to');
    const groupStart = original.indexOf('<ui:Label name="a"');
    const groupEnd = original.indexOf('<ui:Button name="b"') + '<ui:Button name="b" />'.length;
    const group = original.slice(groupStart, groupEnd);
    const insertion = original.indexOf('<ui:Label name="existing"') + '<ui:Label name="existing" />'.length;

    const transaction = moveElement(session, [first, second], destination, 1);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([
      { start: groupStart, end: groupEnd, replacement: '' },
      { start: insertion, end: insertion, replacement: `\n    ${group}` },
    ]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toContain('<!-- moves with group -->');
    expect(session.document.root.children[1].children.map((element) =>
      element.attributes.find((attribute) => attribute.name === 'name')?.value,
    )).toEqual(['existing', 'a', 'b']);
  });

  it('wraps contiguous siblings while preserving their exact bytes and intervening comment', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\r\n'
      + '  <ui:VisualElement name="parent">\r\n'
      + '    <ui:Label name="a" />\r\n'
      + '\t<!-- keep between -->\r\n'
      + '\t<ui:Button name="b" />\r\n'
      + '  </ui:VisualElement>\r\n'
      + '</ui:UXML>\r\n';
    const session = openSession(original);
    const first = locatorWithName(session, 'a');
    const second = locatorWithName(session, 'b');
    const firstStart = original.indexOf('<ui:Label');
    const secondEnd = original.indexOf('<ui:Button') + '<ui:Button name="b" />'.length;

    const transaction = wrapElements(session, [first, second], 'ui:VisualElement');

    expect(transaction.patchesByFile.get(entryPath)).toEqual([
      {
        start: firstStart,
        end: firstStart,
        replacement: '<ui:VisualElement>\r\n      ',
      },
      {
        start: secondEnd,
        end: secondEnd,
        replacement: '\r\n    </ui:VisualElement>',
      },
    ]);
    session.history.execute(transaction);
    const wrapper = session.document.root.children[0].children[0];
    expect(wrapper.name).toBe('ui:VisualElement');
    expect(wrapper.children.map((element) => element.name)).toEqual(['ui:Label', 'ui:Button']);
    expect(session.snapshot().files.get(entryPath)?.text).toContain('<!-- keep between -->');
  });

  it('rejects unsafe indices, hierarchy cycles, and overlapping multi-node selections', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n'
      + '  <ui:VisualElement name="parent">\n'
      + '    <ui:Label name="a"><ui:Button name="nested" /></ui:Label>\n'
      + '    <ui:Label name="b" />\n'
      + '    <ui:Label name="c" />\n'
      + '  </ui:VisualElement>\n'
      + '</ui:UXML>\n';
    const session = openSession(original);
    const parent = locatorWithName(session, 'parent');
    const first = locatorWithName(session, 'a');
    const second = locatorWithName(session, 'b');
    const third = locatorWithName(session, 'c');
    const nested = locatorWithName(session, 'nested');

    const cases: readonly [() => unknown, UxmlCommandError['code']][] = [
      [() => insertElement(session, parent, -1, '<ui:Label />'), 'invalid-index'],
      [() => insertElement(session, parent, 4, '<ui:Label />'), 'invalid-index'],
      [() => moveElement(session, second, parent, 1), 'illegal-hierarchy'],
      [() => moveElement(session, parent, nested, 0), 'illegal-hierarchy'],
      [() => moveElement(session, [], parent, 0), 'invalid-selection'],
      [() => moveElement(session, [first, first], parent, 0), 'invalid-selection'],
      [() => moveElement(session, [first, third], parent, 0), 'invalid-selection'],
      [() => wrapElements(session, [], 'ui:VisualElement'), 'invalid-selection'],
      [() => wrapElements(session, [first, first], 'ui:VisualElement'), 'invalid-selection'],
      [() => wrapElements(session, [first, third], 'ui:VisualElement'), 'invalid-selection'],
      [() => wrapElements(session, [first, nested], 'ui:VisualElement'), 'invalid-selection'],
    ];
    for (const [operation, code] of cases) {
      expect(operation).toThrowError(expect.objectContaining<Partial<UxmlCommandError>>({ code }));
    }
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });
});
