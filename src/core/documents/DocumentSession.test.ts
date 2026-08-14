import { describe, expect, it } from 'vitest';
import { DocumentSession, DocumentSessionError } from './DocumentSession';
import { createElementLocator, resolveElementLocator } from './ElementLocator';
import type {
  EditorDiagnostic,
  EditorElement,
  EditorNodeId,
  ParsedPreviewDocument,
  ProjectParseInput,
  UxmlPreviewPort,
} from '../adapter/types';
import type { SourcePatch } from '../commands/SourcePatch';

const entryPath = 'Assets/UI/Main.uxml';
const sheetPath = 'Assets/UI/Main.uss';

describe('DocumentSession', () => {
  it('opens exact source buffers and leaves untouched source bytes alone when committing another file', () => {
    const adapter = new TestAdapter();
    const session = DocumentSession.open(new Map([
      [entryPath, '<UXML><Button name="play" text="Play" /></UXML>\r\n'],
      [sheetPath, '.button { color: red; }\r\n'],
    ]), entryPath, adapter);
    const before = session.snapshot();

    const result = session.commit(transaction('style', 'Change style', new Map([
      [sheetPath, [{ start: 17, end: 20, replacement: 'blue' }]],
    ])));

    expect(before.files.get(entryPath)?.text).toBe('<UXML><Button name="play" text="Play" /></UXML>\r\n');
    expect(result.before.files.get(entryPath)?.text).toBe(before.files.get(entryPath)?.text);
    expect(result.after.files.get(entryPath)?.text).toBe(before.files.get(entryPath)?.text);
    expect(result.after.files.get(sheetPath)?.text).toBe('.button { color: blue; }\r\n');
    expect(adapter.inputs).toHaveLength(2);
    expect(adapter.inputs[1].uxml).toBe(before.files.get(entryPath)?.text);
  });

  it('reparses candidate buffers before publishing and keeps parse warnings as diagnostics', () => {
    const adapter = new TestAdapter();
    const session = DocumentSession.open(new Map([
      [entryPath, '<UXML><UnknownControl /></UXML>'],
      [sheetPath, '.root {}'],
    ]), entryPath, adapter);

    const result = session.commit(transaction('warn', 'Keep warning', new Map([
      [entryPath, [{ start: 6, end: 6, replacement: '<!-- warn -->' }]],
    ])));

    expect(result.document).toBe(session.document);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'unsupported-control' }),
      expect.objectContaining({ kind: 'malformed' }),
    ]));
    expect(session.diagnostics).toEqual(result.diagnostics);
  });

  it('keeps source, parsed document, selection, and history unchanged when a transaction is invalid', () => {
    const session = openFixture();
    const selected = selectNamed(session, 'target');
    const before = session.snapshot();
    const beforeDocument = session.document;
    const beforeSelection = session.selection;

    expect(() => session.history.execute(transaction('bad', 'Bad edit', new Map([
      ['Assets/UI/Missing.uss', [{ start: 0, end: 0, replacement: 'x' }]],
    ])))).toThrow(DocumentSessionError);

    expect(session.snapshot()).toEqual(before);
    expect(session.document).toBe(beforeDocument);
    expect(session.selection).toEqual(beforeSelection);
    expect(session.selectedNodeIds).toEqual([selected]);
    expect(session.history.canUndo).toBe(false);
  });

  it.each([
    ['transaction metadata', { id: '', label: 'Invalid', patchesByFile: new Map() }, 'invalid-transaction'],
    ['transaction selection', { id: 'invalid-selection', label: 'Invalid selection', patchesByFile: new Map(), selectionAfter: [null] }, 'invalid-selection'],
  ])('reports a specific public error code for invalid %s', (_label, input, code) => {
    const session = openFixture();

    try {
      session.commit(input as never);
      throw new Error('Expected commit to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentSessionError);
      expect((error as DocumentSessionError).code).toBe(code);
    }
  });

  it('does not publish a candidate when the adapter rejects it', () => {
    const session = openFixture();
    const before = session.snapshot();
    const beforeDocument = session.document;

    expect(() => session.commit(transaction('broken', 'Break parse', new Map([
      [entryPath, [{ start: 6, end: 6, replacement: '<broken />' }]],
    ])))).toThrow(/parse/i);

    expect(session.snapshot()).toEqual(before);
    expect(session.document).toBe(beforeDocument);
  });

  it('returns runtime-immutable snapshots rather than a mutable copy of its internal file map', () => {
    const session = openFixture();
    const first = session.snapshot();

    expect(() => (first.files as Map<string, unknown>).set('injected', 'bad')).toThrow();

    const second = session.snapshot();

    expect(second.files.has('injected')).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.files.get(entryPath))).toBe(true);
  });

  it('publishes a runtime-immutable parsed document through the session and commit result', () => {
    const session = DocumentSession.open(new Map([
      [entryPath, '<UXML><UnknownControl /></UXML>'],
      [sheetPath, '.root {}'],
    ]), entryPath, new TestAdapter());
    const opened = session.document;

    expect(() => (opened.source.stylesheets as Map<string, string>).set('injected.uss', 'bad')).toThrow();
    expect(() => (opened.diagnostics as EditorDiagnostic[]).push({
      origin: 'parse', severity: 'warning', kind: 'malformed', message: 'Injected.',
    })).toThrow();
    expect(() => { (opened.diagnostics[0] as { message: string }).message = 'Changed.'; }).toThrow();

    const result = session.commit(transaction('noop', 'No-op', new Map([[entryPath, []]])));
    expect(result.document).toBe(session.document);
    expect(Object.isFrozen(result.document)).toBe(true);
    expect(Object.isFrozen(result.document.source)).toBe(true);
    expect(result.document.source.stylesheets.has('injected.uss')).toBe(false);
    expect(result.document.diagnostics[0].message).toBe('Unknown control.');
  });

  it('requires the exact entry path and accepts SourceBuffer values', async () => {
    const { SourceBuffer } = await import('./SourceBuffer');
    const adapter = new TestAdapter();

    expect(() => DocumentSession.open(new Map([[sheetPath, '.a {}']]), entryPath, adapter)).toThrow(/entry/i);
    const session = DocumentSession.open(new Map([[entryPath, new SourceBuffer(entryPath, '<UXML />')]]), entryPath, adapter);
    expect(session.snapshot().files.get(entryPath)?.text).toBe('<UXML />');
  });

  it('resolves entry and nested relative stylesheet imports against deterministic project paths', () => {
    const adapter = new TestAdapter();
    DocumentSession.open(new Map([
      [entryPath, '<UXML />'],
      ['Assets/UI/styles/base.uss', '@import "../shared/colors.uss";'],
      ['Assets/UI/shared/colors.uss', '.accent { color: red; }'],
    ]), entryPath, adapter);
    const resolve = adapter.inputs[0].resolveImport;

    expect(resolve('styles/base.uss', null)).toEqual({
      path: 'Assets/UI/styles/base.uss',
      text: '@import "../shared/colors.uss";',
    });
    expect(resolve('../shared/colors.uss', 'styles/base.uss')).toEqual({
      path: 'Assets/UI/shared/colors.uss',
      text: '.accent { color: red; }',
    });
  });

  it('normalizes root-fixed, project-fixed, and Windows-style import references', () => {
    const adapter = new TestAdapter();
    DocumentSession.open(new Map([
      [entryPath, '<UXML />'],
      ['Assets/Shared/root.uss', '.root {}'],
      ['Packages/com.example/theme.uss', '.theme {}'],
      ['Assets/UI/shared/colors.uss', '.colors {}'],
    ]), entryPath, adapter);
    const resolve = adapter.inputs[0].resolveImport;

    expect(resolve('/Assets/Shared/./root.uss', null)?.path).toBe('Assets/Shared/root.uss');
    expect(resolve('project://Packages/com.example/theme.uss', null)?.path).toBe('Packages/com.example/theme.uss');
    expect(resolve('Assets/Shared/root.uss', 'styles/base.uss')?.path).toBe('Assets/Shared/root.uss');
    expect(resolve('..\\shared\\colors.uss', 'styles\\base.uss')?.path).toBe('Assets/UI/shared/colors.uss');
  });

  it('leaves escaping, absolute-drive, remote, and missing stylesheet imports unresolved', () => {
    const adapter = new TestAdapter();
    DocumentSession.open(new Map([
      [entryPath, '<UXML />'],
      ['Assets/UI/styles/base.uss', '.base {}'],
    ]), entryPath, adapter);
    const resolve = adapter.inputs[0].resolveImport;

    expect(resolve('../../../../outside.uss', 'styles/base.uss')).toBeNull();
    expect(resolve('C:\\outside.uss', null)).toBeNull();
    expect(resolve('https://example.com/remote.uss', null)).toBeNull();
    expect(resolve('styles/missing.uss', null)).toBeNull();
  });

  it('resolves a unique authored name before structural information', () => {
    const session = openFixture();
    const target = nodeNamed(session.document.root, 'target');
    const locator = createElementLocator(session.document.root, target.id)!;

    expect(locator.authoredName).toBe('target');
    expect(resolveElementLocator(session.document.root, locator)).toBe(target.id);
  });

  it('never resolves duplicate names by name alone', () => {
    const session = DocumentSession.open(new Map([[entryPath,
      '<UXML><Button name="dup" /><Button name="dup" /></UXML>',
    ]]), entryPath, new TestAdapter());
    const button = session.document.root.children[0];
    const locator = createElementLocator(session.document.root, button.id)!;

    expect(locator.authoredName).toBe('dup');
    expect(resolveElementLocator(session.document.root, {
      ...locator,
      qualifiedTag: 'NotTheSelectedTag',
      childPath: [],
      ancestorTags: [],
      attributeHints: [],
    })).toBeNull();
  });

  it('uses the structural child path to distinguish otherwise unnamed sibling elements', () => {
    const session = DocumentSession.open(new Map([[entryPath,
      '<UXML><VisualElement><Label /><Label /></VisualElement></UXML>',
    ]]), entryPath, new TestAdapter());
    const secondLabel = session.document.root.children[0].children[1];
    const locator = createElementLocator(session.document.root, secondLabel.id)!;

    expect(locator.authoredName).toBeUndefined();
    expect(resolveElementLocator(session.document.root, locator)).toBe(secondLabel.id);
  });

  it.each([
    ['renamed', 'name="target"', 'name="renamed"'],
    ['removed', ' name="target"', ''],
  ])('retains selection when an authored name is %s at the same structural path', (_label, original, replacement) => {
    const source = '<UXML><Button name="target" text="Play" /></UXML>';
    const session = DocumentSession.open(new Map([[entryPath, source]]), entryPath, new TestAdapter());
    const selected = session.document.root.children[0];
    session.setSelection([createElementLocator(session.document.root, selected.id)!]);
    const start = source.indexOf(original);

    session.commit(transaction(`name-${_label}`, `Name ${_label}`, new Map([
      [entryPath, [{ start, end: start + original.length, replacement }]],
    ])));

    expect(session.selectedNodeIds).toHaveLength(1);
    expect(nodeById(session.document.root, session.selectedNodeIds[0]).name).toBe('Button');
  });

  it.each([
    ['edited', 'text="Play"', 'text="Stop"'],
    ['removed', ' tooltip="Old"', ''],
  ])('retains an unnamed selection when an authored attribute is %s at the same structural path', (_label, original, replacement) => {
    const source = '<UXML><Button text="Play" tooltip="Old" /></UXML>';
    const session = DocumentSession.open(new Map([[entryPath, source]]), entryPath, new TestAdapter());
    const selected = session.document.root.children[0];
    session.setSelection([createElementLocator(session.document.root, selected.id)!]);
    const start = source.indexOf(original);

    session.commit(transaction(`attribute-${_label}`, `Attribute ${_label}`, new Map([
      [entryPath, [{ start, end: start + original.length, replacement }]],
    ])));

    expect(session.selectedNodeIds).toHaveLength(1);
    expect(nodeById(session.document.root, session.selectedNodeIds[0]).name).toBe('Button');
  });

  it('returns unresolved when a missing structural path falls back to indistinguishable candidates', () => {
    const session = DocumentSession.open(new Map([[entryPath,
      '<UXML><VisualElement><Label /><Label /></VisualElement></UXML>',
    ]]), entryPath, new TestAdapter());
    const locator = createElementLocator(session.document.root, session.document.root.children[0].children[1].id)!;

    expect(resolveElementLocator(session.document.root, { ...locator, childPath: [99] })).toBeNull();
  });

  it('keeps an unnamed selection attached after a differently tagged sibling is inserted before it', () => {
    const session = DocumentSession.open(new Map([[entryPath,
      '<UXML><VisualElement><Label /><Button /></VisualElement></UXML>',
    ]]), entryPath, new TestAdapter());
    const selected = session.document.root.children[0].children[1];
    session.setSelection([createElementLocator(session.document.root, selected.id)!]);
    const insertion = '<Image />';
    const offset = session.snapshot().files.get(entryPath)!.text.indexOf('<Label />');

    session.commit(transaction('insert', 'Insert image', new Map([
      [entryPath, [{ start: offset, end: offset, replacement: insertion }]],
    ])));

    expect(session.selectedNodeIds).toHaveLength(1);
    expect(nodeById(session.document.root, session.selectedNodeIds[0]).name).toBe('Button');
  });

  it('clears a removed selection and resolves unknown controls through their authored tag signature', () => {
    const session = DocumentSession.open(new Map([[entryPath,
      '<UXML><UnknownControl data-kind="custom" /></UXML>',
    ]]), entryPath, new TestAdapter());
    const unknown = session.document.root.children[0];
    const locator = createElementLocator(session.document.root, unknown.id)!;
    session.setSelection([locator]);
    const source = session.snapshot().files.get(entryPath)!.text;

    session.commit(transaction('remove', 'Remove unknown control', new Map([
      [entryPath, [{ start: source.indexOf('<UnknownControl'), end: source.indexOf('/>') + 2, replacement: '' }]],
    ])));

    expect(locator.qualifiedTag).toBe('UnknownControl');
    expect(session.selectedNodeIds).toEqual([]);
  });
});

function openFixture(): DocumentSession {
  return DocumentSession.open(new Map([
    [entryPath, '<UXML><VisualElement><Button name="target" text="Play" /></VisualElement></UXML>'],
    [sheetPath, '.button { color: red; }'],
  ]), entryPath, new TestAdapter());
}

function transaction(id: string, label: string, patchesByFile: ReadonlyMap<string, readonly SourcePatch[]>) {
  return { id, label, patchesByFile };
}

function selectNamed(session: DocumentSession, name: string): EditorNodeId {
  const node = nodeNamed(session.document.root, name);
  session.setSelection([createElementLocator(session.document.root, node.id)!]);
  return node.id;
}

function nodeNamed(root: EditorElement, name: string): EditorElement {
  const result = walk(root).find((node) => node.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name));
  if (!result) throw new Error(`Missing node named ${name}.`);
  return result;
}

function nodeById(root: EditorElement, id: EditorNodeId): EditorElement {
  const result = walk(root).find((node) => node.id === id);
  if (!result) throw new Error(`Missing node ${id}.`);
  return result;
}

function walk(root: EditorElement): EditorElement[] {
  return [root, ...root.children.flatMap(walk)];
}

class TestAdapter implements UxmlPreviewPort {
  readonly inputs: ProjectParseInput[] = [];

  parseProject(input: ProjectParseInput): ParsedPreviewDocument {
    const source = { ...input, stylesheets: new Map(input.stylesheets) };
    this.inputs.push(source);
    if (source.uxml.includes('<broken')) throw new Error('Parse failed for candidate source.');
    const root = parseElements(source.uxml, source.uxmlPath);
    const diagnostics: EditorDiagnostic[] = [];
    if (source.uxml.includes('UnknownControl')) {
      diagnostics.push({ origin: 'parse', severity: 'warning', kind: 'unsupported-control', message: 'Unknown control.' });
    }
    if (source.uxml.includes('warn')) {
      diagnostics.push({ origin: 'parse', severity: 'warning', kind: 'malformed', message: 'Warning retained.' });
    }
    return { source, root, diagnostics, originsBySheet: [] };
  }

  serializeEntry(): never { throw new Error('Not used by document tests.'); }
  render(): Promise<never> { return Promise.reject(new Error('Not used by document tests.')); }
  explain(): null { return null; }
}

function parseElements(source: string, path: string): EditorElement {
  const stack: MutableElement[] = [];
  let sequence = 0;
  let root: MutableElement | undefined;
  const tags = /<([A-Za-z_][\w:.-]*)([^>]*)>|<\/([A-Za-z_][\w:.-]*)\s*>/g;
  for (let match = tags.exec(source); match; match = tags.exec(source)) {
    if (match[3]) {
      stack.pop();
      continue;
    }
    const rawAttributes = match[2] ?? '';
    const node: MutableElement = {
      id: `node-${sequence++}` as EditorNodeId,
      name: match[1],
      source: { path, start: match.index, end: match.index + match[0].length },
      attributes: attributes(rawAttributes, path, match.index + match[1].length + 1),
      children: [],
    };
    if (stack.length === 0) root = node;
    else stack[stack.length - 1].children.push(node);
    if (!rawAttributes.trimEnd().endsWith('/')) stack.push(node);
  }
  if (!root) throw new Error('Fixture source has no root element.');
  return freezeElement(root);
}

interface MutableElement {
  id: EditorNodeId;
  name: string;
  source: { path: string; start: number; end: number };
  attributes: Array<{ name: string; value: string; source: { path: string; start: number; end: number } }>;
  children: MutableElement[];
}

function attributes(source: string, path: string, base: number) {
  return [...source.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)].map((match) => ({
    name: match[1],
    value: match[3],
    source: { path, start: base + match.index!, end: base + match.index! + match[0].length },
  }));
}

function freezeElement(node: MutableElement): EditorElement {
  return Object.freeze({
    ...node,
    source: Object.freeze(node.source),
    attributes: Object.freeze(node.attributes.map((attribute) => Object.freeze({ ...attribute, source: Object.freeze(attribute.source) }))),
    children: Object.freeze(node.children.map(freezeElement)),
  });
}
