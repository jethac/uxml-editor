import type { EditorElement } from '../adapter/types';

export function walkElements(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walkElements)];
}

export function lineageTo(
  root: EditorElement,
  target: EditorElement,
): readonly EditorElement[] | null {
  if (root.id === target.id) return [root];
  for (const child of root.children) {
    const descendants = lineageTo(child, target);
    if (descendants !== null) return [root, ...descendants];
  }
  return null;
}

export function parentOf(root: EditorElement, target: EditorElement): EditorElement | null {
  for (const child of root.children) {
    if (child.id === target.id) return root;
    const found = parentOf(child, target);
    if (found !== null) return found;
  }
  return null;
}

export function containsElement(root: EditorElement, target: EditorElement): boolean {
  return root.id === target.id || root.children.some((child) => containsElement(child, target));
}
