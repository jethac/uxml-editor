import type {
  EditorElement,
  EditorNodeId,
  EditorSourceSpan,
  StyleExplanationOrigin,
  UssSourcePort,
} from '../adapter/types';
import type { DocumentSession, DocumentSnapshot } from './DocumentSession';
import { createElementLocator, type ElementLocator } from './ElementLocator';
import { freezeInlineTarget } from './styleTargetIdentity';
import { isAuthoredSourceFor } from './styleCascadeCandidates';
import type { InlineStyleTarget, StyleSessionSource } from './StyleTarget';

export interface InlineTargetCommon {
  readonly nodeId: EditorNodeId;
  readonly locator: ElementLocator;
  readonly property: string;
  readonly state: readonly string[];
  readonly sessionSources: readonly StyleSessionSource[];
}

export function inlineTargetFor(
  session: DocumentSession,
  snapshot: DocumentSnapshot,
  sourcePort: UssSourcePort,
  common: InlineTargetCommon,
  authoredNodeId: EditorNodeId,
  origin: Extract<StyleExplanationOrigin, { kind: 'inline' }> | null,
): InlineStyleTarget | null {
  const authoredNode = findElement(session.document.root, authoredNodeId);
  const authoredLocator = authoredNode === null ? null : createElementLocator(session.document.root, authoredNode.id);
  const attributes = authoredNode?.attributes.filter((attribute) => attribute.name === 'style') ?? [];
  const entry = snapshot.files.get(session.entryPath);
  if (authoredNode === null || authoredLocator === null || attributes.length > 1 || entry === undefined) return null;
  const attributeSource = attributes[0]?.source ?? null;
  if (attributeSource === null) {
    return genericInlineTarget(session, common, authoredNode, authoredLocator, null, entry.text);
  }
  if (origin?.source !== undefined && !equalSpan(origin.source, attributeSource)) return null;
  const valueRange = styleAttributeValueRange(entry.text, attributeSource);
  if (valueRange === null) return null;
  const declarations = sourcePort.parseDeclarationList(
    session.entryPath,
    entry.text,
    valueRange.start,
    valueRange.end,
  );
  let declaration = origin === null
    ? undefined
    : declarations.find((item) => item.declarationIndex === origin.declarationIndex);
  if (declaration === undefined) {
    declaration = [...declarations].reverse().find((item) => item.property === common.property);
  }
  if (declaration !== undefined && !isAuthoredSourceFor(common.property, declaration.property)) declaration = undefined;
  const exact = declaration?.property === common.property;
  return freezeInlineTarget({
    kind: 'inline',
    ...common,
    path: session.entryPath,
    sourceSnapshot: entry.text,
    authoredNodeId: authoredNode.id,
    authoredLocator,
    attributeSource,
    declarationIndex: exact ? declaration!.declarationIndex : null,
    declarationSource: exact ? declaration!.source : null,
    value: exact ? declaration!.value : null,
    authoredProperty: declaration?.property ?? null,
    originDeclarationIndex: declaration?.declarationIndex ?? null,
    originDeclarationSource: declaration?.source ?? null,
    originValue: declaration?.value ?? null,
  });
}

export function genericInlineTarget(
  session: DocumentSession,
  common: InlineTargetCommon,
  authoredNode: EditorElement,
  authoredLocator: ElementLocator,
  attributeSource: EditorSourceSpan | null,
  sourceSnapshot: string,
): InlineStyleTarget {
  return freezeInlineTarget({
    kind: 'inline',
    ...common,
    path: session.entryPath,
    sourceSnapshot,
    authoredNodeId: authoredNode.id,
    authoredLocator,
    attributeSource,
    declarationIndex: null,
    declarationSource: null,
    value: null,
    authoredProperty: null,
    originDeclarationIndex: null,
    originDeclarationSource: null,
    originValue: null,
  });
}

function findElement(root: EditorElement, nodeId: EditorNodeId): EditorElement | null {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.id === nodeId) return current;
    pending.push(...current.children);
  }
  return null;
}

function styleAttributeValueRange(source: string, span: EditorSourceSpan): { readonly start: number; readonly end: number } | null {
  if (span.start < 0 || span.end > source.length || span.start >= span.end) return null;
  const text = source.slice(span.start, span.end);
  const equals = text.indexOf('=');
  if (equals === -1) return null;
  let cursor = equals + 1;
  while (isXmlWhitespace(text[cursor])) cursor += 1;
  const quote = text[cursor];
  if (quote !== '"' && quote !== "'") return null;
  const close = text.indexOf(quote, cursor + 1);
  if (close === -1 || !onlyXmlWhitespace(text.slice(close + 1))) return null;
  return Object.freeze({ start: span.start + cursor + 1, end: span.start + close });
}

function equalSpan(left: EditorSourceSpan, right: EditorSourceSpan): boolean {
  return left.path === right.path && left.start === right.start && left.end === right.end;
}

function isXmlWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

function onlyXmlWhitespace(value: string): boolean {
  for (const character of value) if (!isXmlWhitespace(character)) return false;
  return true;
}
