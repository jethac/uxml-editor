import type {
  EditorElement,
  EditorNodeId,
  EditorSourceSpan,
  EditorStylesheet,
  UssSourcePort,
} from '../adapter/types';
import type { DocumentSession, DocumentSnapshot } from './DocumentSession';
import { createElementLocator, type ElementLocator } from './ElementLocator';
import {
  freezeInlineTarget,
  freezeNewRuleTarget,
  freezeRuleTarget,
  snapshotStyleTargetIdentity,
} from './styleTargetIdentity';
import {
  authoredInlineOrigin,
  authoredRuleOrigin,
  collectStyleCandidates,
  isAuthoredSourceFor,
} from './styleCascadeCandidates';
import { genericInlineTarget, inlineTargetFor } from './styleInlineTarget';

export interface StyleSessionSource {
  readonly path: string;
  readonly text: string;
}

interface StyleTargetBase {
  readonly id: string;
  readonly path: string;
  readonly property: string;
  readonly state: readonly string[];
  readonly sourceSnapshot: string;
  readonly nodeId: EditorNodeId;
  readonly locator: ElementLocator;
  readonly sessionSources: readonly StyleSessionSource[];
}

export interface RuleStyleTarget extends StyleTargetBase {
  readonly kind: 'rule';
  readonly sheetIndex: number;
  readonly itemIndex: number;
  readonly declarationIndex: number | null;
  readonly ruleSource: EditorSourceSpan;
  readonly selectorSource: EditorSourceSpan;
  readonly declarationSource: EditorSourceSpan | null;
  readonly value: string | null;
  readonly authoredProperty: string;
  readonly originDeclarationIndex: number;
  readonly originDeclarationSource: EditorSourceSpan;
  readonly originValue: string;
  readonly winner: boolean;
}

export interface InlineStyleTarget extends StyleTargetBase {
  readonly kind: 'inline';
  readonly authoredNodeId: EditorNodeId;
  readonly authoredLocator: ElementLocator;
  readonly attributeSource: EditorSourceSpan | null;
  readonly declarationIndex: number | null;
  readonly declarationSource: EditorSourceSpan | null;
  readonly value: string | null;
  readonly authoredProperty: string | null;
  readonly originDeclarationIndex: number | null;
  readonly originDeclarationSource: EditorSourceSpan | null;
  readonly originValue: string | null;
}

export interface NewRuleStyleTarget extends StyleTargetBase {
  readonly kind: 'new-rule';
  readonly sheetIndex: number;
  readonly selector: string;
}

export type StyleTarget = RuleStyleTarget | InlineStyleTarget | NewRuleStyleTarget;

export type StyleTargetErrorCode =
  | 'invalid-state'
  | 'ambiguous-state'
  | 'invalid-target'
  | 'invalid-property'
  | 'invalid-node';

const SUPPORTED_STATES = new Set([
  'active',
  'checked',
  'disabled',
  'focus',
  'hover',
  'inactive',
  'root',
  'selected',
]);

export class StyleTargetError extends Error {
  constructor(readonly code: StyleTargetErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StyleTargetError';
  }
}

export function hasValidStyleTargetIdentity(target: StyleTarget): boolean {
  try {
    snapshotStyleTargetIdentity(target);
    return true;
  } catch {
    return false;
  }
}

export function snapshotStyleTarget(candidate: unknown): StyleTarget {
  try {
    return snapshotStyleTargetIdentity(candidate);
  } catch (error) {
    throw new StyleTargetError('invalid-target', 'The style target identity is malformed or inconsistent.', error);
  }
}

export function styleTargetsFor(
  session: DocumentSession,
  node: EditorElement,
  property: string,
  state: readonly string[],
): readonly StyleTarget[] {
  const requestedState = snapshotState(state);
  if (typeof property !== 'string' || !isPropertyName(property)) {
    throw new StyleTargetError('invalid-property', 'A style property must be one safe USS property identifier.');
  }
  const currentNode = findElement(session.document.root, node?.id);
  if (currentNode === null || currentNode !== node) {
    throw new StyleTargetError('invalid-node', 'The style node is not from the current parsed document session.');
  }
  const locator = createElementLocator(session.document.root, currentNode.id);
  if (locator === null) return Object.freeze([]);

  const snapshot = session.snapshot();
  const sessionSources = sessionSourcesFor(snapshot);
  const sourcePort = asUssSourcePort(session.adapter);
  const options = explanationOptions(session.document.root, currentNode, requestedState);
  const explanation = session.adapter.explain(session.document, currentNode.id, property, options);
  const candidates = collectStyleCandidates(session, currentNode, property, options, explanation);
  const parsedSheets = new Map<string, EditorStylesheet>();
  const common = { nodeId: currentNode.id, locator, property, state: requestedState, sessionSources };
  const result: StyleTarget[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const origin = authoredRuleOrigin(candidate.origin);
    if (
      origin === null
      || origin.source === undefined
      || origin.sheetPath === null
      || !equalState(origin.states ?? [], requestedState)
      || sourcePort === null
    ) continue;
    const buffer = snapshot.files.get(origin.sheetPath);
    if (buffer === undefined || origin.source.path !== origin.sheetPath) continue;
    const parsed = parsedSheets.get(origin.sheetPath)
      ?? sourcePort.parseStylesheet(origin.sheetPath, buffer.text);
    parsedSheets.set(origin.sheetPath, parsed);
    const rule = parsed.rules.find((item) => item.itemIndex === origin.itemIndex);
    const declaration = rule?.declarations.find((item) => item.declarationIndex === origin.declarationIndex);
    if (
      rule === undefined
      || declaration === undefined
      || !isAuthoredSourceFor(property, declaration.property)
      || !equalSpan(declaration.source, origin.source)
    ) continue;
    const exact = declaration.property === property;
    const target = freezeRuleTarget({
      kind: 'rule',
      ...common,
      path: origin.sheetPath,
      sheetIndex: origin.sheetIndex,
      itemIndex: origin.itemIndex,
      declarationIndex: exact ? origin.declarationIndex : null,
      sourceSnapshot: buffer.text,
      ruleSource: rule.source,
      selectorSource: rule.selectorSource,
      declarationSource: exact ? declaration.source : null,
      value: exact ? declaration.value : null,
      authoredProperty: declaration.property,
      originDeclarationIndex: origin.declarationIndex,
      originDeclarationSource: declaration.source,
      originValue: declaration.value,
      winner: candidate.winner,
    });
    if (!seen.has(target.id)) {
      seen.add(target.id);
      result.push(target);
    }
  }

  if (requestedState.length === 0 && explanation !== null) {
    const inheritedInline = authoredInlineOrigin(explanation.computed.origin);
    if (inheritedInline !== null && inheritedInline.nodeId !== currentNode.id && sourcePort !== null) {
      const inherited = inlineTargetFor(
        session,
        snapshot,
        sourcePort,
        common,
        inheritedInline.nodeId,
        inheritedInline,
      );
      if (inherited !== null && !seen.has(inherited.id)) {
        seen.add(inherited.id);
        result.push(inherited);
      }
    }
  }

  const entry = snapshot.files.get(session.entryPath);
  const styleAttributes = currentNode.attributes.filter((attribute) => attribute.name === 'style');
  if (entry !== undefined && styleAttributes.length <= 1 && requestedState.length === 0) {
    const inlineOrigin = candidates
      .map((candidate) => authoredInlineOrigin(candidate.origin))
      .find((origin) => origin?.nodeId === currentNode.id) ?? null;
    const target = sourcePort === null
      ? genericInlineTarget(session, common, currentNode, locator, styleAttributes[0]?.source ?? null, entry.text)
      : inlineTargetFor(session, snapshot, sourcePort, common, currentNode.id, inlineOrigin)
        ?? genericInlineTarget(session, common, currentNode, locator, styleAttributes[0]?.source ?? null, entry.text);
    if (!seen.has(target.id)) {
      seen.add(target.id);
      result.push(target);
    }
  }

  const selector = selectorFor(session.document.root, currentNode, requestedState);
  if (selector !== null && sourcePort !== null) {
    const paths = new Set<string>();
    for (const sheetIndex of session.document.localStyleSheetIndices ?? []) {
      const path = session.document.originsBySheet[sheetIndex];
      if (path === null || path === undefined || paths.has(path)) continue;
      const buffer = snapshot.files.get(path);
      if (buffer === undefined) continue;
      paths.add(path);
      result.push(freezeNewRuleTarget({
        kind: 'new-rule',
        ...common,
        path,
        sheetIndex,
        selector,
        sourceSnapshot: buffer.text,
      }));
    }
  }

  return Object.freeze(result);
}

function sessionSourcesFor(snapshot: DocumentSnapshot): readonly StyleSessionSource[] {
  return Object.freeze([...snapshot.files]
    .map(([path, buffer]) => Object.freeze({ path, text: buffer.text }))
    .sort((left, right) => compareExactPath(left.path, right.path)));
}

function asUssSourcePort(adapter: unknown): UssSourcePort | null {
  const candidate = adapter as Partial<UssSourcePort> | null;
  return candidate !== null
    && typeof candidate?.parseStylesheet === 'function'
    && typeof candidate.parseDeclarationList === 'function'
    ? candidate as UssSourcePort
    : null;
}

function explanationOptions(root: EditorElement, node: EditorElement, state: readonly string[]) {
  if (state.length === 0) return undefined;
  const name = node.attributes.find((attribute) => attribute.name === 'name')?.value;
  if (name === undefined || !isSelectorIdentifier(name) || authoredNameCount(root, name) !== 1) {
    throw new StyleTargetError(
      'ambiguous-state',
      'A pseudo-state write target requires one unique parser-safe authored name on the requested node.',
    );
  }
  return { states: { [`#${name}`]: state } };
}

function selectorFor(root: EditorElement, node: EditorElement, state: readonly string[]): string | null {
  const name = node.attributes.find((attribute) => attribute.name === 'name')?.value;
  if (name === undefined || !isSelectorIdentifier(name) || authoredNameCount(root, name) !== 1) return null;
  return `#${name}${state.map((item) => `:${item}`).join('')}`;
}

function authoredNameCount(root: EditorElement, name: string): number {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name)) count += 1;
    pending.push(...current.children);
  }
  return count;
}

function snapshotState(state: readonly string[]): readonly string[] {
  try {
    if (!Array.isArray(state)) throw new TypeError('State must be an array.');
    const copied = [...state];
    if (
      copied.some((item) => typeof item !== 'string' || !isSelectorIdentifier(item))
      || copied.some((item) => !SUPPORTED_STATES.has(item))
      || new Set(copied).size !== copied.length
    ) throw new TypeError('States must be unique USS pseudo-class identifiers.');
    return Object.freeze(copied.sort());
  } catch (error) {
    throw new StyleTargetError(
      'invalid-state',
      'Requested style states must be a readable array of unique USS pseudo-class identifiers.',
      error,
    );
  }
}

function findElement(root: EditorElement, nodeId: EditorNodeId | undefined): EditorElement | null {
  if (nodeId === undefined) return null;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.id === nodeId) return current;
    pending.push(...current.children);
  }
  return null;
}

function isPropertyName(value: string): boolean {
  return /^(?:--[A-Za-z0-9_-]+|-?[A-Za-z_][A-Za-z0-9_-]*)$/.test(value);
}

function isSelectorIdentifier(value: string): boolean {
  return /^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(value);
}

function equalState(left: readonly string[], right: readonly string[]): boolean {
  const normalized = [...new Set(left)].sort();
  return normalized.length === right.length && normalized.every((value, index) => value === right[index]);
}

function equalSpan(left: EditorSourceSpan, right: EditorSourceSpan): boolean {
  return left.path === right.path && left.start === right.start && left.end === right.end;
}

function compareExactPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
