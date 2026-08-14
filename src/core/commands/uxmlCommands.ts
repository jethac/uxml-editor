import type { EditorElement } from '../adapter/types';
import type { DocumentSession } from '../documents/DocumentSession';
import { resolveElementLocator, type ElementLocator } from '../documents/ElementLocator';
import { normalizeEditorTransaction, type EditorTransaction } from './EditorTransaction';
import type { SourcePatch } from './SourcePatch';
import {
  decodeXmlAttributeValue,
  escapeXmlAttributeValue,
  isQualifiedXmlName,
  isXmlElementFragment,
  readXmlAttributeLexeme,
} from './xmlFormatting';

export type UxmlCommandErrorCode =
  | 'invalid-locator'
  | 'unresolved-locator'
  | 'invalid-name'
  | 'invalid-value'
  | 'invalid-index'
  | 'invalid-fragment'
  | 'invalid-selection'
  | 'illegal-hierarchy'
  | 'illegal-root'
  | 'ambiguous-source'
  | 'missing-attribute';

export class UxmlCommandError extends Error {
  constructor(readonly code: UxmlCommandErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UxmlCommandError';
  }
}

export function setAttribute(
  session: DocumentSession,
  locator: ElementLocator,
  name: string,
  value: string,
): EditorTransaction {
  if (typeof name !== 'string' || !isQualifiedXmlName(name)) {
    throw new UxmlCommandError('invalid-name', `${describeInvalidName(name)} is not a valid XML qualified name.`);
  }
  if (typeof value !== 'string') {
    throw new UxmlCommandError('invalid-value', 'Attribute values must be strings.');
  }

  const element = requireElement(session, locator);
  requireAttributeNamespace(session.document.root, element, name, value);
  const matches = element.attributes.filter((attribute) => attribute.name === name);
  if (matches.length === 0) {
    return insertAttribute(session, element, name, value);
  }
  if (matches.length > 1) {
    throw new UxmlCommandError('ambiguous-source', `Attribute ${name} occurs more than once on ${element.name}.`);
  }

  const source = requireEntrySource(session, matches[0].source.path);
  const lexeme = readXmlAttributeLexeme(source, matches[0].source);
  if (lexeme === null || lexeme.name !== name) {
    throw new UxmlCommandError('ambiguous-source', `The source span for attribute ${name} is not safe to edit.`);
  }
  let replacement: string;
  try {
    replacement = escapeXmlAttributeValue(value, lexeme.quote);
  } catch (error) {
    throw new UxmlCommandError('invalid-value', `Attribute ${name} contains a character XML 1.0 cannot represent.`, error);
  }

  return transaction('set-attribute', `Set ${name} attribute`, matches[0].source.path, [{
    start: lexeme.valueStart,
    end: lexeme.valueEnd,
    replacement,
  }]);
}

export function removeAttribute(
  session: DocumentSession,
  locator: ElementLocator,
  name: string,
): EditorTransaction {
  if (typeof name !== 'string' || !isQualifiedXmlName(name)) {
    throw new UxmlCommandError('invalid-name', `${describeInvalidName(name)} is not a valid XML qualified name.`);
  }
  const element = requireElement(session, locator);
  const matches = element.attributes.filter((attribute) => attribute.name === name);
  if (matches.length === 0) {
    throw new UxmlCommandError('missing-attribute', `Attribute ${name} is not authored on ${element.name}.`);
  }
  if (matches.length > 1) {
    throw new UxmlCommandError('ambiguous-source', `Attribute ${name} occurs more than once on ${element.name}.`);
  }

  const attribute = matches[0];
  if (name === 'xmlns' || name.startsWith('xmlns:')) {
    requireSafeNamespaceRemoval(session.document.root, element, name, attribute.value);
  }
  const source = requireEntrySource(session, attribute.source.path);
  const lexeme = readXmlAttributeLexeme(source, attribute.source);
  const lowerBound = element.spans.openTag.start + 1 + element.name.length;
  let start = attribute.source.start;
  while (start > lowerBound && /[\t\r\n ]/.test(source[start - 1])) start -= 1;
  if (lexeme === null || lexeme.name !== name || start === attribute.source.start) {
    throw new UxmlCommandError('ambiguous-source', `The source span for attribute ${name} is not safe to remove.`);
  }

  return transaction('remove-attribute', `Remove ${name} attribute`, attribute.source.path, [{
    start,
    end: attribute.source.end,
    replacement: '',
  }]);
}

export function insertElement(
  session: DocumentSession,
  parentLocator: ElementLocator,
  index: number,
  fragment: string,
): EditorTransaction {
  const parent = requireElement(session, parentLocator);
  if (!Number.isInteger(index) || index < 0 || index > parent.children.length) {
    throw new UxmlCommandError('invalid-index', `Child index ${index} is outside ${parent.name}.`);
  }
  const namespaceBindings = namespaceBindingsAt(session.document.root, parent);
  if (typeof fragment !== 'string' || !isXmlElementFragment(fragment, namespaceBindings)) {
    throw new UxmlCommandError('invalid-fragment', 'Inserted source must be exactly one XML element fragment.');
  }
  if (parent.spans.closeTag === null) {
    const source = requireEntrySource(session, parent.spans.openTag.path);
    const slash = parent.spans.openTag.end - 2;
    if (source.slice(slash, parent.spans.openTag.end) !== '/>') {
      throw new UxmlCommandError('ambiguous-source', `The self-closing delimiter for ${parent.name} is not safe to edit.`);
    }
    const { newline, parentIndent, childIndent } = childFormatting(
      source,
      session.document.root,
      parent,
    );
    const inner = newline.length === 0
      ? `${fragment}</${parent.name}>`
      : `${newline}${childIndent}${fragment}${newline}${parentIndent}</${parent.name}>`;
    return transaction('insert-element', `Insert element in ${parent.name}`, parent.spans.openTag.path, [{
      start: slash,
      end: parent.spans.openTag.end,
      replacement: `>${inner}`,
    }]);
  }

  const source = requireEntrySource(session, parent.spans.openTag.path);
  const current = parent.children[index];
  if (current !== undefined) {
    const lowerBound = index === 0
      ? parent.spans.openTag.end
      : outerEnd(source, parent.children[index - 1]);
    const insertion = current.spans.openTag.start;
    const separator = trailingXmlWhitespace(source.slice(lowerBound, insertion));
    return transaction('insert-element', `Insert element in ${parent.name}`, parent.spans.openTag.path, [{
      start: insertion,
      end: insertion,
      replacement: `${fragment}${separator}`,
    }]);
  }

  const previous = parent.children[index - 1];
  if (previous === undefined) {
    const tail = trailingXmlWhitespace(source.slice(parent.spans.inner.start, parent.spans.inner.end));
    const insertion = parent.spans.inner.end - tail.length;
    const { newline, childIndent } = childFormatting(source, session.document.root, parent);
    const prefix = newline.length === 0 ? '' : `${newline}${childIndent}`;
    return transaction('insert-element', `Insert element in ${parent.name}`, parent.spans.openTag.path, [{
      start: insertion,
      end: insertion,
      replacement: `${prefix}${fragment}`,
    }]);
  }
  const previousLowerBound = index === 1
    ? parent.spans.openTag.end
    : outerEnd(source, parent.children[index - 2]);
  const separator = trailingXmlWhitespace(
    source.slice(previousLowerBound, previous.spans.openTag.start),
  );
  const insertion = outerEnd(source, previous);
  return transaction('insert-element', `Insert element in ${parent.name}`, parent.spans.openTag.path, [{
    start: insertion,
    end: insertion,
    replacement: `${separator}${fragment}`,
  }]);
}

export function removeElement(
  session: DocumentSession,
  locator: ElementLocator,
): EditorTransaction {
  const element = requireElement(session, locator);
  const parent = parentOf(session.document.root, element);
  if (parent === null) {
    throw new UxmlCommandError('illegal-root', 'The UXML root element cannot be removed.');
  }
  const source = requireEntrySource(session, element.spans.openTag.path);
  const index = parent.children.findIndex((child) => child.id === element.id);
  if (index < 0) {
    throw new UxmlCommandError('ambiguous-source', `${element.name} is not present in its resolved parent.`);
  }
  const outerStart = element.spans.openTag.start;
  const end = outerEnd(source, element);
  const lowerBound = index === 0
    ? parent.spans.inner.start
    : outerEnd(source, parent.children[index - 1]);
  const leadingGap = source.slice(lowerBound, outerStart);
  const start = /^[\t\r\n ]+$/.test(leadingGap) ? lowerBound : outerStart;
  if (
    source.slice(outerStart, outerStart + element.name.length + 1) !== `<${element.name}`
    || end > parent.spans.inner.end
  ) {
    throw new UxmlCommandError('ambiguous-source', `The outer source span for ${element.name} is not safe to remove.`);
  }

  return transaction('remove-element', `Remove ${element.name}`, element.spans.openTag.path, [{
    start,
    end,
    replacement: '',
  }]);
}

export function duplicateElement(
  session: DocumentSession,
  locator: ElementLocator,
): EditorTransaction {
  const element = requireElement(session, locator);
  const parent = parentOf(session.document.root, element);
  if (parent === null) {
    throw new UxmlCommandError('illegal-root', 'The UXML root element cannot be duplicated.');
  }
  const source = requireEntrySource(session, element.spans.openTag.path);
  const index = parent.children.findIndex((child) => child.id === element.id);
  if (index < 0) {
    throw new UxmlCommandError('ambiguous-source', `${element.name} is not present in its resolved parent.`);
  }
  const start = element.spans.openTag.start;
  const end = outerEnd(source, element);
  const fragment = source.slice(start, end);
  const next = parent.children[index + 1];
  if (next !== undefined) {
    const insertion = next.spans.openTag.start;
    const separator = trailingXmlWhitespace(source.slice(end, insertion));
    return transaction('duplicate-element', `Duplicate ${element.name}`, element.spans.openTag.path, [{
      start: insertion,
      end: insertion,
      replacement: `${fragment}${separator}`,
    }]);
  }

  const lowerBound = index === 0
    ? parent.spans.inner.start
    : outerEnd(source, parent.children[index - 1]);
  const separator = trailingXmlWhitespace(source.slice(lowerBound, start));
  return transaction('duplicate-element', `Duplicate ${element.name}`, element.spans.openTag.path, [{
    start: end,
    end,
    replacement: `${separator}${fragment}`,
  }]);
}

export function moveElement(
  session: DocumentSession,
  locator: ElementLocator,
  destinationLocator: ElementLocator,
  index: number,
): EditorTransaction;
export function moveElement(
  session: DocumentSession,
  locators: readonly ElementLocator[],
  destinationLocator: ElementLocator,
  index: number,
): EditorTransaction;
export function moveElement(
  session: DocumentSession,
  locatorOrLocators: ElementLocator | readonly ElementLocator[],
  destinationLocator: ElementLocator,
  index: number,
): EditorTransaction {
  const requested = Array.isArray(locatorOrLocators)
    ? [...locatorOrLocators]
    : [locatorOrLocators as ElementLocator];
  if (requested.length === 0) {
    throw new UxmlCommandError('invalid-selection', 'Moving requires at least one element locator.');
  }
  const requestedElements = requested.map((locator) => requireElement(session, locator));
  if (new Set(requestedElements.map((element) => element.id)).size !== requestedElements.length) {
    throw new UxmlCommandError('invalid-selection', 'Moving the same element more than once is ambiguous.');
  }
  const destination = requireElement(session, destinationLocator);
  const sourceParent = parentOf(session.document.root, requestedElements[0]);
  if (sourceParent === null) {
    throw new UxmlCommandError('illegal-root', 'The UXML root element cannot be moved.');
  }
  if (requestedElements.some((element) => parentOf(session.document.root, element)?.id !== sourceParent.id)) {
    throw new UxmlCommandError('invalid-selection', 'Moved elements must share one direct parent.');
  }
  const located = requestedElements
    .map((element) => ({
      element,
      index: sourceParent.children.findIndex((child) => child.id === element.id),
    }))
    .sort((left, right) => left.index - right.index);
  if (located.some((item, position) =>
    item.index < 0 || (position > 0 && item.index !== located[position - 1].index + 1),
  )) {
    throw new UxmlCommandError('invalid-selection', 'Moved elements must be contiguous siblings.');
  }
  const elements = located.map((item) => item.element);
  const sameParent = sourceParent.id === destination.id;
  if (elements.some((element) => containsElement(element, destination))) {
    throw new UxmlCommandError('illegal-hierarchy', 'An element cannot be moved into itself or its descendant.');
  }
  const movingIds = new Set(elements.map((element) => element.id));
  const destinationChildren = sameParent
    ? destination.children.filter((child) => !movingIds.has(child.id))
    : destination.children;
  if (!Number.isInteger(index) || index < 0 || index > destinationChildren.length) {
    throw new UxmlCommandError('invalid-index', `Child index ${index} is outside ${destination.name}.`);
  }
  if (sameParent && located[0].index === index) {
    throw new UxmlCommandError('illegal-hierarchy', `The moved selection is already at child index ${index}.`);
  }
  const sourceBindings = namespaceBindingsAt(session.document.root, sourceParent);
  const destinationBindings = namespaceBindingsAt(session.document.root, destination);
  if (elements.some((element) =>
    !preservesNamespaceSemantics(element, sourceBindings, destinationBindings),
  )) {
    throw new UxmlCommandError(
      'illegal-hierarchy',
      'The move would lose or change a namespace binding used by the moved selection.',
    );
  }
  const path = elements[0].spans.openTag.path;
  const source = requireEntrySource(session, path);
  if (destination.spans.openTag.path !== path || elements.some((element) => element.spans.openTag.path !== path)) {
    throw new UxmlCommandError('ambiguous-source', 'Move source and destination must share the entry source.');
  }
  elements.forEach((element) => exactClosingNameSpan(source, element));
  const start = elements[0].spans.openTag.start;
  const end = outerEnd(source, elements[elements.length - 1]);
  const fragment = source.slice(start, end);
  let insertion: SourcePatch;
  if (destination.spans.closeTag === null) {
    const slash = destination.spans.openTag.end - 2;
    if (source.slice(slash, destination.spans.openTag.end) !== '/>') {
      throw new UxmlCommandError('ambiguous-source', `The self-closing delimiter for ${destination.name} is not safe to edit.`);
    }
    const { newline, parentIndent, childIndent } = childFormatting(
      source,
      session.document.root,
      destination,
    );
    const inner = newline.length === 0
      ? `${fragment}</${destination.name}>`
      : `${newline}${childIndent}${fragment}${newline}${parentIndent}</${destination.name}>`;
    insertion = Object.freeze({
      start: slash,
      end: destination.spans.openTag.end,
      replacement: `>${inner}`,
    });
  } else {
    insertion = insertionPatch(session, source, destination, index, fragment, destinationChildren);
  }
  const patches: SourcePatch[] = [
    { start, end, replacement: '' },
    insertion,
  ];
  patches.sort((left, right) => left.start - right.start);
  const label = elements.length === 1 ? `Move ${elements[0].name}` : `Move ${elements.length} elements`;
  return transaction('move-element', label, path, patches);
}

export function wrapElements(
  session: DocumentSession,
  locators: readonly ElementLocator[],
  wrapperName: string,
): EditorTransaction {
  if (typeof wrapperName !== 'string' || !isQualifiedXmlName(wrapperName)) {
    throw new UxmlCommandError('invalid-name', `${describeInvalidName(wrapperName)} is not a valid XML qualified name.`);
  }
  if (!Array.isArray(locators) || locators.length === 0) {
    throw new UxmlCommandError('invalid-selection', 'Wrapping requires at least one element locator.');
  }
  const elements = locators.map((locator) => requireElement(session, locator));
  if (new Set(elements.map((element) => element.id)).size !== elements.length) {
    throw new UxmlCommandError('invalid-selection', 'Wrapping the same element more than once is ambiguous.');
  }
  const parent = parentOf(session.document.root, elements[0]);
  if (parent === null) {
    throw new UxmlCommandError('illegal-root', 'The UXML root element cannot be wrapped.');
  }
  if (elements.some((element) => parentOf(session.document.root, element)?.id !== parent.id)) {
    throw new UxmlCommandError('invalid-selection', 'Wrapped elements must share one direct parent.');
  }
  const indices = elements
    .map((element) => parent.children.findIndex((child) => child.id === element.id))
    .sort((left, right) => left - right);
  if (indices.some((value, position) => value < 0 || (position > 0 && value !== indices[position - 1] + 1))) {
    throw new UxmlCommandError('invalid-selection', 'Wrapped elements must be contiguous siblings.');
  }

  const first = parent.children[indices[0]];
  const last = parent.children[indices[indices.length - 1]];
  requireBoundQName(session.document.root, parent, wrapperName, false);
  const path = first.spans.openTag.path;
  const source = requireEntrySource(session, path);
  if (last.spans.openTag.path !== path) {
    throw new UxmlCommandError('ambiguous-source', 'Wrapped elements must share one source buffer.');
  }
  elements.forEach((element) => exactClosingNameSpan(source, element));
  const start = first.spans.openTag.start;
  const end = outerEnd(source, last);
  const { newline, parentIndent } = childFormatting(source, session.document.root, parent);
  const wrapperIndent = lineIndentAt(source, start);
  const observedUnit = wrapperIndent.startsWith(parentIndent)
    ? wrapperIndent.slice(parentIndent.length)
    : '';
  const unit = observedUnit.length > 0 ? observedUnit : wrapperIndent.includes('\t') ? '\t' : '  ';
  const before = newline.length === 0
    ? `<${wrapperName}>`
    : `<${wrapperName}>${newline}${wrapperIndent}${unit}`;
  const after = newline.length === 0
    ? `</${wrapperName}>`
    : `${newline}${wrapperIndent}</${wrapperName}>`;

  return transaction('wrap-elements', `Wrap in ${wrapperName}`, path, [
    { start, end: start, replacement: before },
    { start: end, end, replacement: after },
  ]);
}

export function renameElement(
  session: DocumentSession,
  locator: ElementLocator,
  qualifiedName: string,
): EditorTransaction {
  if (typeof qualifiedName !== 'string' || !isQualifiedXmlName(qualifiedName)) {
    throw new UxmlCommandError('invalid-name', `${describeInvalidName(qualifiedName)} is not a valid XML qualified name.`);
  }
  const element = requireElement(session, locator);
  if (parentOf(session.document.root, element) === null) {
    throw new UxmlCommandError('illegal-root', 'The UXML root element cannot be renamed.');
  }
  requireBoundQName(session.document.root, element, qualifiedName, false);
  const path = element.spans.openTag.path;
  const source = requireEntrySource(session, path);
  const openStart = element.spans.openTag.start + 1;
  const patches: SourcePatch[] = [];
  if (source.slice(openStart, openStart + element.name.length) !== element.name) {
    throw new UxmlCommandError('ambiguous-source', `The opening name for ${element.name} is not safe to edit.`);
  }
  patches.push({ start: openStart, end: openStart + element.name.length, replacement: qualifiedName });

  const closeName = exactClosingNameSpan(source, element);
  if (closeName !== null) {
    patches.push({ start: closeName.start, end: closeName.end, replacement: qualifiedName });
  }

  return transaction('rename-element', `Rename ${element.name}`, path, patches);
}

function insertAttribute(
  session: DocumentSession,
  element: EditorElement,
  name: string,
  value: string,
): EditorTransaction {
  const source = requireEntrySource(session, element.spans.openTag.path);
  const openTag = element.spans.openTag;
  const authored = [...element.attributes].sort((left, right) => left.source.start - right.source.start);
  const last = authored[authored.length - 1];
  const nameEnd = openTag.start + 1 + element.name.length;
  const insertion = last?.source.end ?? nameEnd;
  if (
    source.slice(openTag.start, nameEnd) !== `<${element.name}`
    || !/^[\t\r\n ]*\/?>$/.test(source.slice(insertion, openTag.end))
  ) {
    throw new UxmlCommandError('ambiguous-source', `The open tag for ${element.name} is not safe to extend.`);
  }

  const quote = last === undefined
    ? '"'
    : readXmlAttributeLexeme(source, last.source)?.quote;
  if (quote === undefined) {
    throw new UxmlCommandError('ambiguous-source', `The final attribute on ${element.name} is not safe to extend.`);
  }
  const observedSeparator = last === undefined
    ? /^[\t\r\n ]*/.exec(source.slice(nameEnd, openTag.end))?.[0] ?? ''
    : source.slice(
      authored.length === 1 ? nameEnd : authored[authored.length - 2].source.end,
      last.source.start,
    );
  const separator = /^[\t\r\n ]+$/.test(observedSeparator) ? observedSeparator : ' ';
  let escaped: string;
  try {
    escaped = escapeXmlAttributeValue(value, quote);
  } catch (error) {
    throw new UxmlCommandError('invalid-value', `Attribute ${name} contains a character XML 1.0 cannot represent.`, error);
  }

  return transaction('set-attribute', `Set ${name} attribute`, openTag.path, [{
    start: insertion,
    end: insertion,
    replacement: `${separator}${name}=${quote}${escaped}${quote}`,
  }]);
}

function requireElement(session: DocumentSession, locator: ElementLocator): EditorElement {
  let nodeId;
  try {
    nodeId = resolveElementLocator(session.document.root, snapshotLocator(locator));
  } catch (error) {
    if (error instanceof UxmlCommandError) throw error;
    throw new UxmlCommandError('invalid-locator', 'The element locator could not be read.', error);
  }
  if (nodeId === null) {
    throw new UxmlCommandError('unresolved-locator', 'The element locator does not resolve uniquely in this session.');
  }
  const element = walk(session.document.root).find((candidate) => candidate.id === nodeId);
  if (!element) {
    throw new UxmlCommandError('unresolved-locator', 'The resolved element is absent from this session.');
  }
  return element;
}

function snapshotLocator(candidate: ElementLocator): ElementLocator {
  try {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new TypeError('Locator must be an object.');
    }
    const { authoredName, childPath, qualifiedTag, ancestorTags, attributeHints } = candidate;
    if (authoredName !== undefined && typeof authoredName !== 'string') {
      throw new TypeError('authoredName must be a string.');
    }
    if (typeof qualifiedTag !== 'string' || !isQualifiedXmlName(qualifiedTag)) {
      throw new TypeError('qualifiedTag must be an XML qualified name.');
    }
    if (!Array.isArray(childPath)) {
      throw new TypeError('childPath must contain nonnegative integers.');
    }
    const copiedChildPath = Array.from(childPath);
    if (copiedChildPath.some((part) => !Number.isInteger(part) || part < 0)) {
      throw new TypeError('childPath must contain nonnegative integers.');
    }
    if (!Array.isArray(ancestorTags)) {
      throw new TypeError('ancestorTags must contain XML qualified names.');
    }
    const copiedAncestorTags = Array.from(ancestorTags);
    if (copiedAncestorTags.some((tag) =>
      typeof tag !== 'string' || !isQualifiedXmlName(tag),
    )) {
      throw new TypeError('ancestorTags must contain XML qualified names.');
    }
    if (!Array.isArray(attributeHints)) {
      throw new TypeError('attributeHints must be an array.');
    }
    const hints = Array.from(attributeHints).map((hint) => {
      if (typeof hint !== 'object' || hint === null) throw new TypeError('Attribute hint must be an object.');
      const { name, value } = hint;
      if (typeof name !== 'string' || !isQualifiedXmlName(name) || typeof value !== 'string') {
        throw new TypeError('Attribute hint must have an XML name and string value.');
      }
      return Object.freeze({ name, value });
    });
    return Object.freeze({
      qualifiedTag,
      childPath: Object.freeze(copiedChildPath),
      ancestorTags: Object.freeze(copiedAncestorTags),
      attributeHints: Object.freeze(hints),
      ...(authoredName === undefined ? {} : { authoredName }),
    });
  } catch (error) {
    throw new UxmlCommandError('invalid-locator', 'The element locator is malformed.', error);
  }
}

function requireEntrySource(session: DocumentSession, path: string): string {
  const buffer = session.snapshot().files.get(path);
  if (!buffer || path !== session.entryPath) {
    throw new UxmlCommandError('ambiguous-source', `Element source ${path} is not the session entry source.`);
  }
  return buffer.text;
}

function walk(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walk)];
}

function namespaceBindingsAt(root: EditorElement, target: EditorElement): ReadonlyMap<string, string> {
  const lineage = lineageTo(root, target);
  if (lineage === null) {
    throw new UxmlCommandError('ambiguous-source', `${target.name} is absent from the document tree.`);
  }
  let bindings = new Map<string, string>([
    ['xml', 'http://www.w3.org/XML/1998/namespace'],
  ]);
  for (const element of lineage) {
    const scoped = withNamespaceDeclarations(bindings, element);
    if (scoped === null) {
      throw new UxmlCommandError(
        'ambiguous-source',
        `The namespace declarations in scope for ${target.name} are not safe to interpret.`,
      );
    }
    bindings = scoped;
  }
  return bindings;
}

function namespaceBindingsBefore(root: EditorElement, target: EditorElement): ReadonlyMap<string, string> {
  const lineage = lineageTo(root, target);
  if (lineage === null) {
    throw new UxmlCommandError('ambiguous-source', `${target.name} is absent from the document tree.`);
  }
  let bindings = new Map<string, string>([
    ['xml', 'http://www.w3.org/XML/1998/namespace'],
  ]);
  for (const element of lineage.slice(0, -1)) {
    const scoped = withNamespaceDeclarations(bindings, element);
    if (scoped === null) {
      throw new UxmlCommandError(
        'ambiguous-source',
        `The namespace declarations above ${target.name} are not safe to interpret.`,
      );
    }
    bindings = scoped;
  }
  return bindings;
}

function requireSafeNamespaceRemoval(
  root: EditorElement,
  element: EditorElement,
  attributeName: string,
  authoredValue: string,
): void {
  const prefix = attributeName === 'xmlns' ? '' : attributeName.slice('xmlns:'.length);
  const removedUri = decodeXmlAttributeValue(authoredValue);
  if (removedUri === null || !isUsableNamespaceBinding(prefix, removedUri)) {
    throw new UxmlCommandError(
      'ambiguous-source',
      `Namespace declaration ${attributeName} is not safe to interpret.`,
    );
  }
  const inherited = namespaceBindingsBefore(root, element);
  const inheritedUri = prefix.length === 0 ? inherited.get(prefix) ?? '' : inherited.get(prefix);
  if (inheritedUri === removedUri) return;
  if (subtreeDependsOnNamespace(element, prefix, true)) {
    throw new UxmlCommandError(
      'illegal-hierarchy',
      `Removing ${attributeName} would change or unbind a QName in ${element.name}.`,
    );
  }
}

function subtreeDependsOnNamespace(
  element: EditorElement,
  prefix: string,
  declarationOwner: boolean,
): boolean {
  if (!declarationOwner) {
    const declarationName = prefix.length === 0 ? 'xmlns' : `xmlns:${prefix}`;
    const overrides = element.attributes.filter((attribute) => attribute.name === declarationName);
    if (overrides.length > 1) {
      throw new UxmlCommandError('ambiguous-source', `${declarationName} occurs more than once on ${element.name}.`);
    }
    if (overrides.length === 1) {
      const overrideUri = decodeXmlAttributeValue(overrides[0].value);
      if (overrideUri === null || !isUsableNamespaceBinding(prefix, overrideUri)) {
        throw new UxmlCommandError(
          'ambiguous-source',
          `Nested namespace declaration ${declarationName} is not safe to interpret.`,
        );
      }
      return false;
    }
  }

  if (qNameUsesNamespacePrefix(element.name, prefix, false)) return true;
  if (element.attributes.some((attribute) =>
    attribute.name !== 'xmlns'
    && !attribute.name.startsWith('xmlns:')
    && qNameUsesNamespacePrefix(attribute.name, prefix, true),
  )) {
    return true;
  }
  return element.children.some((child) => subtreeDependsOnNamespace(child, prefix, false));
}

function qNameUsesNamespacePrefix(name: string, prefix: string, attribute: boolean): boolean {
  const colon = name.indexOf(':');
  if (prefix.length === 0) return !attribute && colon < 0;
  return colon === prefix.length && name.slice(0, colon) === prefix;
}

function isUsableNamespaceBinding(prefix: string, uri: string): boolean {
  if (prefix === 'xmlns') return false;
  if (prefix === 'xml') return uri === 'http://www.w3.org/XML/1998/namespace';
  if (prefix.length === 0) return !isReservedNamespaceUri(uri);
  return uri.length > 0 && !isReservedNamespaceUri(uri);
}

function requireAttributeNamespace(
  root: EditorElement,
  element: EditorElement,
  name: string,
  value: string,
): void {
  if (name === 'xmlns') {
    if (isReservedNamespaceUri(value)) {
      throw new UxmlCommandError('invalid-value', 'The default namespace cannot use a reserved namespace URI.');
    }
    return;
  }
  if (name.startsWith('xmlns:')) {
    const prefix = name.slice('xmlns:'.length);
    if (prefix === 'xmlns') {
      throw new UxmlCommandError('invalid-name', 'The xmlns prefix cannot itself be declared.');
    }
    if (prefix === 'xml') {
      if (value !== 'http://www.w3.org/XML/1998/namespace') {
        throw new UxmlCommandError('invalid-value', 'The xml prefix must use the XML namespace URI.');
      }
      return;
    }
    if (value.length === 0 || isReservedNamespaceUri(value)) {
      throw new UxmlCommandError(
        'invalid-value',
        `Namespace prefix ${prefix} requires a non-reserved, non-empty namespace URI.`,
      );
    }
    return;
  }
  requireBoundQName(root, element, name, true);
}

function requireBoundQName(
  root: EditorElement,
  context: EditorElement,
  qualifiedName: string,
  attribute: boolean,
): void {
  const bindings = namespaceBindingsAt(root, context);
  if (resolvedNamespace(qualifiedName, attribute, bindings) === null) {
    throw new UxmlCommandError(
      'illegal-hierarchy',
      `Namespace prefix in ${qualifiedName} is not bound at ${context.name}.`,
    );
  }
}

function preservesNamespaceSemantics(
  element: EditorElement,
  sourceBindings: ReadonlyMap<string, string>,
  destinationBindings: ReadonlyMap<string, string>,
): boolean {
  const sourceScope = withNamespaceDeclarations(sourceBindings, element);
  const destinationScope = withNamespaceDeclarations(destinationBindings, element);
  if (sourceScope === null || destinationScope === null) return false;
  if (resolvedNamespace(element.name, false, sourceScope)
    !== resolvedNamespace(element.name, false, destinationScope)) {
    return false;
  }
  for (const attribute of element.attributes) {
    if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) continue;
    const sourceNamespace = resolvedNamespace(attribute.name, true, sourceScope);
    const destinationNamespace = resolvedNamespace(attribute.name, true, destinationScope);
    if (sourceNamespace === null || sourceNamespace !== destinationNamespace) return false;
  }
  return element.children.every((child) =>
    preservesNamespaceSemantics(child, sourceScope, destinationScope),
  );
}

function withNamespaceDeclarations(
  inherited: ReadonlyMap<string, string>,
  element: EditorElement,
): Map<string, string> | null {
  const scoped = new Map(inherited);
  for (const attribute of element.attributes) {
    const namespaceUri = attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')
      ? decodeXmlAttributeValue(attribute.value)
      : null;
    if (attribute.name === 'xmlns') {
      if (namespaceUri === null || isReservedNamespaceUri(namespaceUri)) return null;
      scoped.set('', namespaceUri);
      continue;
    }
    if (!attribute.name.startsWith('xmlns:')) continue;
    if (namespaceUri === null) return null;
    const prefix = attribute.name.slice('xmlns:'.length);
    if (!isQualifiedXmlName(prefix) || prefix.includes(':') || prefix === 'xmlns') return null;
    if (prefix === 'xml') {
      if (namespaceUri !== 'http://www.w3.org/XML/1998/namespace') return null;
    } else if (namespaceUri.length === 0 || isReservedNamespaceUri(namespaceUri)) {
      return null;
    }
    scoped.set(prefix, namespaceUri);
  }
  return scoped;
}

function resolvedNamespace(
  qualifiedName: string,
  attribute: boolean,
  bindings: ReadonlyMap<string, string>,
): string | null {
  if (!isQualifiedXmlName(qualifiedName)) return null;
  const colon = qualifiedName.indexOf(':');
  if (colon < 0) return attribute ? '' : bindings.get('') ?? '';
  const prefix = qualifiedName.slice(0, colon);
  if (prefix === 'xmlns') return null;
  return bindings.get(prefix) ?? null;
}

function isReservedNamespaceUri(value: string): boolean {
  return value === 'http://www.w3.org/XML/1998/namespace'
    || value === 'http://www.w3.org/2000/xmlns/';
}

function lineageTo(root: EditorElement, target: EditorElement): readonly EditorElement[] | null {
  if (root.id === target.id) return [root];
  for (const child of root.children) {
    const descendants = lineageTo(child, target);
    if (descendants !== null) return [root, ...descendants];
  }
  return null;
}

function outerEnd(source: string, element: EditorElement): number {
  const closeName = exactClosingNameSpan(source, element);
  return closeName === null
    ? Math.max(element.spans.openTag.end, element.spans.inner.end)
    : element.spans.closeTag!.end;
}

function exactClosingNameSpan(
  source: string,
  element: EditorElement,
): { readonly start: number; readonly end: number } | null {
  const { openTag, inner, closeTag } = element.spans;
  if (closeTag === null) return null;
  const start = closeTag.start + 2;
  const end = start + element.name.length;
  if (
    inner.path !== openTag.path
    || closeTag.path !== openTag.path
    || inner.end !== closeTag.start
    || source.slice(closeTag.start, start) !== '</'
    || source.slice(start, end) !== element.name
    || !/^[\t\r\n ]*>$/.test(source.slice(end, closeTag.end))
  ) {
    throw new UxmlCommandError(
      'ambiguous-source',
      `The recovered closing tag for ${element.name} does not match its source span exactly.`,
    );
  }
  return Object.freeze({ start, end });
}

function insertionPatch(
  session: DocumentSession,
  source: string,
  parent: EditorElement,
  index: number,
  fragment: string,
  children: readonly EditorElement[] = parent.children,
): SourcePatch {
  const current = children[index];
  if (current !== undefined) {
    const lowerBound = index === 0
      ? parent.spans.inner.start
      : outerEnd(source, children[index - 1]);
    const start = current.spans.openTag.start;
    const separator = trailingXmlWhitespace(source.slice(lowerBound, start));
    return Object.freeze({ start, end: start, replacement: `${fragment}${separator}` });
  }
  const previous = children[index - 1];
  if (previous !== undefined) {
    const lowerBound = index === 1
      ? parent.spans.inner.start
      : outerEnd(source, children[index - 2]);
    const separator = trailingXmlWhitespace(source.slice(lowerBound, previous.spans.openTag.start));
    const start = outerEnd(source, previous);
    return Object.freeze({ start, end: start, replacement: `${separator}${fragment}` });
  }

  const tail = trailingXmlWhitespace(source.slice(parent.spans.inner.start, parent.spans.inner.end));
  const start = parent.spans.inner.end - tail.length;
  const { newline, childIndent } = childFormatting(source, session.document.root, parent);
  const prefix = newline.length === 0 ? '' : `${newline}${childIndent}`;
  return Object.freeze({ start, end: start, replacement: `${prefix}${fragment}` });
}

function trailingXmlWhitespace(value: string): string {
  return /[\t\r\n ]*$/.exec(value)?.[0] ?? '';
}

function childFormatting(
  source: string,
  root: EditorElement,
  parent: EditorElement,
): { readonly newline: string; readonly parentIndent: string; readonly childIndent: string } {
  const lineStart = Math.max(
    source.lastIndexOf('\n', parent.spans.openTag.start - 1),
    source.lastIndexOf('\r', parent.spans.openTag.start - 1),
  ) + 1;
  const beforeTag = source.slice(lineStart, parent.spans.openTag.start);
  const parentIndent = /^[\t ]*$/.test(beforeTag) ? beforeTag : '';
  const innerLineBreak = /\r\n|[\r\n]/.exec(
    source.slice(parent.spans.inner.start, parent.spans.inner.end),
  )?.[0] ?? '';
  const lineBreak = lineStart === 0
    ? innerLineBreak
    : source[lineStart - 1] === '\n' && source[lineStart - 2] === '\r'
      ? '\r\n'
      : source[lineStart - 1];
  if (lineBreak.length === 0) {
    return Object.freeze({ newline: '', parentIndent, childIndent: '' });
  }

  const ancestor = parentOf(root, parent);
  const ancestorIndent = ancestor === null ? '' : lineIndentAt(source, ancestor.spans.openTag.start);
  const observedUnit = parentIndent.startsWith(ancestorIndent)
    ? parentIndent.slice(ancestorIndent.length)
    : '';
  const unit = observedUnit.length > 0
    ? observedUnit
    : parentIndent.includes('\t') ? '\t' : '  ';
  return Object.freeze({
    newline: lineBreak,
    parentIndent,
    childIndent: `${parentIndent}${unit}`,
  });
}

function lineIndentAt(source: string, offset: number): string {
  const lineStart = Math.max(source.lastIndexOf('\n', offset - 1), source.lastIndexOf('\r', offset - 1)) + 1;
  const indentation = source.slice(lineStart, offset);
  return /^[\t ]*$/.test(indentation) ? indentation : '';
}

function parentOf(root: EditorElement, target: EditorElement): EditorElement | null {
  for (const child of root.children) {
    if (child.id === target.id) return root;
    const found = parentOf(child, target);
    if (found !== null) return found;
  }
  return null;
}

function containsElement(root: EditorElement, target: EditorElement): boolean {
  return root.id === target.id || root.children.some((child) => containsElement(child, target));
}

function describeInvalidName(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : 'The supplied value';
}

function transaction(
  operation: string,
  label: string,
  path: string,
  patches: readonly SourcePatch[],
): EditorTransaction {
  const fingerprint = JSON.stringify([operation, path, patches]);
  return normalizeEditorTransaction({
    id: `uxml:${operation}:${hash(fingerprint)}`,
    label,
    patchesByFile: new Map([[path, patches]]),
  });
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}
