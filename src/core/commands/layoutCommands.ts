import type {
  EditorElement,
  EditorNodeId,
  PreviewFrame,
  RenderFrameBox,
} from '../adapter/types';
import type { DocumentSession } from '../documents/DocumentSession';
import type { ElementLocator } from '../documents/ElementLocator';
import { normalizeEditorTransaction, type EditorTransaction } from './EditorTransaction';
import { computedPixels, planStyleWrites, type StyleWrite } from './layoutStyleWritePlanner';
import { moveElement } from './uxmlCommands';

export type LayoutDiagnosticCode =
  | 'AMBIGUOUS_LAYOUT_WRITE'
  | 'INVALID_LAYOUT_VALUE'
  | 'INVALID_LAYOUT_SELECTION'
  | 'MISSING_PREVIEW_GEOMETRY';

export interface LayoutDiagnostic {
  readonly code: LayoutDiagnosticCode;
  readonly message: string;
  readonly nodeId?: EditorNodeId;
}

export interface LayoutCommandSuccess {
  readonly ok: true;
  readonly transaction: EditorTransaction;
}

export interface LayoutCommandFailure {
  readonly ok: false;
  readonly diagnostic: LayoutDiagnostic;
}

export type LayoutCommandResult = LayoutCommandSuccess | LayoutCommandFailure;
export type Alignment = 'left' | 'horizontal-center' | 'right' | 'top' | 'vertical-center' | 'bottom';
export type Distribution = 'horizontal' | 'vertical';
export type SourceOrder = 'front' | 'back';

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface LayoutSize {
  readonly width: number;
  readonly height: number;
}

export interface LayoutCommandOptions {
  readonly coalesceKey?: string;
}

export const layoutCommands = Object.freeze({
  canMove,
  move,
  resize,
  nudge,
  align,
  distribute,
  order,
});

function canMove(session: DocumentSession, node: EditorElement): LayoutCommandFailure | { readonly ok: true } {
  try {
    const current = currentElement(session, node);
    if (current === null) return ambiguous(node?.id, 'The manipulated node is not the current source-backed element.');
    const position = session.adapter.explain(session.document, current.id, 'position');
    if (position?.computed.value !== 'absolute') {
      return ambiguous(current.id, 'Free movement requires computed position to be exactly absolute.');
    }
    return Object.freeze({ ok: true });
  } catch (error) {
    return ambiguous(node?.id, commandMessage(error, 'Computed position provenance is unavailable.'));
  }
}

function move(
  session: DocumentSession,
  node: EditorElement,
  point: LayoutPoint,
  options: LayoutCommandOptions = {},
): LayoutCommandResult {
  const guard = canMove(session, node);
  if (!guard.ok) return guard;
  if (!finite(point?.x) || !finite(point?.y)) return invalidValue(node.id, 'Movement coordinates must be finite numbers.');
  const locator = session.locatorFor(node.id);
  if (locator === null) return ambiguous(node.id, 'The manipulated node has no stable source locator.');
  return planStyleWrites(session, [
    { locator, property: 'left', value: point.x },
    { locator, property: 'top', value: point.y },
  ], 'Move element', options);
}

function resize(
  session: DocumentSession,
  node: EditorElement,
  size: LayoutSize,
  options: LayoutCommandOptions = {},
): LayoutCommandResult {
  const current = currentElement(session, node);
  if (current === null) return ambiguous(node?.id, 'The resized node is not the current source-backed element.');
  if (!finite(size?.width) || !finite(size?.height) || size.width < 0 || size.height < 0) {
    return invalidValue(current.id, 'Width and height must be finite non-negative numbers.');
  }
  const locator = session.locatorFor(current.id);
  if (locator === null) return ambiguous(current.id, 'The resized node has no stable source locator.');
  return planStyleWrites(session, [
    { locator, property: 'width', value: size.width },
    { locator, property: 'height', value: size.height },
  ], 'Resize element', options);
}

function nudge(
  session: DocumentSession,
  nodes: EditorElement | readonly EditorElement[],
  delta: LayoutPoint,
  options: LayoutCommandOptions = {},
): LayoutCommandResult {
  const selected = Array.isArray(nodes) ? [...nodes] : [nodes as EditorElement];
  if (selected.length === 0 || !finite(delta?.x) || !finite(delta?.y)) {
    return invalidSelection('Nudging requires elements and a finite delta.');
  }
  const writes: StyleWrite[] = [];
  for (const requested of selected) {
    const guard = canMove(session, requested);
    if (!guard.ok) return guard;
    const locator = session.locatorFor(requested.id);
    const left = computedPixels(session, requested, 'left');
    const top = computedPixels(session, requested, 'top');
    if (locator === null || left === null || top === null) {
      return ambiguous(requested.id, 'Nudging requires unambiguous pixel left and top values.');
    }
    writes.push(
      { locator, property: 'left', value: left + delta.x },
      { locator, property: 'top', value: top + delta.y },
    );
  }
  return planStyleWrites(session, writes, 'Nudge element', options);
}

function align(
  session: DocumentSession,
  nodes: readonly EditorElement[],
  alignment: Alignment,
  frame: PreviewFrame,
  options: LayoutCommandOptions = {},
): LayoutCommandResult {
  if (nodes.length < 2) return invalidSelection('Alignment requires at least two selected elements.');
  const boxes = boxesFor(nodes, frame);
  if (boxes === null) return missingGeometry('Every aligned element requires a current preview box.');
  const union = unionBox(boxes.map(({ box }) => box));
  const writes: StyleWrite[] = [];
  for (const { node, box } of boxes) {
    const guard = canMove(session, node);
    if (!guard.ok) return guard;
    const horizontal = alignment === 'left' || alignment === 'horizontal-center' || alignment === 'right';
    const property = horizontal ? 'left' : 'top';
    const current = computedPixels(session, node, property);
    const locator = session.locatorFor(node.id);
    if (current === null || locator === null) return ambiguous(node.id, `Alignment requires an unambiguous pixel ${property} value.`);
    const desired = alignmentCoordinate(alignment, union, box);
    const observed = horizontal ? box.left : box.top;
    writes.push({ locator, property, value: current + desired - observed });
  }
  return planStyleWrites(session, writes, 'Align elements', options);
}

function distribute(
  session: DocumentSession,
  nodes: readonly EditorElement[],
  direction: Distribution,
  frame: PreviewFrame,
  options: LayoutCommandOptions = {},
): LayoutCommandResult {
  if (nodes.length < 3) return invalidSelection('Distribution requires at least three selected elements.');
  const boxes = boxesFor(nodes, frame);
  if (boxes === null) return missingGeometry('Every distributed element requires a current preview box.');
  for (const { node } of boxes) {
    const guard = canMove(session, node);
    if (!guard.ok) return guard;
  }
  const horizontal = direction === 'horizontal';
  const sorted = [...boxes].sort((left, right) =>
    (horizontal ? left.box.left - right.box.left : left.box.top - right.box.top),
  );
  const first = sorted[0].box;
  const last = sorted[sorted.length - 1].box;
  const available = (horizontal ? last.left + last.width - first.left : last.top + last.height - first.top)
    - sorted.reduce((total, item) => total + (horizontal ? item.box.width : item.box.height), 0);
  const gap = available / (sorted.length - 1);
  let cursor = horizontal ? first.left + first.width + gap : first.top + first.height + gap;
  const writes: StyleWrite[] = [];
  for (const { node, box } of sorted.slice(1, -1)) {
    const property = horizontal ? 'left' : 'top';
    const current = computedPixels(session, node, property);
    const locator = session.locatorFor(node.id);
    if (current === null || locator === null) return ambiguous(node.id, `Distribution requires an unambiguous pixel ${property} value.`);
    const observed = horizontal ? box.left : box.top;
    writes.push({ locator, property, value: current + cursor - observed });
    cursor += (horizontal ? box.width : box.height) + gap;
  }
  return planStyleWrites(session, writes, `Distribute elements ${direction}`, options);
}

function order(
  session: DocumentSession,
  nodes: readonly EditorElement[],
  destination: SourceOrder,
  options: LayoutCommandOptions = {},
): LayoutCommandResult {
  if (nodes.length === 0) return invalidSelection('Source ordering requires at least one selected element.');
  const current = nodes.map((node) => currentElement(session, node));
  if (current.some((node) => node === null)) return ambiguous(undefined, 'Every ordered node must be from the current document.');
  const elements = current as EditorElement[];
  const parent = parentOf(session.document.root, elements[0]);
  if (parent === null || elements.some((element) => parentOf(session.document.root, element)?.id !== parent.id)) {
    return invalidSelection('Source ordering requires sibling elements with one parent.');
  }
  const indices = elements.map((element) => parent.children.findIndex((child) => child.id === element.id)).sort((a, b) => a - b);
  if (indices.some((index, position) => index < 0 || (position > 0 && index !== indices[position - 1] + 1))) {
    return invalidSelection('Source ordering requires a contiguous sibling selection.');
  }
  const locators = elements.map((element) => session.locatorFor(element.id));
  const parentLocator = session.locatorFor(parent.id);
  if (parentLocator === null || locators.some((locator) => locator === null)) {
    return ambiguous(undefined, 'Source ordering requires stable element locators.');
  }
  try {
    const planned = moveElement(
      session,
      locators as ElementLocator[],
      parentLocator,
      destination === 'front' ? parent.children.length - elements.length : 0,
    );
    return success(withOptions(planned, options));
  } catch (error) {
    return ambiguous(undefined, commandMessage(error, 'The requested source order is ambiguous.'));
  }
}

function withOptions(transaction: EditorTransaction, options: LayoutCommandOptions): EditorTransaction {
  return normalizeEditorTransaction({
    ...transaction,
    ...(options.coalesceKey === undefined ? {} : { coalesceKey: options.coalesceKey }),
  });
}

function success(transaction: EditorTransaction): LayoutCommandSuccess {
  return Object.freeze({ ok: true, transaction });
}

function ambiguous(nodeId: EditorNodeId | undefined, message: string): LayoutCommandFailure {
  return failure('AMBIGUOUS_LAYOUT_WRITE', message, nodeId);
}

function invalidValue(nodeId: EditorNodeId | undefined, message: string): LayoutCommandFailure {
  return failure('INVALID_LAYOUT_VALUE', message, nodeId);
}

function invalidSelection(message: string): LayoutCommandFailure {
  return failure('INVALID_LAYOUT_SELECTION', message);
}

function missingGeometry(message: string): LayoutCommandFailure {
  return failure('MISSING_PREVIEW_GEOMETRY', message);
}

function failure(code: LayoutDiagnosticCode, message: string, nodeId?: EditorNodeId): LayoutCommandFailure {
  return Object.freeze({
    ok: false,
    diagnostic: Object.freeze({ code, message, ...(nodeId === undefined ? {} : { nodeId }) }),
  });
}

function currentElement(session: DocumentSession, requested: EditorElement | undefined): EditorElement | null {
  if (requested === undefined) return null;
  const found = findElement(session.document.root, requested.id);
  return found === requested ? found : null;
}

function findElement(root: EditorElement, id: EditorNodeId): EditorElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findElement(child, id);
    if (found !== null) return found;
  }
  return null;
}

function parentOf(root: EditorElement, requested: EditorElement): EditorElement | null {
  for (const child of root.children) {
    if (child.id === requested.id) return root;
    const nested = parentOf(child, requested);
    if (nested !== null) return nested;
  }
  return null;
}

function boxesFor(
  nodes: readonly EditorElement[],
  frame: PreviewFrame,
): readonly { readonly node: EditorElement; readonly box: RenderFrameBox }[] | null {
  const result = nodes.map((node) => ({ node, box: frame.boxes.get(node.id) }));
  return result.some(({ box }) => box === undefined)
    ? null
    : result as readonly { readonly node: EditorElement; readonly box: RenderFrameBox }[];
}

function unionBox(boxes: readonly RenderFrameBox[]): RenderFrameBox {
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return Object.freeze({ left, top, width: right - left, height: bottom - top });
}

function alignmentCoordinate(alignment: Alignment, union: RenderFrameBox, box: RenderFrameBox): number {
  if (alignment === 'left') return union.left;
  if (alignment === 'horizontal-center') return union.left + (union.width - box.width) / 2;
  if (alignment === 'right') return union.left + union.width - box.width;
  if (alignment === 'top') return union.top;
  if (alignment === 'vertical-center') return union.top + (union.height - box.height) / 2;
  return union.top + union.height - box.height;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function commandMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
