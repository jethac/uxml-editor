import type { EditorElement, StyleExplanationOrigin } from '../adapter/types';
import { DocumentSession } from '../documents/DocumentSession';
import { resolveElementLocator, type ElementLocator } from '../documents/ElementLocator';
import { styleTargetsFor, type StyleTarget } from '../documents/StyleTarget';
import { normalizeEditorTransaction } from './EditorTransaction';
import type {
  LayoutCommandFailure,
  LayoutCommandOptions,
  LayoutCommandResult,
} from './layoutCommands';
import { SequentialPatchComposer } from './sequentialPatchComposer';
import { setDeclaration, setInlineStyle } from './ussCommands';

export interface StyleWrite {
  readonly locator: ElementLocator;
  readonly property: 'left' | 'top' | 'width' | 'height';
  readonly value: number;
}

export function planStyleWrites(
  session: DocumentSession,
  writes: readonly StyleWrite[],
  label: string,
  options: LayoutCommandOptions,
): LayoutCommandResult {
  try {
    const before = session.snapshot();
    const shadow = DocumentSession.open(
      new Map([...before.files].map(([path, buffer]) => [path, buffer.text])),
      session.entryPath,
      session.adapter,
    );
    const composers = new Map([...before.files].map(([path, buffer]) => [
      path,
      new SequentialPatchComposer(buffer.text),
    ]));
    for (const write of writes) {
      const nodeId = resolveElementLocator(shadow.document.root, write.locator);
      const node = nodeId === null ? null : findElement(shadow.document.root, nodeId);
      if (node === null) return ambiguous('A layout target no longer resolves uniquely.');
      const target = chooseWriteTarget(shadow, node, write.property);
      if (!target.ok) return target;
      const value = `${formatNumber(write.value)}px`;
      const transaction = target.target.kind === 'rule'
        ? setDeclaration(shadow, target.target, value)
        : setInlineStyle(shadow, target.target, value);
      const committed = shadow.commit(transaction);
      for (const [path, patches] of committed.forward.patchesByFile) {
        const composer = composers.get(path);
        if (composer === undefined) throw new TypeError(`Layout write references unknown source ${path}.`);
        composer.apply(patches);
      }
    }
    const patchesByFile = new Map<string, readonly import('./SourcePatch').SourcePatch[]>();
    for (const [path, composer] of composers) {
      const patches = composer.patches();
      if (patches.length > 0) patchesByFile.set(path, patches);
    }
    return Object.freeze({
      ok: true,
      transaction: normalizeEditorTransaction({
        id: 'layout-write',
        label,
        patchesByFile,
        ...(session.selection.length === 0 ? {} : { selectionAfter: session.selection }),
        ...(options.coalesceKey === undefined ? {} : { coalesceKey: options.coalesceKey }),
      }),
    });
  } catch (error) {
    return ambiguous(error instanceof Error && error.message.length > 0
      ? error.message
      : 'The authored layout target could not be changed safely.');
  }
}

export function computedPixels(
  session: DocumentSession,
  node: EditorElement,
  property: 'left' | 'top',
): number | null {
  const value = session.adapter.explain(session.document, node.id, property)?.computed.value;
  if (value === null || value === undefined) return null;
  const match = /^(-?(?:\d+|\d*\.\d+))px$/.exec(value);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function chooseWriteTarget(
  session: DocumentSession,
  node: EditorElement,
  property: StyleWrite['property'],
): LayoutCommandFailure | { readonly ok: true; readonly target: Exclude<StyleTarget, { kind: 'new-rule' }> } {
  const explanation = session.adapter.explain(session.document, node.id, property);
  if (explanation === null) return ambiguous(`Computed ${property} provenance is unavailable.`, node.id);
  const targets = styleTargetsFor(session, node, property, []);
  const authored = authoredTarget(explanation.computed.origin, node, targets);
  if (authored !== null) {
    if (authored.length !== 1) return ambiguous(`Computed ${property} has no unique authored write target.`, node.id);
    return Object.freeze({ ok: true, target: authored[0] });
  }
  if (isAuthoredOrigin(explanation.computed.origin)) {
    return ambiguous(`Computed ${property} provenance cannot be mapped to one exact source target.`, node.id);
  }
  const inline = targets.filter((target): target is Extract<StyleTarget, { kind: 'inline' }> =>
    target.kind === 'inline'
    && target.state.length === 0
    && target.authoredNodeId === node.id,
  );
  if (inline.length !== 1) return ambiguous(`Element ${property} has no unique safe base-state inline target.`, node.id);
  return Object.freeze({ ok: true, target: inline[0] });
}

function authoredTarget(
  origin: StyleExplanationOrigin,
  node: EditorElement,
  targets: readonly StyleTarget[],
): readonly Exclude<StyleTarget, { kind: 'new-rule' }>[] | null {
  if (origin.kind === 'inherited') return authoredTarget(origin.origin, node, targets);
  if (origin.kind === 'rule') {
    if ((origin.states ?? []).length !== 0) return [];
    return targets.filter((target): target is Extract<StyleTarget, { kind: 'rule' }> =>
      target.kind === 'rule'
      && target.winner
      && target.sheetIndex === origin.sheetIndex
      && target.itemIndex === origin.itemIndex
      && target.originDeclarationIndex === origin.declarationIndex,
    );
  }
  if (origin.kind === 'inline') {
    if (origin.nodeId !== node.id) return [];
    return targets.filter((target): target is Extract<StyleTarget, { kind: 'inline' }> =>
      target.kind === 'inline'
      && target.authoredNodeId === node.id
      && target.originDeclarationIndex === origin.declarationIndex,
    );
  }
  return null;
}

function isAuthoredOrigin(origin: StyleExplanationOrigin): boolean {
  return origin.kind === 'rule' || origin.kind === 'inline' || (origin.kind === 'inherited' && isAuthoredOrigin(origin.origin));
}

function findElement(root: EditorElement, id: EditorElement['id']): EditorElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findElement(child, id);
    if (found !== null) return found;
  }
  return null;
}

function ambiguous(message: string, nodeId?: EditorElement['id']): LayoutCommandFailure {
  return Object.freeze({
    ok: false,
    diagnostic: Object.freeze({
      code: 'AMBIGUOUS_LAYOUT_WRITE',
      message,
      ...(nodeId === undefined ? {} : { nodeId }),
    }),
  });
}

function formatNumber(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : Math.round(value * 1000) / 1000;
  return String(normalized);
}
