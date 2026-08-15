import { DocumentSession } from '../../core/documents/DocumentSession';
import { resolveElementLocator, type ElementLocator } from '../../core/documents/ElementLocator';
import { styleTargetsFor, type StyleTarget } from '../../core/documents/StyleTarget';
import { normalizeEditorTransaction, type EditorTransaction } from '../../core/commands/EditorTransaction';
import { SequentialPatchComposer } from '../../core/commands/sequentialPatchComposer';
import { insertRule, setDeclaration, setInlineStyle } from '../../core/commands/ussCommands';
import { removeAttribute, setAttribute } from '../../core/commands/uxmlCommands';
import type { EditorElement } from '../../core/adapter/types';

export interface StyleEditTarget {
  readonly locator: ElementLocator;
  readonly target: StyleTarget;
}

export interface StyleEditRequest extends StyleEditTarget {
  readonly value: string;
}

export function composeStyleEdit(
  session: DocumentSession,
  edits: readonly StyleEditTarget[],
  value: string,
): EditorTransaction {
  return composeStyleEdits(session, edits.map((edit) => ({ ...edit, value })));
}

export function composeStyleEdits(
  session: DocumentSession,
  edits: readonly StyleEditRequest[],
): EditorTransaction {
  if (edits.length === 0) throw new Error('A style edit requires at least one compatible target.');
  const valuesByIdentity = new Map<string, string>();
  const unique: StyleEditRequest[] = [];
  for (const edit of edits) {
    planStyleTarget(session, edit.target, edit.value);
    const identity = exactStyleIdentity(edit.target);
    const previous = valuesByIdentity.get(identity);
    if (previous !== undefined && previous !== edit.value) {
      throw new Error('Selected elements request different values through one exact authored declaration.');
    }
    if (previous === edit.value) continue;
    valuesByIdentity.set(identity, edit.value);
    unique.push(edit);
  }
  return composeSequential(session, unique.map((edit) => (shadow) => {
    const nodeId = resolveElementLocator(shadow.document.root, edit.locator);
    const node = nodeId === null ? null : findElement(shadow.document.root, nodeId);
    if (node === null) throw new Error('The selected style element is stale.');
    const target = reissueTarget(shadow, node, edit.target);
    return planStyleTarget(shadow, target, edit.value);
  }), `Set ${edits[0].target.property}`, edits.map((edit) => edit.locator));
}

export function composeAttributeEdit(
  session: DocumentSession,
  locators: readonly ElementLocator[],
  name: string,
  value: string | null,
): EditorTransaction {
  if (locators.length === 0) throw new Error('An attribute edit requires at least one selected element.');
  const seen = new Set<string>();
  for (const locator of locators) {
    const key = JSON.stringify(locator);
    if (seen.has(key)) throw new Error('The attribute selection contains the same source element more than once.');
    seen.add(key);
    if (value === null) removeAttribute(session, locator, name);
    else setAttribute(session, locator, name, value);
  }
  return composeSequential(session, locators.map((locator) => (shadow) => {
    const nodeId = resolveElementLocator(shadow.document.root, locator);
    if (nodeId === null) throw new Error('The selected attribute element is stale.');
    const currentLocator = shadow.locatorFor(nodeId);
    if (currentLocator === null) throw new Error('The selected attribute element has no stable source locator.');
    return value === null
      ? removeAttribute(shadow, currentLocator, name)
      : setAttribute(shadow, currentLocator, name, value);
  }), `${value === null ? 'Remove' : 'Set'} ${name} attribute`, locators);
}

function composeSequential(
  session: DocumentSession,
  planners: readonly ((shadow: DocumentSession) => EditorTransaction)[],
  label: string,
  selection: readonly ElementLocator[],
): EditorTransaction {
  const before = session.snapshot();
  const shadow = DocumentSession.open(
    new Map([...before.files].map(([path, buffer]) => [path, buffer.text])),
    session.entryPath,
    session.adapter,
  );
  const composers = new Map([...before.files].map(([path, buffer]) => [path, new SequentialPatchComposer(buffer.text)]));
  for (const plan of planners) {
    const committed = shadow.commit(plan(shadow));
    for (const [path, patches] of committed.forward.patchesByFile) {
      const composer = composers.get(path);
      if (composer === undefined) throw new Error(`Inspector edit references unknown source ${path}.`);
      composer.apply(patches);
    }
  }
  const patchesByFile = new Map<string, readonly import('../../core/commands/SourcePatch').SourcePatch[]>();
  for (const [path, composer] of composers) {
    const patches = composer.patches();
    if (patches.length > 0) patchesByFile.set(path, patches);
  }
  if (patchesByFile.size === 0) throw new Error('The requested inspector edit would not change source.');
  return normalizeEditorTransaction({
    id: `inspector:${hash(JSON.stringify([...patchesByFile]))}`,
    label,
    patchesByFile,
    selectionAfter: selection,
  });
}

function planStyleTarget(session: DocumentSession, target: StyleTarget, value: string): EditorTransaction {
  if (target.kind === 'rule') return setDeclaration(session, target, value);
  if (target.kind === 'inline') return setInlineStyle(session, target, value);
  return insertRule(session, target, value);
}

function reissueTarget(session: DocumentSession, node: EditorElement, requested: StyleTarget): StyleTarget {
  const targets = styleTargetsFor(session, node, requested.property, requested.state);
  const target = targets.find((candidate) => sameDestination(candidate, requested));
  if (target === undefined) throw new Error('The selected style destination is no longer available.');
  return target;
}

function sameDestination(candidate: StyleTarget, requested: StyleTarget): boolean {
  if (candidate.kind !== requested.kind || candidate.path !== requested.path || candidate.property !== requested.property) return false;
  if (candidate.kind === 'rule' && requested.kind === 'rule') {
    return candidate.sheetIndex === requested.sheetIndex
      && candidate.itemIndex === requested.itemIndex
      && candidate.declarationIndex === requested.declarationIndex
      && candidate.originDeclarationIndex === requested.originDeclarationIndex;
  }
  if (candidate.kind === 'inline' && requested.kind === 'inline') {
    return candidate.authoredNodeId === candidate.nodeId && requested.authoredNodeId === requested.nodeId;
  }
  return candidate.kind === 'new-rule' && requested.kind === 'new-rule' && candidate.selector === requested.selector;
}

function exactStyleIdentity(target: StyleTarget): string {
  if (target.kind === 'rule') {
    const source = target.declarationSource ?? target.ruleSource;
    return JSON.stringify(['rule', target.path, target.property, source.start, source.end]);
  }
  if (target.kind === 'inline') {
    const source = target.declarationSource ?? target.attributeSource;
    return source === null
      ? JSON.stringify(['inline-new', target.path, target.property, target.authoredNodeId])
      : JSON.stringify(['inline', target.path, target.property, source.start, source.end]);
  }
  return JSON.stringify(['new-rule', target.path, target.selector, target.property]);
}

function findElement(root: EditorElement, id: EditorElement['id']): EditorElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findElement(child, id);
    if (found !== null) return found;
  }
  return null;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}
