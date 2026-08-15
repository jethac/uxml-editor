import type { EditorElement } from '../adapter/types';
import type { DocumentSession } from '../documents/DocumentSession';
import { resolveElementLocator } from '../documents/ElementLocator';
import {
  snapshotStyleTarget,
  styleTargetsFor,
  type StyleTarget,
} from '../documents/StyleTarget';
import { UssCommandError } from './ussCommandError';

export function revalidateStyleTarget<K extends StyleTarget['kind']>(
  session: DocumentSession,
  candidate: StyleTarget,
  kind: K,
): Extract<StyleTarget, { readonly kind: K }> {
  let target: StyleTarget;
  try {
    target = snapshotStyleTarget(candidate);
  } catch (error) {
    throw new UssCommandError('invalid-target', 'The style target could not be snapshotted safely.', error);
  }
  if (target.kind !== kind) {
    throw new UssCommandError('invalid-target', `This command requires a ${kind} style target.`);
  }

  const currentSources = [...session.snapshot().files]
    .map(([path, buffer]) => ({ path, text: buffer.text }))
    .sort((left, right) => compareExactPath(left.path, right.path));
  if (!equalSources(target.sessionSources, currentSources)) {
    throw new UssCommandError(
      'stale-target',
      'One or more document session source files changed after this style target was issued.',
    );
  }

  let resolved;
  try {
    resolved = resolveElementLocator(session.document.root, target.locator);
  } catch (error) {
    throw new UssCommandError('invalid-target', 'The requested style node locator is malformed.', error);
  }
  if (resolved === null || resolved !== target.nodeId) {
    throw new UssCommandError('stale-target', 'The requested style node no longer resolves to the same element.');
  }
  const node = findElement(session.document.root, resolved);
  if (node === null) {
    throw new UssCommandError('stale-target', 'The requested style node no longer exists in the current document.');
  }

  let issued: readonly StyleTarget[];
  try {
    issued = styleTargetsFor(session, node, target.property, target.state);
  } catch (error) {
    throw new UssCommandError(
      'stale-target',
      'The current document can no longer issue this style target for the requested node, property, and state.',
      error,
    );
  }
  const current = issued.find((item): item is Extract<StyleTarget, { readonly kind: K }> =>
    item.kind === kind && item.id === target.id
  );
  if (current === undefined) {
    throw new UssCommandError(
      'stale-target',
      'The supplied style target is not an exact member of the targets issued by the current cascade.',
    );
  }
  return current;
}

function equalSources(
  expected: readonly { readonly path: string; readonly text: string }[],
  current: readonly { readonly path: string; readonly text: string }[],
): boolean {
  return expected.length === current.length && expected.every((source, index) =>
    source.path === current[index].path && source.text === current[index].text
  );
}

function findElement(root: EditorElement, nodeId: string): EditorElement | null {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.id === nodeId) return current;
    pending.push(...current.children);
  }
  return null;
}

function compareExactPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
