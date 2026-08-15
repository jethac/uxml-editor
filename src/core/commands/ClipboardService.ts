import type { EditorElement } from '../adapter/types';
import { DocumentSession } from '../documents/DocumentSession';
import { resolveElementLocator, type ElementLocator } from '../documents/ElementLocator';
import { normalizeEditorTransaction, type EditorTransaction } from './EditorTransaction';
import { escapeXmlAttributeValue, readXmlAttributeLexeme } from './xmlFormatting';
import { insertElement } from './uxmlCommands';
import { outerEnd } from './uxmlSourceSpans';
import {
  createClipboardItem,
  decodeClipboardItem,
  UXML_FRAGMENT_MIME,
  UXML_FRAGMENT_VERSION,
  type ClipboardDiagnostic,
  type ClipboardDiagnosticCode,
  type ClipboardFragment,
  type ClipboardItemLike,
  type ClipboardNamespace,
  type UxmlClipboardPayload,
} from './clipboardPayload';

export {
  UXML_FRAGMENT_MIME,
  UXML_FRAGMENT_VERSION,
  type ClipboardBlobLike,
  type ClipboardDiagnostic,
  type ClipboardDiagnosticCode,
  type ClipboardFragment,
  type ClipboardItemLike,
  type ClipboardNamespace,
  type ClipboardStylesheet,
  type UxmlClipboardPayload,
} from './clipboardPayload';

export interface ClipboardPort {
  write(items: readonly ClipboardItemLike[]): Promise<void>;
  read(): Promise<readonly ClipboardItemLike[]>;
}

export type ClipboardCopyResult =
  | { readonly ok: true; readonly item: ClipboardItemLike; readonly payload: UxmlClipboardPayload }
  | { readonly ok: false; readonly diagnostic: ClipboardDiagnostic };

export type ClipboardPasteResult =
  | { readonly ok: true; readonly transaction: EditorTransaction }
  | { readonly ok: false; readonly diagnostic: ClipboardDiagnostic };

export class ClipboardService {
  constructor(private readonly port?: ClipboardPort) {}

  copy(session: DocumentSession, requested: readonly EditorElement[]): ClipboardCopyResult {
    if (!Array.isArray(requested) || requested.length === 0) {
      return copyFailure('AMBIGUOUS_CLIPBOARD_SOURCE', 'Copy requires at least one current source element.');
    }
    const source = session.snapshot().files.get(session.entryPath)?.text;
    if (source === undefined) {
      return copyFailure('AMBIGUOUS_CLIPBOARD_SOURCE', 'The entry source is unavailable.');
    }
    const current = requested.map((node) => findElement(session.document.root, node.id));
    if (current.some((node, index) => node === null || node !== requested[index])) {
      return copyFailure('AMBIGUOUS_CLIPBOARD_SOURCE', 'Every copied element must be from the current parsed document.');
    }
    const elements = current as EditorElement[];
    const ordered = [...elements].sort((left, right) => left.spans.openTag.start - right.spans.openTag.start);
    if (
      new Set(ordered.map((node) => node.id)).size !== ordered.length
      || ordered.some((node) => node.spans.openTag.path !== session.entryPath)
      || ordered.some((node, index) => index > 0 && node.spans.openTag.start < outerEnd(source, ordered[index - 1]))
    ) {
      return copyFailure('AMBIGUOUS_CLIPBOARD_SOURCE', 'Copied elements must be distinct non-overlapping entry-source fragments.');
    }
    try {
      const payload: UxmlClipboardPayload = Object.freeze({
        version: UXML_FRAGMENT_VERSION,
        sourcePath: session.entryPath,
        fragments: Object.freeze(ordered.map((node) => Object.freeze({
          source: source.slice(node.spans.openTag.start, outerEnd(source, node)),
          namespaces: namespaceMetadata(session.document.root, node),
        }))),
        stylesheets: Object.freeze([...session.snapshot().files]
          .filter(([path]) => path.toLowerCase().endsWith('.uss'))
          .sort(([left], [right]) => compareText(left, right))
          .map(([path, buffer]) => Object.freeze({ path, source: buffer.text }))),
      });
      const plain = payload.fragments.map((fragment) => fragment.source).join('\n');
      return Object.freeze({ ok: true, item: createClipboardItem(payload, plain), payload });
    } catch (error) {
      return copyFailure('AMBIGUOUS_CLIPBOARD_SOURCE', errorMessage(error, 'The copied source spans are not safe to read.'));
    }
  }

  async writeCopy(session: DocumentSession, requested: readonly EditorElement[]): Promise<ClipboardCopyResult> {
    const copied = this.copy(session, requested);
    if (!copied.ok || this.port === undefined) {
      return copied.ok
        ? copyFailure('CLIPBOARD_IO_FAILED', 'No clipboard write integration is available.')
        : copied;
    }
    try {
      await this.port.write([copied.item]);
      return copied;
    } catch (error) {
      return copyFailure('CLIPBOARD_IO_FAILED', errorMessage(error, 'Clipboard write failed.'));
    }
  }

  async paste(
    session: DocumentSession,
    parentLocator: ElementLocator,
    index: number,
    item: ClipboardItemLike,
  ): Promise<ClipboardPasteResult> {
    const decoded = await decodeClipboardItem(item);
    if (!decoded.ok) return decoded;
    const parentId = resolveElementLocator(session.document.root, parentLocator);
    const parent = parentId === null ? null : findElement(session.document.root, parentId);
    if (parent === null || !Number.isInteger(index) || index < 0 || index > parent.children.length) {
      return pasteFailure('AMBIGUOUS_PASTE_TARGET', 'Paste requires one current parent and a valid child index.');
    }
    try {
      const occupied = authoredNames(session.document.root);
      const fragments: string[] = [];
      for (const fragment of decoded.payload.fragments) {
        const transformed = transformFragment(session, decoded.payload, fragment, occupied);
        if (!transformed.ok) return transformed;
        fragments.push(transformed.source);
      }
      for (const fragment of fragments) insertElement(session, parentLocator, index, fragment);
      const first = insertElement(session, parentLocator, index, fragments[0]);
      const patches = first.patchesByFile.get(session.entryPath);
      if (patches === undefined || patches.length !== 1) {
        return pasteFailure('AMBIGUOUS_PASTE_TARGET', 'The paste destination has no single safe insertion boundary.');
      }
      const patch = combineFragments(patches[0], fragments);
      return Object.freeze({
        ok: true,
        transaction: normalizeEditorTransaction({
          id: 'paste-uxml-fragment',
          label: fragments.length === 1 ? 'Paste element' : `Paste ${fragments.length} elements`,
          patchesByFile: new Map([[session.entryPath, [patch]]]),
          ...(session.selection.length === 0 ? {} : { selectionAfter: session.selection }),
        }),
      });
    } catch (error) {
      return pasteFailure('INVALID_CLIPBOARD_FRAGMENT', errorMessage(error, 'The clipboard fragments are not safe UXML elements.'));
    }
  }

  async readPaste(
    session: DocumentSession,
    parentLocator: ElementLocator,
    index: number,
  ): Promise<ClipboardPasteResult> {
    if (this.port === undefined) return pasteFailure('CLIPBOARD_IO_FAILED', 'No clipboard read integration is available.');
    try {
      const items = await this.port.read();
      const item = items.find((candidate) => candidate.types.includes(UXML_FRAGMENT_MIME));
      return item === undefined
        ? pasteFailure('INVALID_CLIPBOARD_FRAGMENT', 'The clipboard has no UXML editor fragment data.')
        : this.paste(session, parentLocator, index, item);
    } catch (error) {
      return pasteFailure('CLIPBOARD_IO_FAILED', errorMessage(error, 'Clipboard read failed.'));
    }
  }

  async duplicate(session: DocumentSession, requested: readonly EditorElement[]): Promise<ClipboardPasteResult> {
    const copied = this.copy(session, requested);
    if (!copied.ok) return copied;
    const parents = requested.map((node) => parentOf(session.document.root, node));
    const parent = parents[0] ?? null;
    if (parent === null || parents.some((candidate) => candidate?.id !== parent.id)) {
      return pasteFailure('AMBIGUOUS_PASTE_TARGET', 'Duplication requires sibling elements with one source parent.');
    }
    const parentLocator = session.locatorFor(parent.id);
    const indices = requested.map((node) => parent.children.findIndex((child) => child.id === node.id));
    if (parentLocator === null || indices.some((index) => index < 0)) {
      return pasteFailure('AMBIGUOUS_PASTE_TARGET', 'The duplicate destination no longer resolves uniquely.');
    }
    return this.paste(session, parentLocator, Math.max(...indices) + 1, copied.item);
  }
}

function transformFragment(
  session: DocumentSession,
  payload: UxmlClipboardPayload,
  fragment: ClipboardFragment,
  occupied: Set<string>,
): { readonly ok: true; readonly source: string } | { readonly ok: false; readonly diagnostic: ClipboardDiagnostic } {
  try {
    const attributes = fragment.namespaces
      .map(({ name, value }) => ` ${name}="${escapeXmlAttributeValue(value, '"')}"`)
      .join('');
    const prefix = `<uxml-editor-fragment${attributes}>`;
    const wrapper = `${prefix}${fragment.source}</uxml-editor-fragment>`;
    const files = new Map<string, string>([[payload.sourcePath, wrapper]]);
    for (const stylesheet of payload.stylesheets) files.set(stylesheet.path, stylesheet.source);
    const parsed = DocumentSession.open(files, payload.sourcePath, session.adapter);
    const root = parsed.document.root;
    const child = root.children.length === 1 ? root.children[0] : null;
    if (
      child === null
      || child.spans.openTag.start !== prefix.length
      || outerEnd(wrapper, child) !== prefix.length + fragment.source.length
      || parsed.diagnostics.some((diagnostic) => diagnostic.kind === 'malformed')
    ) return pasteFailure('INVALID_CLIPBOARD_FRAGMENT', 'A clipboard fragment must be exactly one structurally valid XML element.');
    const patches: { readonly start: number; readonly end: number; readonly replacement: string }[] = [];
    for (const element of walk(child)) {
      for (const attribute of element.attributes.filter((candidate) => candidate.name === 'name')) {
        const lexeme = readXmlAttributeLexeme(wrapper, attribute.source);
        if (lexeme === null || lexeme.name !== 'name') {
          return pasteFailure('INVALID_CLIPBOARD_FRAGMENT', 'A copied name attribute has no exact quoted source boundary.');
        }
        const renamed = availableName(attribute.value, occupied);
        occupied.add(renamed);
        if (renamed !== attribute.value) {
          patches.push({
            start: lexeme.valueStart - prefix.length,
            end: lexeme.valueEnd - prefix.length,
            replacement: escapeXmlAttributeValue(renamed, lexeme.quote),
          });
        }
      }
    }
    let source = fragment.source;
    for (const patch of patches.sort((left, right) => right.start - left.start)) {
      source = source.slice(0, patch.start) + patch.replacement + source.slice(patch.end);
    }
    return Object.freeze({ ok: true, source });
  } catch (error) {
    return pasteFailure('INVALID_CLIPBOARD_FRAGMENT', errorMessage(error, 'A clipboard fragment could not be parsed structurally.'));
  }
}

function combineFragments(
  patch: { readonly start: number; readonly end: number; readonly replacement: string },
  fragments: readonly string[],
): { readonly start: number; readonly end: number; readonly replacement: string } {
  const first = fragments[0];
  const position = patch.replacement.indexOf(first);
  if (position < 0 || patch.replacement.indexOf(first, position + first.length) >= 0) {
    throw new TypeError('The planned insertion does not contain one exact fragment boundary.');
  }
  const prefix = patch.replacement.slice(0, position);
  const suffix = patch.replacement.slice(position + first.length);
  const separator = /[\t\r\n ]+$/.exec(prefix)?.[0]
    ?? /^[\t\r\n ]+/.exec(suffix)?.[0]
    ?? '';
  return Object.freeze({
    start: patch.start,
    end: patch.end,
    replacement: `${prefix}${fragments.join(separator)}${suffix}`,
  });
}

function namespaceMetadata(root: EditorElement, node: EditorElement): readonly ClipboardNamespace[] {
  const lineage = lineageTo(root, node);
  if (lineage === null) throw new TypeError('The copied node has no current ancestor lineage.');
  const bindings = new Map<string, string>();
  for (const ancestor of lineage) {
    for (const attribute of ancestor.attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
        bindings.set(attribute.name, attribute.value);
      }
    }
  }
  return Object.freeze([...bindings]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, value]) => Object.freeze({ name, value })));
}

function authoredNames(root: EditorElement): Set<string> {
  return new Set(walk(root).flatMap((node) =>
    node.attributes.filter((attribute) => attribute.name === 'name').map((attribute) => attribute.value),
  ));
}

function availableName(requested: string, occupied: ReadonlySet<string>): string {
  if (!occupied.has(requested)) return requested;
  const base = `${requested}-copy`;
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function findElement(root: EditorElement, id: EditorElement['id']): EditorElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const nested = findElement(child, id);
    if (nested !== null) return nested;
  }
  return null;
}

function parentOf(root: EditorElement, node: EditorElement): EditorElement | null {
  for (const child of root.children) {
    if (child.id === node.id) return root;
    const nested = parentOf(child, node);
    if (nested !== null) return nested;
  }
  return null;
}

function lineageTo(root: EditorElement, node: EditorElement): readonly EditorElement[] | null {
  if (root.id === node.id) return [root];
  for (const child of root.children) {
    const nested = lineageTo(child, node);
    if (nested !== null) return [root, ...nested];
  }
  return null;
}

function walk(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walk)];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyFailure(code: ClipboardDiagnosticCode, message: string): Extract<ClipboardCopyResult, { ok: false }> {
  return Object.freeze({ ok: false, diagnostic: Object.freeze({ code, message }) });
}

function pasteFailure(code: ClipboardDiagnosticCode, message: string): Extract<ClipboardPasteResult, { ok: false }> {
  return Object.freeze({ ok: false, diagnostic: Object.freeze({ code, message }) });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
