import { describe, expect, it } from 'vitest';
import { DocumentSession } from '../documents/DocumentSession';
import {
  duplicateElement,
  insertElement,
  moveElement,
  removeAttribute,
  removeElement,
  renameElement,
  setAttribute,
  UxmlCommandError,
  wrapElements,
} from './uxmlCommands';
import { entryPath, locatorNamed, locatorWithName, openSession } from './uxmlCommands.testUtils';

describe('UXML namespace and recovery safety', () => {
  it('removes namespace declarations only when no subtree QName depends on them', () => {
    const unsafe = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
        + '<ui:VisualElement name="target" xmlns:x="urn:x"><x:Widget /></ui:VisualElement>'
        + '</ui:UXML>',
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
        + '<ui:VisualElement name="target" xmlns:x="urn:x">'
        + '<ui:Label x:flag="true" />'
        + '</ui:VisualElement></ui:UXML>',
      '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:x="urn:old">'
        + '<ui:VisualElement name="target" xmlns:x="urn:new"><x:Widget /></ui:VisualElement>'
        + '</ui:UXML>',
    ];
    for (const original of unsafe) {
      const session = openSession(original);
      expect(() => removeAttribute(
        session,
        locatorWithName(session, 'target'),
        'xmlns:x',
      )).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'illegal-hierarchy' }),
      );
      expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
    }

    const unsafeDefaults = [
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
        + '<ui:VisualElement name="target" xmlns="urn:default"><Widget /></ui:VisualElement>'
        + '</ui:UXML>',
      '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
        + '<Container name="target" xmlns="urn:default" />'
        + '</ui:UXML>',
    ];
    for (const original of unsafeDefaults) {
      const session = openSession(original);
      expect(() => removeAttribute(
        session,
        locatorWithName(session, 'target'),
        'xmlns',
      )).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'illegal-hierarchy' }),
      );
    }

    const safe = [
      {
        source: '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:x="urn:x">'
          + '<ui:VisualElement name="target" xmlns:x="urn:x"><x:Widget /></ui:VisualElement>'
          + '</ui:UXML>',
        name: 'xmlns:x',
      },
      {
        source: '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
          + '<ui:VisualElement name="target" xmlns:x="urn:x">'
          + '<x:Widget xmlns:x="urn:x" />'
          + '</ui:VisualElement></ui:UXML>',
        name: 'xmlns:x',
      },
      {
        source: '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
          + '<ui:VisualElement name="target" xmlns="urn:default">'
          + '<Widget xmlns="urn:default" />'
          + '</ui:VisualElement></ui:UXML>',
        name: 'xmlns',
      },
      {
        source: '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
          + '<ui:VisualElement name="target" xmlns:unused="urn:unused" />'
          + '</ui:UXML>',
        name: 'xmlns:unused',
      },
    ] as const;
    for (const { source, name } of safe) {
      const session = openSession(source);
      const transaction = removeAttribute(session, locatorWithName(session, 'target'), name);
      session.history.execute(transaction);
      const result = session.snapshot().files.get(entryPath)?.text ?? '';
      expect(result.split(`${name}=`)).toHaveLength(source.split(`${name}=`).length - 1);
      expect(new DOMParser().parseFromString(result, 'application/xml').documentElement.localName).toBe('UXML');
    }
  });

  it('rejects insertion into a paired destination with a recovered ancestor close tag', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Label name="move" />'
      + '<ui:VisualElement name="bad"></ui:UXML>';
    const operations = [
      (session: DocumentSession) => insertElement(
        session,
        locatorWithName(session, 'bad'),
        0,
        '<ui:Button />',
      ),
      (session: DocumentSession) => moveElement(
        session,
        locatorWithName(session, 'move'),
        locatorWithName(session, 'bad'),
        0,
      ),
    ];

    for (const operation of operations) {
      const session = openSession(original);
      expect(() => operation(session)).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'ambiguous-source' }),
      );
      expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
      expect(session.history.canUndo).toBe(false);
    }
  });

  it('validates inserted fragment namespace scope and reserved prefixes', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:VisualElement name="target" xmlns:bound="urn:bound" />'
      + '</ui:UXML>';
    const session = openSession(original);
    const parent = locatorWithName(session, 'target');
    const invalid = [
      '<missing:Widget />',
      '<ui:Label missing:flag="true" />',
      '<xmlns:Widget />',
      '<ui:Label xmlns:xml="urn:not-xml" />',
      '<ui:Label xmlns:xmlns="urn:not-xmlns" />',
    ];
    const valid = [
      '<bound:Widget bound:flag="true" />',
      '<local:Widget xmlns:local="urn:local" local:flag="true" />',
      '<ui:Label xml:lang="ja" />',
      '<ui:Label xmlns:xml="http://www.w3.org/XML/1998/namespace" />',
      '<Label xmlns="urn:default" />',
    ];

    for (const fragment of invalid) {
      expect(() => insertElement(session, parent, 0, fragment), fragment).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-fragment' }),
      );
    }
    for (const fragment of valid) {
      expect(() => insertElement(session, parent, 0, fragment), fragment).not.toThrow();
    }
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });

  it('uses the complete recovered inner span for unterminated structural edits', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:VisualElement name="to" />'
      + '<ui:VisualElement name="bad">loose text';
    const fragmentStart = original.indexOf('<ui:VisualElement name="bad"');
    const fragment = original.slice(fragmentStart);

    const removeSession = openSession(original);
    const removal = removeElement(removeSession, locatorWithName(removeSession, 'bad'));
    expect(removal.patchesByFile.get(entryPath)).toEqual([{
      start: fragmentStart,
      end: original.length,
      replacement: '',
    }]);

    const duplicateSession = openSession(original);
    const duplicate = duplicateElement(duplicateSession, locatorWithName(duplicateSession, 'bad'));
    expect(duplicate.patchesByFile.get(entryPath)).toEqual([{
      start: original.length,
      end: original.length,
      replacement: fragment,
    }]);

    const moveSession = openSession(original);
    const move = moveElement(
      moveSession,
      locatorWithName(moveSession, 'bad'),
      locatorWithName(moveSession, 'to'),
      0,
    );
    const deletion = move.patchesByFile.get(entryPath)?.find((patch) => patch.replacement === '');
    const insertion = move.patchesByFile.get(entryPath)?.find((patch) => patch.replacement !== '');
    expect(deletion).toEqual({ start: fragmentStart, end: original.length, replacement: '' });
    expect(insertion?.replacement).toContain(fragment);
  });

  it('rejects structural edits when a recovered close tag belongs to an ancestor', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:VisualElement name="to" />'
      + '<ui:Button name="bad"></ui:UXML>';
    const operations = [
      (session: DocumentSession) => removeElement(session, locatorWithName(session, 'bad')),
      (session: DocumentSession) => duplicateElement(session, locatorWithName(session, 'bad')),
      (session: DocumentSession) => moveElement(
        session,
        locatorWithName(session, 'bad'),
        locatorWithName(session, 'to'),
        0,
      ),
      (session: DocumentSession) => wrapElements(
        session,
        [locatorWithName(session, 'bad')],
        'ui:VisualElement',
      ),
      (session: DocumentSession) => renameElement(
        session,
        locatorWithName(session, 'bad'),
        'ui:Label',
      ),
      (session: DocumentSession) => insertElement(
        session,
        session.locatorFor(session.document.root.id)!,
        session.document.root.children.length,
        '<ui:Label />',
      ),
    ];

    for (const operation of operations) {
      const session = openSession(original);
      expect(() => operation(session)).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'ambiguous-source' }),
      );
      expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
    }
  });

  it('rejects a recovered mismatch inside a multi-element structural selection', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Button name="bad"></ui:UXML>'
      + '<ui:Label name="next" />'
      + '<ui:VisualElement name="to" />'
      + '</ui:UXML>';
    const operations = [
      (session: DocumentSession) => moveElement(
        session,
        [locatorWithName(session, 'bad'), locatorWithName(session, 'next')],
        locatorWithName(session, 'to'),
        0,
      ),
      (session: DocumentSession) => wrapElements(
        session,
        [locatorWithName(session, 'bad'), locatorWithName(session, 'next')],
        'ui:VisualElement',
      ),
    ];

    for (const operation of operations) {
      const session = openSession(original);
      expect(() => operation(session)).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'ambiguous-source' }),
      );
      expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
    }
  });

  it('preserves namespace semantics when moving subtrees between parents', () => {
    const inherited = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:VisualElement name="from" xmlns:x="urn:source">'
      + '<x:Widget name="move" x:flag="true" />'
      + '</ui:VisualElement>'
      + '<ui:VisualElement name="to" />'
      + '</ui:UXML>';
    const rebound = inherited.replace('name="to"', 'name="to" xmlns:x="urn:other"');
    const defaultRebound = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:VisualElement name="from" xmlns="urn:source">'
      + '<Widget name="move" />'
      + '</ui:VisualElement>'
      + '<ui:VisualElement name="to" xmlns="urn:other" />'
      + '</ui:UXML>';

    for (const original of [inherited, rebound, defaultRebound]) {
      const session = openSession(original);
      expect(() => moveElement(
        session,
        locatorWithName(session, 'move'),
        locatorWithName(session, 'to'),
        0,
      )).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'illegal-hierarchy' }),
      );
      expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
    }

    const equivalent = inherited.replace('name="to"', 'name="to" xmlns:x="urn:source"');
    const equivalentSession = openSession(equivalent);
    expect(() => moveElement(
      equivalentSession,
      locatorWithName(equivalentSession, 'move'),
      locatorWithName(equivalentSession, 'to'),
      0,
    )).not.toThrow();

    const selfContained = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:VisualElement name="from" xmlns:x="urn:outer">'
      + '<x:Widget name="move" xmlns:x="urn:self" x:flag="true" />'
      + '</ui:VisualElement>'
      + '<ui:VisualElement name="to" />'
      + '</ui:UXML>';
    const selfContainedSession = openSession(selfContained);
    const transaction = moveElement(
      selfContainedSession,
      locatorWithName(selfContainedSession, 'move'),
      locatorWithName(selfContainedSession, 'to'),
      0,
    );
    selfContainedSession.history.execute(transaction);
    const result = selfContainedSession.snapshot().files.get(entryPath)?.text ?? '';
    expect(new DOMParser().parseFromString(result, 'application/xml').documentElement.localName).toBe('UXML');
  });

  it('rejects moves when any moved element QName has no usable namespace resolution', () => {
    const invalidSubtrees = [
      '<missing:Widget name="move" />',
      '<xmlns:Widget name="move" />',
      '<ui:VisualElement name="move"><missing:Child /></ui:VisualElement>',
    ];

    for (const subtree of invalidSubtrees) {
      const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
        + `<ui:VisualElement name="from">${subtree}</ui:VisualElement>`
        + '<ui:VisualElement name="to" />'
        + '</ui:UXML>';
      const session = openSession(original);

      expect(() => moveElement(
        session,
        locatorWithName(session, 'move'),
        locatorWithName(session, 'to'),
        0,
      ), subtree).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'illegal-hierarchy' }),
      );
      expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
      expect(session.history.canUndo).toBe(false);
    }
  });

  it('compares decoded namespace URIs and rejects malformed declaration references', () => {
    for (const equivalent of ['urn:a&#38;b', 'urn:a&#x26;b']) {
      const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
        + '<ui:VisualElement name="from" xmlns:x="urn:a&amp;b">'
        + '<x:Widget name="move" />'
        + '</ui:VisualElement>'
        + `<ui:VisualElement name="to" xmlns:x="${equivalent}" />`
        + '</ui:UXML>';
      const session = openSession(original);
      const transaction = moveElement(
        session,
        locatorWithName(session, 'move'),
        locatorWithName(session, 'to'),
        0,
      );

      session.history.execute(transaction);
      const result = session.snapshot().files.get(entryPath)?.text ?? '';
      expect(result).toContain('xmlns:x="urn:a&amp;b"');
      expect(result).toContain(`xmlns:x="${equivalent}"`);
      expect(result).toContain('<x:Widget name="move" />');
    }

    for (const malformed of ['urn:&unknown;', 'urn:&#0;', 'urn:&#x110000;']) {
      const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
        + `<ui:VisualElement name="target" xmlns:x="${malformed}" />`
        + '</ui:UXML>';
      const session = openSession(original);
      expect(() => insertElement(
        session,
        locatorWithName(session, 'target'),
        0,
        '<x:Widget />',
      )).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'ambiguous-source' }),
      );
      expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
    }
  });

  it('rejects namespace-dependent commands when one element repeats a declaration prefix', () => {
    const duplicateDeclarations = [
      'xmlns:x="urn:a" xmlns:x="urn:a"',
      'xmlns:x="urn:a" xmlns:x="urn:b"',
      'xmlns="urn:a" xmlns="urn:a"',
      'xmlns="urn:a" xmlns="urn:b"',
    ];
    const operations = [
      (session: DocumentSession) => insertElement(
        session,
        locatorWithName(session, 'target'),
        0,
        '<ui:Button />',
      ),
      (session: DocumentSession) => renameElement(
        session,
        locatorWithName(session, 'target'),
        'ui:Button',
      ),
      (session: DocumentSession) => wrapElements(
        session,
        [locatorWithName(session, 'target')],
        'ui:VisualElement',
      ),
      (session: DocumentSession) => setAttribute(
        session,
        locatorWithName(session, 'target'),
        'ui:flag',
        'true',
      ),
      (session: DocumentSession) => moveElement(
        session,
        locatorWithName(session, 'move'),
        locatorWithName(session, 'to'),
        1,
      ),
    ];

    for (const declarations of duplicateDeclarations) {
      const original = `<ui:UXML xmlns:ui="UnityEngine.UIElements" ${declarations}>`
        + '<ui:VisualElement name="from"><ui:Label name="move" /></ui:VisualElement>'
        + '<ui:VisualElement name="to"><ui:Label name="target" /></ui:VisualElement>'
        + '</ui:UXML>';
      for (const operation of operations) {
        const session = openSession(original);
        expect(() => operation(session), declarations).toThrowError(
          expect.objectContaining<Partial<UxmlCommandError>>({ code: 'ambiguous-source' }),
        );
        expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
        expect(session.history.canUndo).toBe(false);
      }
    }
  });

  it('renames only the qualified names in paired open and close tags', () => {
    const original = '<?xml version="1.0"?>\n'
      + '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:x="Old" xmlns:vendor="New">\n'
      + "  <x:Widget  name = 'target'>\n"
      + '    <!-- unchanged -->\n'
      + '  </x:Widget   >\n'
      + '</ui:UXML>\n';
    const session = openSession(original);
    const widget = locatorWithName(session, 'target');
    const openName = original.indexOf('x:Widget');
    const closeName = original.indexOf('x:Widget', openName + 1);

    const transaction = renameElement(session, widget, 'vendor:Renamed');

    expect(transaction.patchesByFile.get(entryPath)).toEqual([
      { start: openName, end: openName + 'x:Widget'.length, replacement: 'vendor:Renamed' },
      { start: closeName, end: closeName + 'x:Widget'.length, replacement: 'vendor:Renamed' },
    ]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, openName)
      + 'vendor:Renamed'
      + original.slice(openName + 'x:Widget'.length, closeName)
      + 'vendor:Renamed'
      + original.slice(closeName + 'x:Widget'.length),
    );
  });

  it('rejects a rename when the recovered closing QName is not an exact match', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Widget name="target"></ui:WidgetExtra>'
      + '</ui:UXML>';
    const session = openSession(original);

    expect(() => renameElement(
      session,
      locatorWithName(session, 'target'),
      'ui:Renamed',
    )).toThrowError(
      expect.objectContaining<Partial<UxmlCommandError>>({ code: 'ambiguous-source' }),
    );
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });

  it.each(['', '1name', ':name', 'name:', 'a:b:c', 'bad name'])(
    'rejects invalid XML qualified names: %j',
    (name) => {
      const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button text="Go" /></ui:UXML>';
      const session = openSession(original);
      const button = locatorNamed(session, 'ui:Button');
      const operations = [
        () => setAttribute(session, button, name, 'value'),
        () => removeAttribute(session, button, name),
        () => renameElement(session, button, name),
        () => wrapElements(session, [button], name),
      ];
      for (const operation of operations) {
        expect(operation).toThrowError(
          expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-name' }),
        );
      }
    },
  );

  it('rejects XML-valid Unicode QNames that the pinned parser cannot round-trip', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Button name="target" />'
      + '</ui:UXML>';
    const session = openSession(original);
    const target = locatorWithName(session, 'target');
    for (const operation of [
      () => setAttribute(session, target, 'données', 'value'),
      () => removeAttribute(session, target, 'données'),
      () => renameElement(session, target, 'ui:Étiquette'),
      () => wrapElements(session, [target], 'ui:Élément'),
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-name' }),
      );
    }
    expect(() => insertElement(
      session,
      session.locatorFor(session.document.root.id)!,
      1,
      '<ui:Étiquette données="value" />',
    )).toThrowError(
      expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-fragment' }),
    );
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });

  it('requires command-created QName prefixes to resolve in the local namespace scope', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:x="urn:x">'
      + '<ui:Button name="target" xmlns:local="urn:local" />'
      + '</ui:UXML>';
    const session = openSession(original);
    const target = locatorWithName(session, 'target');

    for (const operation of [
      () => setAttribute(session, target, 'missing:flag', 'true'),
      () => renameElement(session, target, 'missing:Button'),
      () => wrapElements(session, [target], 'missing:Wrapper'),
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'illegal-hierarchy' }),
      );
    }
    expect(() => setAttribute(session, target, 'xmlns:xmlns', 'urn:bad')).toThrowError(
      expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-name' }),
    );
    for (const [name, value] of [
      ['xmlns:xml', 'urn:not-xml'],
      ['xmlns:empty', ''],
      ['xmlns:x', 'http://www.w3.org/2000/xmlns/'],
    ] as const) {
      expect(() => setAttribute(session, target, name, value)).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-value' }),
      );
    }

    for (const operation of [
      () => setAttribute(session, target, 'x:flag', 'true'),
      () => setAttribute(session, target, 'xml:lang', 'ja'),
      () => setAttribute(session, target, 'xmlns:new', 'urn:new'),
      () => setAttribute(
        session,
        target,
        'xmlns:xml',
        'http://www.w3.org/XML/1998/namespace',
      ),
      () => renameElement(session, target, 'local:Button'),
      () => wrapElements(session, [target], 'x:Wrapper'),
    ]) {
      expect(operation).not.toThrow();
    }
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });
});
