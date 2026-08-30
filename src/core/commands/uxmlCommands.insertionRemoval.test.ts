import { describe, expect, it } from 'vitest';
import type { ElementLocator } from '../documents/ElementLocator';
import {
  duplicateElement,
  insertElement,
  moveElement,
  removeElement,
  renameElement,
  setAttribute,
  UxmlCommandError,
  wrapElements,
} from './uxmlCommands';
import { entryPath, locatorNamed, locatorWithName, openSession } from './uxmlCommands.testUtils';

describe('UXML insertion and removal commands', () => {
  it('inserts a sibling without dropping comments, malformed text, or mixed indentation', () => {
    const original = '<?xml version="1.0"?>\r\n'
      + '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:vendor="Example">\r\n'
      + '  <ui:VisualElement name="panel">\r\n'
      + '    <ui:Label text="First" />\r\n'
      + '    <!-- keep this -->\r\n'
      + '\t\t<vendor:Widget />loose text\r\n'
      + '  </ui:VisualElement>\r\n'
      + '</ui:UXML>\r\n';
    const session = openSession(original);
    const parent = locatorNamed(session, 'ui:VisualElement');
    const insertion = original.indexOf('<vendor:Widget');
    const fragment = '<ui:Button text="Options" />';

    const transaction = insertElement(session, parent, 1, fragment);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: insertion,
      end: insertion,
      replacement: `${fragment}\r\n\t\t`,
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, insertion) + fragment + '\r\n\t\t' + original.slice(insertion),
    );
  });

  it('converts a self-closing parent using local CRLF indentation', () => {
    const original = '<?xml version="1.0"?>\r\n'
      + '<ui:UXML xmlns:ui="UnityEngine.UIElements">\r\n'
      + '  <ui:VisualElement name="empty" />\r\n'
      + '</ui:UXML>\r\n';
    const session = openSession(original);
    const parent = locatorNamed(session, 'ui:VisualElement');
    const slash = original.indexOf('/>', original.indexOf('name="empty"'));
    const fragment = '<ui:Label text="New" />';
    const replacement = `>\r\n    ${fragment}\r\n  </ui:VisualElement>`;

    const transaction = insertElement(session, parent, 0, fragment);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: slash,
      end: slash + 2,
      replacement,
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, slash) + replacement + original.slice(slash + 2),
    );
  });

  it('inserts into an otherwise empty paired parent without moving its comment', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n'
      + '  <ui:VisualElement>\n'
      + '    <!-- only child trivia -->\n'
      + '  </ui:VisualElement>\n'
      + '</ui:UXML>\n';
    const session = openSession(original);
    const parent = locatorNamed(session, 'ui:VisualElement');
    const insertion = original.indexOf('\n  </ui:VisualElement>');
    const fragment = '<ui:Label />';

    const transaction = insertElement(session, parent, 0, fragment);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: insertion,
      end: insertion,
      replacement: `\n    ${fragment}`,
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, insertion) + `\n    ${fragment}` + original.slice(insertion),
    );
  });

  it('uses inner CRLF trivia when inserting into an empty first-line root', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\r\n'
      + '</ui:UXML>\r\n';
    const session = openSession(original);
    const root = session.locatorFor(session.document.root.id)!;
    const insertion = original.indexOf('\r\n');
    const fragment = '<ui:Label />';

    const transaction = insertElement(session, root, 0, fragment);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: insertion,
      end: insertion,
      replacement: `\r\n  ${fragment}`,
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      `<ui:UXML xmlns:ui="UnityEngine.UIElements">\r\n  ${fragment}\r\n</ui:UXML>\r\n`,
    );
  });

  it.each([
    ' <ui:Label />',
    '<ui:Label /><ui:Button />',
    '<ui:Label text="bad & value" />',
    '<ui:Label><ui:Button /></ui:Wrong>',
    '<?xml version="1.0"?><ui:Label />',
    '<ui:Label text="\u0000" />',
  ])('rejects an unsafe inserted fragment before producing a transaction: %j', (fragment) => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement /></ui:UXML>';
    const session = openSession(original);
    const parent = locatorNamed(session, 'ui:VisualElement');

    expect(() => insertElement(session, parent, 0, fragment)).toThrowError(
      expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-fragment' }),
    );
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });

  it('removes an exact outer element span without consuming leading comments or malformed tail text', () => {
    const original = '<?xml version="1.0"?>\r\n'
      + '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:vendor="Example">\r\n'
      + '  <ui:VisualElement>\r\n'
      + '    <ui:Label />\r\n'
      + '    <!-- keep before unsupported -->\r\n'
      + '\t<vendor:Widget><Odd-Child /></vendor:Widget>loose tail\r\n'
      + '    <ui:Button />\r\n'
      + '  </ui:VisualElement>\r\n'
      + '</ui:UXML>\r\n';
    const session = openSession(original);
    const widget = locatorNamed(session, 'vendor:Widget');
    const removalStart = original.indexOf('<vendor:Widget>');
    const removalEnd = removalStart + '<vendor:Widget><Odd-Child /></vendor:Widget>'.length;

    const transaction = removeElement(session, widget);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: removalStart,
      end: removalEnd,
      replacement: '',
    }]);
    session.history.execute(transaction);
    const result = session.snapshot().files.get(entryPath)?.text;
    expect(result).toBe(original.slice(0, removalStart) + original.slice(removalEnd));
    expect(result).toContain('<!-- keep before unsupported -->');
    expect(result).toContain('loose tail');
  });

  it('duplicates an exact subtree and synthesizes only its sibling separator', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:x="Example">\r\n'
      + '  <ui:VisualElement>\r\n'
      + '    <x:Panel name="copy">\r\n'
      + '      <!-- internal -->\r\n'
      + '      <Unknown-Control value="&amp;" />\r\n'
      + '    </x:Panel>\r\n'
      + '  </ui:VisualElement>\r\n'
      + '</ui:UXML>\r\n';
    const session = openSession(original);
    const panel = locatorNamed(session, 'x:Panel');
    const fragmentStart = original.indexOf('<x:Panel');
    const fragmentEnd = original.indexOf('</x:Panel>') + '</x:Panel>'.length;
    const fragment = original.slice(fragmentStart, fragmentEnd);

    const transaction = duplicateElement(session, panel);

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: fragmentEnd,
      end: fragmentEnd,
      replacement: `\r\n    ${fragment}`,
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, fragmentEnd) + `\r\n    ${fragment}` + original.slice(fragmentEnd),
    );
  });

  it('validates every locator field before unique-name resolution', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Button name="target" text="Go" />'
      + '</ui:UXML>';
    const session = openSession(original);
    const valid = locatorWithName(session, 'target');
    const malformed: readonly ElementLocator[] = [
      { ...valid, childPath: [-1] },
      { ...valid, qualifiedTag: 'ui:Button:Again' },
      { ...valid, ancestorTags: [null as never] },
      { ...valid, attributeHints: [{ name: 'bad name', value: 'Go' }] },
    ];

    for (const locator of malformed) {
      expect(() => setAttribute(session, locator, 'text', 'Stop')).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-locator' }),
      );
    }
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });

  it('rejects structural replacement of the UXML root', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement /></ui:UXML>';
    const session = openSession(original);
    const root = session.locatorFor(session.document.root.id)!;
    const child = locatorNamed(session, 'ui:VisualElement');
    const operations = [
      () => removeElement(session, root),
      () => duplicateElement(session, root),
      () => moveElement(session, root, child, 0),
      () => wrapElements(session, [root], 'ui:VisualElement'),
      () => renameElement(session, root, 'ui:VisualElement'),
    ];

    for (const operation of operations) {
      expect(operation).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'illegal-root' }),
      );
    }
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });

  it('snapshots caller locators and replays an identical deterministic transaction', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Button name="target" text="Go" />'
      + '</ui:UXML>';
    const session = openSession(original);
    const locator = locatorWithName(session, 'target');
    const mutable = {
      ...locator,
      childPath: [...locator.childPath],
      ancestorTags: [...locator.ancestorTags],
      attributeHints: locator.attributeHints.map((hint) => ({ ...hint })),
    };
    const transaction = setAttribute(session, mutable, 'text', 'Stop');
    const equivalent = setAttribute(openSession(original), locator, 'text', 'Stop');

    mutable.qualifiedTag = 'ui:Label';
    mutable.childPath[0] = 99;
    mutable.ancestorTags.length = 0;
    mutable.attributeHints[0].value = 'mutated';

    expect(transaction).toEqual(equivalent);
    expect(Object.isFrozen(transaction)).toBe(true);
    expect(Object.isFrozen(transaction.patchesByFile.get(entryPath))).toBe(true);
    session.history.execute(transaction);
    const edited = session.snapshot().files.get(entryPath)?.text;
    session.history.undo();
    session.history.redo();
    expect(session.snapshot().files.get(entryPath)?.text).toBe(edited);

    const replay = openSession(original);
    replay.history.replay([transaction]);
    expect(replay.snapshot()).toEqual(session.snapshot());
  });

  it('reads each caller locator path entry exactly once', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Button text="Go" />'
      + '</ui:UXML>';
    const session = openSession(original);
    const locator = locatorNamed(session, 'ui:Button');
    let reads = 0;
    const childPath: number[] = [];
    Object.defineProperty(childPath, 0, {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? locator.childPath[0] : 99;
      },
    });
    childPath.length = 1;

    const transaction = setAttribute(session, { ...locator, childPath }, 'text', 'Stop');

    expect(reads).toBe(1);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toContain('text="Stop"');
  });
});
