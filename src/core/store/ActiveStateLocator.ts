import type { EditorElement, EditorNodeId } from '../adapter/types';
import { resolveElementLocator, type ElementLocator } from '../documents/ElementLocator';
import type { EditorActiveStateEntry } from './EditorStoreContracts';

export function resolveActiveStateLocator(root: EditorElement, locator: ElementLocator): EditorNodeId | null {
  if (locator.authoredName === undefined) return null;
  const named = listElements(root).filter((element) => element.attributes.some((attribute) =>
    attribute.name === 'name' && attribute.value === locator.authoredName
  ));
  if (named.length !== 1 || named[0].name !== locator.qualifiedTag) return null;
  const resolved = resolveElementLocator(root, locator);
  return resolved === named[0].id ? resolved : null;
}

export function activeStateEntryFor(
  root: EditorElement,
  entries: readonly EditorActiveStateEntry[],
  locator: ElementLocator,
): EditorActiveStateEntry | undefined {
  const nodeId = resolveActiveStateLocator(root, locator);
  if (nodeId === null) return undefined;
  return entries.find((entry) => resolveActiveStateLocator(root, entry.locator) === nodeId);
}

function listElements(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(listElements)];
}
