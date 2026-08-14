import { describe, expect, it } from 'vitest';
import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import type { EditorElement } from '../adapter/types';
import { DocumentSession } from '../documents/DocumentSession';
import type { ElementLocator } from '../documents/ElementLocator';
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

const entryPath = 'Assets/UI/screen.uxml';

describe('UXML commands', () => {
  it('changes only an existing attribute value span and preserves its quote style', () => {
    const original = '<?xml version="1.0"?>\r\n'
      + '<ui:UXML xmlns:ui="UnityEngine.UIElements">\r\n'
      + "  <ui:Button text='Back &amp; forth' />\r\n"
      + '</ui:UXML>\r\n';
    const session = openSession(original);
    const button = locatorNamed(session, 'ui:Button');
    const valueStart = original.indexOf('Back &amp; forth');

    const transaction = setAttribute(session, button, 'text', 'Continue & "Next" \'now\' <');

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: valueStart,
      end: valueStart + 'Back &amp; forth'.length,
      replacement: 'Continue &amp; "Next" &apos;now&apos; &lt;',
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, valueStart)
      + 'Continue &amp; "Next" &apos;now&apos; &lt;'
      + original.slice(valueStart + 'Back &amp; forth'.length),
    );
  });

  it('inserts a new attribute without rewriting a self-closing open tag', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n'
      + '  <ui:Button text="Go" />\n'
      + '</ui:UXML>\n';
    const session = openSession(original);
    const button = locatorNamed(session, 'ui:Button');
    const insertion = original.indexOf('" />') + 1;

    const transaction = setAttribute(session, button, 'tooltip', 'Choose "Go" & \'continue\'');

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: insertion,
      end: insertion,
      replacement: ' tooltip="Choose &quot;Go&quot; &amp; \'continue\'"',
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, insertion)
      + ' tooltip="Choose &quot;Go&quot; &amp; \'continue\'"'
      + original.slice(insertion),
    );
  });

  it('matches multiline attribute spacing in a paired open tag', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\r\n'
      + '  <ui:Button\r\n'
      + "      text='Go'\r\n"
      + '    >Body</ui:Button>\r\n'
      + '</ui:UXML>\r\n';
    const session = openSession(original);
    const button = locatorNamed(session, 'ui:Button');
    const insertion = original.indexOf("'\r\n    >") + 1;

    const transaction = setAttribute(session, button, 'tooltip', 'More');

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: insertion,
      end: insertion,
      replacement: "\r\n      tooltip='More'",
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, insertion) + "\r\n      tooltip='More'" + original.slice(insertion),
    );
  });

  it('reuses delimiter spacing when a paired tag has no attributes', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Button   ></ui:Button>'
      + '</ui:UXML>';
    const session = openSession(original);
    const button = locatorNamed(session, 'ui:Button');
    const insertion = original.indexOf('   >');

    const transaction = setAttribute(session, button, 'enabled', 'true');

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: insertion,
      end: insertion,
      replacement: '   enabled="true"',
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, insertion) + '   enabled="true"' + original.slice(insertion),
    );
  });

  it('removes only an attribute and its leading separator', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">\n'
      + "  <ui:Button  name='play'\ttext = \"Go\"   class='primary' />\n"
      + '</ui:UXML>\n';
    const session = openSession(original);
    const button = locatorNamed(session, 'ui:Button');
    const removalStart = original.indexOf('\ttext');
    const removalEnd = removalStart + '\ttext = "Go"'.length;

    const transaction = removeAttribute(session, button, 'text');

    expect(transaction.patchesByFile.get(entryPath)).toEqual([{
      start: removalStart,
      end: removalEnd,
      replacement: '',
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(entryPath)?.text).toBe(
      original.slice(0, removalStart) + original.slice(removalEnd),
    );
  });

  it('does not claim non-XML whitespace as an attribute separator', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Button name="target" foo="1"\u00a0bar="2" />'
      + '</ui:UXML>';
    const session = openSession(original);

    expect(() => removeAttribute(
      session,
      locatorWithName(session, 'target'),
      'bar',
    )).toThrowError(
      expect.objectContaining<Partial<UxmlCommandError>>({ code: 'ambiguous-source' }),
    );
    expect(session.snapshot().files.get(entryPath)?.text).toBe(original);
  });

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

  it('escapes XML whitespace and rejects unrepresentable attribute values', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Button text="Go" />'
      + '</ui:UXML>';
    const session = openSession(original);
    const button = locatorNamed(session, 'ui:Button');

    const transaction = setAttribute(session, button, 'text', 'line 1\n\tline 2\r😀');
    expect(transaction.patchesByFile.get(entryPath)?.[0].replacement).toBe(
      'line 1&#xA;&#x9;line 2&#xD;😀',
    );
    for (const value of ['bad\u0000value', 'bad\uD800value']) {
      expect(() => setAttribute(session, button, 'text', value)).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-value' }),
      );
    }
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

  it('reports the owned invalid-name error for malformed runtime name values', () => {
    const session = openSession(
      '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button text="Go" /></ui:UXML>',
    );
    const button = locatorNamed(session, 'ui:Button');
    const circular: { self?: unknown } = {};
    circular.self = circular;

    for (const value of [null, circular]) {
      expect(() => setAttribute(session, button, value as never, 'value')).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'invalid-name' }),
      );
    }
  });

  it('rejects duplicate authored attributes and distinguishes unresolved locators', () => {
    const original = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Button text="First" text="Second" />'
      + '</ui:UXML>';
    const session = openSession(original);
    const button = locatorNamed(session, 'ui:Button');

    for (const operation of [
      () => setAttribute(session, button, 'text', 'Third'),
      () => removeAttribute(session, button, 'text'),
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining<Partial<UxmlCommandError>>({ code: 'ambiguous-source' }),
      );
    }
    expect(() => setAttribute(session, {
      ...button,
      authoredName: 'missing',
      childPath: [99],
      qualifiedTag: 'ui:Missing',
      attributeHints: [],
    }, 'text', 'Third')).toThrowError(
      expect.objectContaining<Partial<UxmlCommandError>>({ code: 'unresolved-locator' }),
    );
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

function openSession(uxml: string): DocumentSession {
  return DocumentSession.open(new Map([[entryPath, uxml]]), entryPath, new UxmlPreviewAdapter());
}

function locatorNamed(session: DocumentSession, qualifiedTag: string): ElementLocator {
  const element = walk(session.document.root).find((candidate) => candidate.name === qualifiedTag);
  if (!element) throw new Error(`Missing fixture element ${qualifiedTag}.`);
  const locator = session.locatorFor(element.id);
  if (!locator) throw new Error(`Missing locator for ${qualifiedTag}.`);
  return locator;
}

function locatorWithName(session: DocumentSession, authoredName: string): ElementLocator {
  const element = walk(session.document.root).find((candidate) =>
    candidate.attributes.some((attribute) => attribute.name === 'name' && attribute.value === authoredName),
  );
  if (!element) throw new Error(`Missing fixture element named ${authoredName}.`);
  const locator = session.locatorFor(element.id);
  if (!locator) throw new Error(`Missing locator for ${authoredName}.`);
  return locator;
}

function walk(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walk)];
}
