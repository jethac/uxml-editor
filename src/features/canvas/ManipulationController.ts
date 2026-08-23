import type { EditorElement, PreviewFrame, RenderFrameBox } from '../../core/adapter/types';
import type { DocumentSession } from '../../core/documents/DocumentSession';
import { resolveElementLocator, type ElementLocator } from '../../core/documents/ElementLocator';
import {
  layoutCommands,
  type LayoutCommandFailure,
  type LayoutCommandResult,
  type LayoutDiagnostic,
  type LayoutPoint,
} from '../../core/commands/layoutCommands';

export interface SnapGuide {
  readonly axis: 'x' | 'y';
  readonly value: number;
}

export interface SnapResult extends LayoutPoint {
  readonly guides: readonly SnapGuide[];
}

export interface ManipulationControllerOptions {
  readonly snapThreshold?: number;
  readonly onCommit?: () => void;
}

export type GestureResult =
  | { readonly ok: true; readonly guides?: readonly SnapGuide[] }
  | LayoutCommandFailure;

interface MoveGesture {
  readonly kind: 'move';
  readonly locator: ElementLocator;
  readonly pointer: LayoutPoint;
  readonly box: RenderFrameBox;
  readonly authoredLeft: number;
  readonly authoredTop: number;
  readonly targets: readonly RenderFrameBox[];
  readonly coalesceKey: string;
  lastPoint: LayoutPoint | null;
}

interface ResizeGesture {
  readonly kind: 'resize';
  readonly locator: ElementLocator;
  readonly pointer: LayoutPoint;
  readonly box: RenderFrameBox;
  readonly coalesceKey: string;
  lastPoint: LayoutPoint | null;
}

type Gesture = MoveGesture | ResizeGesture;

let gestureSequence = 0;

export class ManipulationController {
  private gesture: Gesture | null = null;
  private readonly snapThreshold: number;
  private readonly onCommit: () => void;

  constructor(
    private readonly session: DocumentSession,
    private readonly frame: PreviewFrame,
    options: ManipulationControllerOptions = {},
  ) {
    this.snapThreshold = finiteNonNegative(options.snapThreshold) ? options.snapThreshold : 5;
    this.onCommit = options.onCommit ?? (() => undefined);
  }

  start(node: EditorElement, pointer: LayoutPoint): GestureResult {
    if (!finitePoint(pointer)) return invalidGesture('A drag requires finite pointer coordinates.');
    const guard = layoutCommands.canMove(this.session, node);
    if (!guard.ok) return guard;
    const locator = this.session.locatorFor(node.id);
    const box = this.frame.boxes.get(node.id);
    const authoredLeft = computedPixels(this.session, node, 'left');
    const authoredTop = computedPixels(this.session, node, 'top');
    if (locator === null || box === undefined || authoredLeft === null || authoredTop === null) {
      return invalidGesture('A drag requires current preview geometry and pixel left/top values.', node.id);
    }
    this.gesture = {
      kind: 'move',
      locator,
      pointer: freezePoint(pointer),
      box,
      authoredLeft,
      authoredTop,
      targets: snapTargets(this.session.document.root, node, this.frame),
      coalesceKey: nextCoalesceKey('drag'),
      lastPoint: null,
    };
    return Object.freeze({ ok: true });
  }

  startResize(node: EditorElement, pointer: LayoutPoint): GestureResult {
    if (!finitePoint(pointer)) return invalidGesture('A resize requires finite pointer coordinates.');
    const guard = layoutCommands.canMove(this.session, node);
    if (!guard.ok) return guard;
    const locator = this.session.locatorFor(node.id);
    const box = this.frame.boxes.get(node.id);
    if (locator === null || box === undefined || findElement(this.session.document.root, node.id) !== node) {
      return invalidGesture('A resize requires a current source-backed node and preview box.', node.id);
    }
    this.gesture = {
      kind: 'resize',
      locator,
      pointer: freezePoint(pointer),
      box,
      coalesceKey: nextCoalesceKey('resize'),
      lastPoint: null,
    };
    return Object.freeze({ ok: true });
  }

  update(pointer: LayoutPoint): GestureResult {
    if (this.gesture === null) return invalidGesture('No manipulation gesture is active.');
    if (!finitePoint(pointer)) return invalidGesture('A manipulation update requires finite pointer coordinates.');
    if (samePoint(this.gesture.lastPoint, pointer)) return Object.freeze({ ok: true });
    const nodeId = resolveElementLocator(this.session.document.root, this.gesture.locator);
    const node = nodeId === null ? null : findElement(this.session.document.root, nodeId);
    if (node === null) return invalidGesture('The manipulated node no longer resolves uniquely.');
    const result = this.gesture.kind === 'move'
      ? this.updateMove(node, pointer, this.gesture)
      : this.updateResize(node, pointer, this.gesture);
    if (!result.ok) return result;
    this.gesture.lastPoint = freezePoint(pointer);
    return result;
  }

  finish(): void {
    this.gesture = null;
  }

  cancel(): void {
    this.gesture = null;
  }

  private updateMove(node: EditorElement, pointer: LayoutPoint, gesture: MoveGesture): GestureResult {
    const requested = {
      x: gesture.box.left + pointer.x - gesture.pointer.x,
      y: gesture.box.top + pointer.y - gesture.pointer.y,
    };
    const snapped = snapPosition(gesture.box, requested, gesture.targets, this.snapThreshold);
    const result = layoutCommands.move(this.session, node, {
      x: gesture.authoredLeft + snapped.x - gesture.box.left,
      y: gesture.authoredTop + snapped.y - gesture.box.top,
    }, { coalesceKey: gesture.coalesceKey });
    return this.execute(result, snapped.guides);
  }

  private updateResize(node: EditorElement, pointer: LayoutPoint, gesture: ResizeGesture): GestureResult {
    const result = layoutCommands.resize(this.session, node, {
      width: Math.max(0, gesture.box.width + pointer.x - gesture.pointer.x),
      height: Math.max(0, gesture.box.height + pointer.y - gesture.pointer.y),
    }, { coalesceKey: gesture.coalesceKey });
    return this.execute(result);
  }

  private execute(result: LayoutCommandResult, guides?: readonly SnapGuide[]): GestureResult {
    if (!result.ok) return result;
    try {
      this.session.history.execute(result.transaction);
      this.onCommit();
      return Object.freeze({ ok: true, ...(guides === undefined ? {} : { guides }) });
    } catch (error) {
      return invalidGesture(error instanceof Error ? error.message : 'The manipulation transaction was refused.');
    }
  }
}

export function snapPosition(
  movingBox: RenderFrameBox,
  requested: LayoutPoint,
  targets: readonly RenderFrameBox[],
  threshold = 5,
): SnapResult {
  const x = closestSnap(
    [requested.x, requested.x + movingBox.width / 2, requested.x + movingBox.width],
    targets.flatMap((box) => [box.left, box.left + box.width / 2, box.left + box.width]),
    threshold,
  );
  const y = closestSnap(
    [requested.y, requested.y + movingBox.height / 2, requested.y + movingBox.height],
    targets.flatMap((box) => [box.top, box.top + box.height / 2, box.top + box.height]),
    threshold,
  );
  return Object.freeze({
    x: requested.x + (x?.delta ?? 0),
    y: requested.y + (y?.delta ?? 0),
    guides: Object.freeze([
      ...(x === null ? [] : [{ axis: 'x' as const, value: x.target }]),
      ...(y === null ? [] : [{ axis: 'y' as const, value: y.target }]),
    ]),
  });
}

function closestSnap(
  moving: readonly number[],
  targets: readonly number[],
  threshold: number,
): { readonly delta: number; readonly target: number } | null {
  if (!finiteNonNegative(threshold)) return null;
  let closest: { readonly delta: number; readonly target: number } | null = null;
  for (const from of moving) {
    for (const target of targets) {
      const delta = target - from;
      if (Math.abs(delta) > threshold) continue;
      if (
        closest === null
        || Math.abs(delta) < Math.abs(closest.delta)
        || (Math.abs(delta) === Math.abs(closest.delta) && target < closest.target)
      ) closest = { delta, target };
    }
  }
  return closest;
}

function snapTargets(root: EditorElement, node: EditorElement, frame: PreviewFrame): readonly RenderFrameBox[] {
  const parent = parentOf(root, node);
  if (parent === null) return Object.freeze([]);
  return Object.freeze([parent, ...parent.children.filter((child) => child.id !== node.id)]
    .flatMap((candidate) => {
      const box = frame.boxes.get(candidate.id);
      return box === undefined ? [] : [box];
    }));
}

function parentOf(root: EditorElement, node: EditorElement): EditorElement | null {
  for (const child of root.children) {
    if (child.id === node.id) return root;
    const nested = parentOf(child, node);
    if (nested !== null) return nested;
  }
  return null;
}

function findElement(root: EditorElement, id: EditorElement['id']): EditorElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const nested = findElement(child, id);
    if (nested !== null) return nested;
  }
  return null;
}

function computedPixels(session: DocumentSession, node: EditorElement, property: 'left' | 'top'): number | null {
  const value = session.adapter.explain(session.document, node.id, property)?.computed.value;
  const match = value === null || value === undefined ? null : /^(-?(?:\d+|\d*\.\d+))px$/.exec(value);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function nextCoalesceKey(kind: string): string {
  gestureSequence += 1;
  return `canvas:${kind}:${gestureSequence}`;
}

function freezePoint(point: LayoutPoint): LayoutPoint {
  return Object.freeze({ x: point.x, y: point.y });
}

function finitePoint(point: LayoutPoint | null | undefined): point is LayoutPoint {
  return point !== null && point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function finiteNonNegative(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function samePoint(left: LayoutPoint | null, right: LayoutPoint): boolean {
  return left !== null && left.x === right.x && left.y === right.y;
}

function invalidGesture(message: string, nodeId?: EditorElement['id']): LayoutCommandFailure {
  const diagnostic: LayoutDiagnostic = Object.freeze({
    code: 'AMBIGUOUS_LAYOUT_WRITE',
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
  });
  return Object.freeze({ ok: false, diagnostic });
}
