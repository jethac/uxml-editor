import packageJsonText from '../../../package.json?raw';
import packageLockText from '../../../package-lock.json?raw';
import noticesText from '../../../THIRD-PARTY-NOTICES.md?raw';
import minimalUss from '../../../tests/fixtures/minimal.uss?raw';
import uxml from '../../../tests/fixtures/minimal.uxml?raw';
import { parse as parseJavaScript } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';
import { UxmlPreviewAdapter } from './UxmlPreviewAdapter';
import type { EditorElement, ProjectParseInput } from './types';

const paletteUss = 'VisualElement { padding-left: 4px; }\n';
const sourceModules = import.meta.glob('/src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function fixtureInput(): ProjectParseInput & { readonly resolveImport: ReturnType<typeof vi.fn> } {
  const resolveImport = vi.fn(() => null);

  return {
    uxmlPath: 'Assets/UI/minimal.uxml',
    uxml,
    stylesheets: new Map([
      ['Assets/UI/styles/minimal.uss', minimalUss],
      ['/Assets/UI/styles/palette.uss', paletteUss],
    ]),
    resolveImport,
  };
}

function findNode(node: EditorElement, name: string): EditorElement | undefined {
  if (node.name === name) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child, name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function nodeByName(root: EditorElement, name: string): EditorElement {
  const node = findNode(root, name);
  expect(node, `expected ${name} in fixture`).toBeDefined();
  return node!;
}

function styleFixtureInput(): ProjectParseInput {
  return {
    uxmlPath: 'Assets/UI/styles.uxml',
    uxml: `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="styles.uss" />
  <ui:VisualElement name="parent" style="color: #123456">
    <ui:Label name="author" text="Author" />
    <ui:VisualElement name="inherited" />
    <ui:Button name="child" text="Button" style="opacity: 0.4" />
  </ui:VisualElement>
</ui:UXML>\n`,
    stylesheets: new Map([
      ['styles.uss', `Label { color: #abcdef; }
#child { width: 100px; }
#child:hover { width: 200px; }
`],
    ]),
    resolveImport: () => null,
  };
}

const deterministicMeasureText = (text: string) => ({
  width: text.length * 8,
  height: 16,
});

type AstNode = { readonly type: string; readonly [key: string]: unknown };

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function isPreviewSpecifier(value: unknown): boolean {
  return isAstNode(value) && value.type === 'StringLiteral' && value.value === 'uxml-preview';
}

function importsPreview(source: string): boolean {
  const ast = parseJavaScript(source, {
    sourceType: 'unambiguous',
    plugins: ['typescript', 'jsx'],
  });
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    if (!isAstNode(value)) {
      return false;
    }
    if (
      (value.type === 'ImportDeclaration'
        || value.type === 'ExportNamedDeclaration'
        || value.type === 'ExportAllDeclaration'
        || value.type === 'ImportExpression')
      && isPreviewSpecifier(value.source)
    ) {
      return true;
    }
    if (
      value.type === 'TSImportEqualsDeclaration'
      && isAstNode(value.moduleReference)
      && value.moduleReference.type === 'TSExternalModuleReference'
      && isPreviewSpecifier(value.moduleReference.expression)
    ) {
      return true;
    }
    if (value.type === 'TSImportType' && isPreviewSpecifier(value.source)) {
      return true;
    }
    if (
      value.type === 'CallExpression'
      && isAstNode(value.callee)
      && (value.callee.type === 'Import'
        || (value.callee.type === 'Identifier' && value.callee.name === 'require'))
      && Array.isArray(value.arguments)
      && isPreviewSpecifier(value.arguments[0])
    ) {
      return true;
    }
    return Object.values(value).some(visit);
  };

  return visit(ast.program);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('UxmlPreviewAdapter', () => {
  it('round-trips untouched UXML and every input stylesheet buffer byte-for-byte', () => {
    const adapter = new UxmlPreviewAdapter();
    const input = fixtureInput();

    const parsed = adapter.parseProject(input);

    expect(adapter.serializeEntry(parsed)).toEqual({
      uxml,
      stylesheets: input.stylesheets,
    });
    expect(parsed.originsBySheet).toEqual([
      'Assets/UI/styles/minimal.uss',
      '/Assets/UI/styles/palette.uss',
    ]);
    expect(input.resolveImport).not.toHaveBeenCalled();
  });

  it('exposes frozen editor-owned authored attribute values and source spans', () => {
    const input = styleFixtureInput();
    const parsed = new UxmlPreviewAdapter().parseProject(input);
    const button = nodeByName(parsed.root, 'ui:Button');
    const parent = nodeByName(parsed.root, 'ui:VisualElement');
    const openTag = '<ui:Button name="child" text="Button" style="opacity: 0.4" />';
    const openTagStart = input.uxml.indexOf(openTag);

    expect(button.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'name', value: 'child', source: expect.objectContaining({ path: 'Assets/UI/styles.uxml' }) }),
      expect.objectContaining({ name: 'text', value: 'Button' }),
    ]));
    expect(button.spans).toEqual({
      openTag: { path: input.uxmlPath, start: openTagStart, end: openTagStart + openTag.length },
      inner: { path: input.uxmlPath, start: openTagStart + openTag.length, end: openTagStart + openTag.length },
      closeTag: null,
    });
    const parentOpen = input.uxml.indexOf('<ui:VisualElement name="parent"');
    const parentOpenEnd = input.uxml.indexOf('>', parentOpen) + 1;
    const parentClose = input.uxml.indexOf('</ui:VisualElement>', parentOpenEnd);
    expect(parent.spans).toEqual({
      openTag: { path: input.uxmlPath, start: parentOpen, end: parentOpenEnd },
      inner: { path: input.uxmlPath, start: parentOpenEnd, end: parentClose },
      closeTag: {
        path: input.uxmlPath,
        start: parentClose,
        end: parentClose + '</ui:VisualElement>'.length,
      },
    });
    expect(Object.isFrozen(button)).toBe(true);
    expect(Object.isFrozen(button.spans)).toBe(true);
    expect(Object.isFrozen(button.spans.openTag)).toBe(true);
    expect(Object.isFrozen(button.spans.inner)).toBe(true);
    expect(Object.isFrozen(parent.spans.closeTag)).toBe(true);
    expect(Object.isFrozen(button.attributes)).toBe(true);
    expect(Object.isFrozen(button.attributes[0])).toBe(true);
    expect(Object.isFrozen(button.attributes[0].source)).toBe(true);
  });

  it('keeps parsed public state runtime-immutable without breaking identity-based serialization', () => {
    const adapter = new UxmlPreviewAdapter();
    const parsed = adapter.parseProject(fixtureInput());
    const before = adapter.serializeEntry(parsed);

    expect(() => (parsed.source.stylesheets as Map<string, string>).set('injected.uss', 'bad')).toThrow();
    expect(() => (parsed.diagnostics as Array<unknown>).push('bad')).toThrow();
    expect(() => (parsed.originsBySheet as Array<string | null>).push('bad.uss')).toThrow();
    expect(() => { (parsed.source as { uxml: string }).uxml = '<broken />'; }).toThrow();

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.source)).toBe(true);
    expect(adapter.serializeEntry(parsed)).toEqual(before);
  });

  it('uses fallback resolver sources by canonical path and preserves their exact text', () => {
    const adapter = new UxmlPreviewAdapter();
    const entryText = '@import "nested.uss";\r\nLabel { color: #010203; }\r\n';
    const nestedText = 'VisualElement { padding-left: 7px; }\r\n';
    const input: ProjectParseInput = {
      uxmlPath: 'Assets/UI/fallback.uxml',
      uxml: '<ui:UXML xmlns:ui="UnityEngine.UIElements"><Style src="external.uss" /></ui:UXML>\r\n',
      stylesheets: new Map([['Assets/UI/kept.uss', 'Button { width: 1px; }\r\n']]),
      resolveImport: (url, from) => {
        if (url === 'external.uss' && from === null) {
          return { path: 'Assets/Shared/external.uss', text: entryText };
        }
        if (url === 'nested.uss' && from === 'external.uss') {
          return { path: 'Assets/Shared/nested.uss', text: nestedText };
        }
        return null;
      },
    };

    const parsed = adapter.parseProject(input);
    const first = adapter.serializeEntry(parsed);
    const second = adapter.serializeEntry(parsed);

    expect(parsed.originsBySheet).toEqual([
      'Assets/Shared/external.uss',
      'Assets/Shared/nested.uss',
    ]);
    expect(first.stylesheets).toEqual(new Map([
      ['Assets/UI/kept.uss', 'Button { width: 1px; }\r\n'],
      ['Assets/Shared/external.uss', entryText],
      ['Assets/Shared/nested.uss', nestedText],
    ]));
    expect(second.stylesheets).toEqual(first.stylesheets);
    expect(second.stylesheets).not.toBe(first.stylesheets);
  });

  it('resolves nested relative imports by parent even when a raw stylesheet key exists', () => {
    const adapter = new UxmlPreviewAdapter();
    const resolveImport = vi.fn((url: string, from: string | null) => {
      if (url === 'shared.uss' && from === 'Assets/A/a.uss') {
        return { path: 'Assets/A/shared.uss', text: 'Label { color: red; }\n' };
      }
      if (url === 'shared.uss' && from === 'Assets/B/b.uss') {
        return { path: 'Assets/B/shared.uss', text: 'Label { color: blue; }\n' };
      }
      return null;
    });
    const parsed = adapter.parseProject({
      uxmlPath: 'Assets/UI/screen.uxml',
      uxml: `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="Assets/A/a.uss" />
  <Style src="Assets/B/b.uss" />
</ui:UXML>\n`,
      stylesheets: new Map([
        ['Assets/A/a.uss', '@import "shared.uss";\n'],
        ['Assets/B/b.uss', '@import "shared.uss";\n'],
        ['shared.uss', 'Label { color: trap; }\n'],
      ]),
      resolveImport,
    });

    expect(resolveImport).toHaveBeenCalledWith('shared.uss', 'Assets/A/a.uss');
    expect(resolveImport).toHaveBeenCalledWith('shared.uss', 'Assets/B/b.uss');
    expect(parsed.originsBySheet).toEqual([
      'Assets/A/a.uss',
      'Assets/B/b.uss',
      'Assets/A/shared.uss',
      'Assets/B/shared.uss',
    ]);
    const stylesheets = adapter.serializeEntry(parsed).stylesheets;
    expect(stylesheets.get('Assets/A/shared.uss')).toBe('Label { color: red; }\n');
    expect(stylesheets.get('Assets/B/shared.uss')).toBe('Label { color: blue; }\n');
  });

  it('deduplicates duplicate and root-fixed imports without resolving root-fixed buffers', () => {
    const adapter = new UxmlPreviewAdapter();
    const resolveImport = vi.fn((url: string, from: string | null) => {
      if (url === 'duplicate.uss' && from === 'entry.uss') {
        return { path: 'Assets/UI/duplicate.uss', text: 'Label { width: 10px; }\n' };
      }
      return null;
    });
    const parsed = adapter.parseProject({
      uxmlPath: 'Assets/UI/screen.uxml',
      uxml: '<ui:UXML xmlns:ui="UnityEngine.UIElements"><Style src="entry.uss" /></ui:UXML>\n',
      stylesheets: new Map([
        ['entry.uss', '@import "duplicate.uss";\n@import "duplicate.uss";\n@import "/root.uss";\n@import "/root.uss";\n'],
        ['/root.uss', 'Button { height: 9px; }\n'],
      ]),
      resolveImport,
    });

    expect(resolveImport).toHaveBeenCalledTimes(1);
    expect(resolveImport).toHaveBeenCalledWith('duplicate.uss', 'entry.uss');
    expect(parsed.originsBySheet).toEqual(['entry.uss', 'Assets/UI/duplicate.uss', '/root.uss']);
  });

  it('keeps root import diagnostics locationless while preserving node IDs', () => {
    const adapter = new UxmlPreviewAdapter();
    const parsed = adapter.parseProject({
      ...fixtureInput(),
      uxml: uxml.replace('Assets/UI/styles/minimal.uss', 'missing.uss'),
      stylesheets: new Map<string, string>(),
    });
    const warning = parsed.diagnostics.find((diagnostic) => diagnostic.kind === 'import-unresolved');

    expect(warning).toEqual(expect.objectContaining({
      origin: 'parse',
      nodeId: parsed.root.id,
    }));
    expect(warning).not.toHaveProperty('source');
  });

  it('maps source-referenced import warnings to their exact stylesheet span', () => {
    const adapter = new UxmlPreviewAdapter();
    const entry = '@import "missing.uss";\n';
    const parsed = adapter.parseProject({
      uxmlPath: 'Assets/UI/screen.uxml',
      uxml: '<ui:UXML xmlns:ui="UnityEngine.UIElements"><Style src="entry.uss" /></ui:UXML>\n',
      stylesheets: new Map([['entry.uss', entry]]),
      resolveImport: () => null,
    });

    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'import-unresolved',
      source: { path: 'entry.uss', start: 0, end: entry.indexOf(';') + 1 },
    }));
  });

  it('reports an unknown stylesheet property at its declaration span and leaves valid ones alone', () => {
    const adapter = new UxmlPreviewAdapter();
    const entry = 'Button {\n  -unity-bogus-property: 7px;\n  padding-left: 24px;\n  --brand: #ff0000;\n}\n';
    const parsed = adapter.parseProject({
      uxmlPath: 'Assets/UI/screen.uxml',
      uxml: '<ui:UXML xmlns:ui="UnityEngine.UIElements"><Style src="entry.uss" /></ui:UXML>\n',
      stylesheets: new Map([['entry.uss', entry]]),
      resolveImport: () => null,
    });
    const unsupported = parsed.diagnostics.filter((diagnostic) => diagnostic.kind === 'unsupported-property');

    expect(unsupported).toEqual([{
      origin: 'parse',
      severity: 'warning',
      kind: 'unsupported-property',
      message: '-unity-bogus-property is not a USS property; Unity drops the declaration',
      source: {
        path: 'entry.uss',
        start: entry.indexOf('-unity-bogus-property'),
        end: entry.indexOf('7px') + '7px'.length,
      },
    }]);
  });

  it('reports an unknown inline style property against the element that carries it', () => {
    const adapter = new UxmlPreviewAdapter();
    const uxmlSource = '<ui:UXML xmlns:ui="UnityEngine.UIElements">'
      + '<ui:Label style="colour: red; width: 20px;" />'
      + '</ui:UXML>\n';
    const parsed = adapter.parseProject({
      uxmlPath: 'Assets/UI/screen.uxml',
      uxml: uxmlSource,
      stylesheets: new Map<string, string>(),
      resolveImport: () => null,
    });
    const label = parsed.root.children[0]!;

    expect(parsed.diagnostics).toContainEqual({
      origin: 'parse',
      severity: 'warning',
      kind: 'unsupported-property',
      message: 'colour is not a USS property; Unity drops the declaration',
      nodeId: label.id,
      source: label.attributes[0]!.source,
    });
  });

  it('renders every expected fixture element with unconditional reverse lookup', async () => {
    const adapter = new UxmlPreviewAdapter();
    const parsed = adapter.parseProject(fixtureInput());
    const container = document.createElement('div');
    document.body.append(container);

    const frame = await adapter.render(parsed, container, {
      size: { width: 640, height: 480 },
      measureText: deterministicMeasureText,
    });

    for (const nodeId of [
      nodeByName(parsed.root, 'ui:VisualElement').id,
      nodeByName(parsed.root, 'ui:Label').id,
      nodeByName(parsed.root, 'ui:Button').id,
    ]) {
      const element = frame.elements.get(nodeId);
      expect(element, `expected rendered element ${nodeId}`).toBeDefined();
      expect(frame.nodeForElement(element!)).toBe(nodeId);
    }
    expect(container.textContent).toContain('Welcome');
    expect(container.textContent).toContain('Continue');

    frame.dispose();
    expect(() => frame.dispose()).not.toThrow();
    container.remove();
  });

  it('rejects a superseded render before Yoga draws and leaves the latest frame live', async () => {
    const yoga = deferred<void>();
    vi.resetModules();
    vi.doMock('uxml-preview', async (importOriginal) => {
      const actual = await importOriginal<typeof import('uxml-preview')>();
      return {
        ...actual,
        loadLayoutEngine: vi.fn(async () => {
          await yoga.promise;
          await actual.loadLayoutEngine();
        }),
      };
    });

    try {
      const { RenderSupersededError, UxmlPreviewAdapter: DelayedAdapter } = await import('./UxmlPreviewAdapter');
      const adapter = new DelayedAdapter();
      const parsed = adapter.parseProject(fixtureInput());
      const container = document.createElement('div');
      document.body.append(container);
      const options = { size: { width: 640, height: 480 }, measureText: deterministicMeasureText };

      const settled = Promise.allSettled([
        adapter.render(parsed, container, options),
        adapter.render(parsed, container, options),
      ]);
      yoga.resolve();
      const [first, latest] = await settled;

      expect(first.status).toBe('rejected');
      if (first.status === 'rejected') {
        expect(first.reason).toBeInstanceOf(RenderSupersededError);
      }
      expect(latest.status).toBe('fulfilled');
      if (latest.status === 'fulfilled') {
        const button = latest.value.elements.get(nodeByName(parsed.root, 'ui:Button').id);
        expect(button?.isConnected).toBe(true);
        latest.value.dispose();
        expect(() => latest.value.dispose()).not.toThrow();
      }
      container.remove();
    } finally {
      vi.doUnmock('uxml-preview');
      vi.resetModules();
    }
  });

  it('disposes the prior frame during a sequential rerender', async () => {
    const adapter = new UxmlPreviewAdapter();
    const parsed = adapter.parseProject(fixtureInput());
    const container = document.createElement('div');
    document.body.append(container);
    const options = { size: { width: 640, height: 480 }, measureText: deterministicMeasureText };

    const first = await adapter.render(parsed, container, options);
    const firstElement = first.elements.get(nodeByName(parsed.root, 'ui:Button').id)!;
    const second = await adapter.render(parsed, container, options);

    expect(firstElement.isConnected).toBe(false);
    second.dispose();
    container.remove();
  });

  it('explains computed author, theme, inherited, default, inline, and stateful values', () => {
    const adapter = new UxmlPreviewAdapter();
    const input = styleFixtureInput();
    const parsed = adapter.parseProject(input);
    const parent = nodeByName(parsed.root, 'ui:VisualElement');
    const authorNode = nodeByName(parsed.root, 'ui:Label');
    const inherited = parent.children.find((node) => node.name === 'ui:VisualElement');
    const child = nodeByName(parsed.root, 'ui:Button');

    expect(inherited, 'expected inherited fixture node').toBeDefined();

    const author = adapter.explain(parsed, authorNode.id, 'color');
    const theme = adapter.explain(parsed, child.id, 'margin-left');
    const inheritedColor = adapter.explain(parsed, inherited!.id, 'color');
    const fallback = adapter.explain(parsed, child.id, 'height');
    const inline = adapter.explain(parsed, child.id, 'opacity');
    const hover = adapter.explain(parsed, child.id, 'width', { states: { '#child': ['hover'] } });

    expect(author).toEqual(expect.objectContaining({
      computed: expect.objectContaining({ value: '#abcdef', origin: expect.objectContaining({ kind: 'rule' }) }),
      candidates: expect.arrayContaining([expect.objectContaining({
        rank: 'author',
        specificity: [0, 0, 1],
        winner: true,
        origin: expect.objectContaining({
          kind: 'rule',
          source: expect.objectContaining({ path: 'styles.uss' }),
        }),
      })]),
    }));
    expect(theme).toEqual(expect.objectContaining({
      computed: { value: '3px', origin: expect.objectContaining({ kind: 'builtin-theme', selector: '.unity-button' }) },
      candidates: expect.arrayContaining([expect.objectContaining({ rank: 'builtin-theme', winner: true })]),
    }));
    expect(inheritedColor).toEqual(expect.objectContaining({
      computed: expect.objectContaining({
        value: '#123456',
        origin: expect.objectContaining({ kind: 'inherited', from: parent.id }),
      }),
    }));
    expect(fallback).toEqual({
      nodeId: child.id,
      property: 'height',
      computed: { value: null, origin: { kind: 'default' } },
      candidates: [],
    });
    expect(inline).toEqual(expect.objectContaining({
      computed: expect.objectContaining({ value: '0.4', origin: expect.objectContaining({
        kind: 'inline',
        source: {
          path: 'Assets/UI/styles.uxml',
          start: input.uxml.indexOf('style="opacity: 0.4"'),
          end: input.uxml.indexOf('style="opacity: 0.4"') + 'style="opacity: 0.4"'.length,
        },
      }) }),
      candidates: expect.arrayContaining([expect.objectContaining({
        rank: 'author',
        specificity: [Number.MAX_SAFE_INTEGER, 0, 0],
        winner: true,
      })]),
    }));
    expect(hover?.candidates).toEqual([
      expect.objectContaining({ value: '100px', rank: 'author', specificity: [1, 0, 0], winner: false }),
      expect.objectContaining({
        value: '200px',
        rank: 'author',
        specificity: [1, 1, 0],
        winner: true,
        origin: expect.objectContaining({ kind: 'rule', states: ['hover'] }),
      }),
    ]);
    expect(hover!.candidates[0]!.order).toBeLessThan(hover!.candidates[1]!.order);
  });

  it('omits source fields for unmappable inline and rule origins', async () => {
    vi.resetModules();
    vi.doMock('uxml-preview', async (importOriginal) => {
      const actual = await importOriginal<typeof import('uxml-preview')>();
      return {
        ...actual,
        explainProperty: vi.fn(() => [
          {
            property: 'color',
            value: '#111111',
            origin: { kind: 'inline', node: 999, declIndex: 0 },
            rank: 1,
            specificity: [0, 0, 0],
            order: 0,
            winner: false,
          },
          {
            property: 'color',
            value: '#222222',
            origin: { kind: 'rule', sheet: 999, item: 999, declIndex: 0 },
            rank: 1,
            specificity: [0, 0, 0],
            order: 1,
            winner: true,
          },
        ]),
      };
    });

    try {
      const { UxmlPreviewAdapter: IsolatedAdapter } = await import('./UxmlPreviewAdapter');
      const adapter = new IsolatedAdapter();
      const parsed = adapter.parseProject(fixtureInput());
      const explanation = adapter.explain(parsed, parsed.root.id, 'color');

      expect(explanation?.candidates).toHaveLength(2);
      for (const candidate of explanation!.candidates) {
        expect(candidate.origin).not.toHaveProperty('source');
      }
    } finally {
      vi.doUnmock('uxml-preview');
      vi.resetModules();
    }
  });

  it('parses one target USS buffer into immutable editor-owned source metadata', () => {
    const adapter = new UxmlPreviewAdapter();
    const source = `@import "base.uss";\r\n/* keep */\r\nButton {\r\n  --gap: 2px;\r\n  margin: 1px 2px;\r\n  margin: 3px;\r\n}\r\n:nth-child(2) { color: red; }`;
    const sheet = adapter.parseStylesheet('Assets/UI/target.uss', source);
    const buttonStart = source.indexOf('Button');
    const customStart = source.indexOf('--gap');
    const firstMarginStart = source.indexOf('margin');
    const secondMarginStart = source.indexOf('margin', firstMarginStart + 1);

    expect(sheet.path).toBe('Assets/UI/target.uss');
    expect(sheet.rules).toEqual([
      {
        itemIndex: 1,
        source: { path: 'Assets/UI/target.uss', start: buttonStart, end: source.indexOf('}', buttonStart) + 1 },
        selectorSource: { path: 'Assets/UI/target.uss', start: buttonStart, end: buttonStart + 'Button'.length },
        declarations: [
          {
            declarationIndex: 0,
            property: '--gap',
            value: '2px',
            source: { path: 'Assets/UI/target.uss', start: customStart, end: customStart + '--gap: 2px'.length },
          },
          {
            declarationIndex: 1,
            property: 'margin',
            value: '1px 2px',
            source: { path: 'Assets/UI/target.uss', start: firstMarginStart, end: firstMarginStart + 'margin: 1px 2px'.length },
          },
          {
            declarationIndex: 2,
            property: 'margin',
            value: '3px',
            source: { path: 'Assets/UI/target.uss', start: secondMarginStart, end: secondMarginStart + 'margin: 3px'.length },
          },
        ],
      },
      expect.objectContaining({
        itemIndex: 2,
        selectorSource: expect.objectContaining({
          start: source.indexOf(':nth-child(2)'),
          end: source.indexOf(':nth-child(2)') + ':nth-child(2)'.length,
        }),
      }),
    ]);
    expect(Object.isFrozen(sheet)).toBe(true);
    expect(Object.isFrozen(sheet.rules)).toBe(true);
    expect(Object.isFrozen(sheet.rules[0].declarations[0].source)).toBe(true);
    expect(() => (sheet.rules as unknown[]).push({})).toThrow();
  });

  it('keeps the preview pin and detects every import form outside the adapter boundary', () => {
    const packageJson = JSON.parse(packageJsonText) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const packageLock = JSON.parse(packageLockText) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    const previewImporters = Object.entries(sourceModules)
      .filter(([, source]) => importsPreview(source))
      .map(([path]) => path.replace(/^\//, ''));

    const previewPackage = ['uxml', 'preview'].join('-');
    expect(importsPreview(`import '${previewPackage}';`)).toBe(true);
    expect(importsPreview(`const preview = import('${previewPackage}');`)).toBe(true);
    expect(importsPreview(`import { parse } from '${previewPackage}';`)).toBe(true);
    expect(importsPreview(`export { parse } from '${previewPackage}';`)).toBe(true);
    expect(importsPreview(`export * from '${previewPackage}';`)).toBe(true);
    expect(importsPreview(`import {\n  parse,\n} from '${previewPackage}'`)).toBe(true);
    expect(importsPreview(`export {\n  parse,\n} from '${previewPackage}'`)).toBe(true);
    expect(importsPreview(`import data from '${previewPackage}' with { type: 'json' }`)).toBe(true);
    expect(importsPreview(`import preview = require('${previewPackage}');`)).toBe(true);
    expect(importsPreview(`type T = import('${previewPackage}').T;`)).toBe(true);
    expect(importsPreview(`const p = require('${previewPackage}');`)).toBe(true);
    expect(importsPreview(`const p = require(packageName);`)).toBe(false);
    expect(importsPreview(`const p = require('other-package');`)).toBe(false);
    expect(importsPreview(`// import '${previewPackage}'\nconst value = '${previewPackage}';\nconst template = \`import '${previewPackage}'\`;`)).toBe(false);
    expect(packageJson.dependencies['uxml-preview']).toBe('0.4.0');
    expect(packageJson.dependencies).not.toHaveProperty('@types/node');
    expect(packageJson.devDependencies).not.toHaveProperty('@types/node');
    expect(packageLock.packages).not.toHaveProperty('node_modules/@types/node');
    expect(packageLock.packages['node_modules/uxml-preview']).toMatchObject({
      version: '0.4.0',
      integrity: 'sha512-CS26v3f85dQ5ZFbTGnoCyTtpyaD1/emDlg6/7+/G3JeGi82oghiGBxxmh5qSdJDQrzs53lKXqPhEvVc4CDQXSg==',
    });
    expect(noticesText).toContain('f358e98a805d4ae5a52fc04ff6989b3053354539');
    expect(previewImporters).toEqual(['src/core/adapter/UxmlPreviewAdapter.ts']);
  });
});
