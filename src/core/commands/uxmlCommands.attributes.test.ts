import { describe, expect, it } from 'vitest';
import {
  removeAttribute,
  setAttribute,
  UxmlCommandError,
} from './uxmlCommands';
import { readXmlAttributeLexeme } from './xmlFormatting';
import { entryPath, locatorNamed, locatorWithName, openSession } from './uxmlCommands.testUtils';

describe('UXML attribute commands', () => {
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

  it('lexes exact attribute spans with XML whitespace and one terminal matching quote', () => {
    for (const lexeme of [
      'text\u00a0=\u00a0"Go"',
      'text\f=\f"Go"',
      'text = "one"two"',
      "text = 'one'two'",
    ]) {
      expect(readXmlAttributeLexeme(lexeme, {
        path: entryPath,
        start: 0,
        end: lexeme.length,
      }), JSON.stringify(lexeme)).toBeNull();
    }

    const doubleQuoted = 'text\t=\r\n"one\'two &quot; three"';
    expect(readXmlAttributeLexeme(doubleQuoted, {
      path: entryPath,
      start: 0,
      end: doubleQuoted.length,
    })).toEqual({
      name: 'text',
      quote: '"',
      valueStart: doubleQuoted.indexOf('"') + 1,
      valueEnd: doubleQuoted.length - 1,
    });

    const singleQuoted = "text = 'one\"two &apos; three'";
    expect(readXmlAttributeLexeme(singleQuoted, {
      path: entryPath,
      start: 0,
      end: singleQuoted.length,
    })).toEqual({
      name: 'text',
      quote: "'",
      valueStart: singleQuoted.indexOf("'") + 1,
      valueEnd: singleQuoted.length - 1,
    });
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
});
