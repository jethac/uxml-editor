import type { EditorElement, EditorNodeId } from '../adapter/types';

export interface ElementAttributeHint {
  readonly name: string;
  readonly value: string;
}

export interface ElementLocator {
  readonly authoredName?: string;
  readonly childPath: readonly number[];
  readonly qualifiedTag: string;
  readonly ancestorTags: readonly string[];
  readonly attributeHints: readonly ElementAttributeHint[];
}

interface LocatedElement {
  readonly element: EditorElement;
  readonly childPath: readonly number[];
  readonly ancestorTags: readonly string[];
}

export function createElementLocator(root: EditorElement, nodeId: EditorNodeId): ElementLocator | null {
  const found = listElements(root).find((candidate) => candidate.element.id === nodeId);
  if (!found) return null;
  const authoredName = found.element.attributes.find((attribute) => attribute.name === 'name')?.value;
  return Object.freeze({
    qualifiedTag: found.element.name,
    childPath: Object.freeze([...found.childPath]),
    ancestorTags: Object.freeze([...found.ancestorTags]),
    attributeHints: Object.freeze(found.element.attributes.map((attribute) => Object.freeze({
      name: attribute.name,
      value: attribute.value,
    }))),
    ...(authoredName === undefined ? {} : { authoredName }),
  });
}

export function resolveElementLocator(root: EditorElement, locator: ElementLocator): EditorNodeId | null {
  const candidates = listElements(root);
  if (locator.authoredName !== undefined) {
    const named = candidates.filter(({ element }) => element.attributes.some((attribute) =>
      attribute.name === 'name' && attribute.value === locator.authoredName,
    ));
    if (named.length === 1) return named[0].element.id;
  }

  const direct = candidates.find((candidate) => equalPath(candidate.childPath, locator.childPath));
  if (direct && matchesStructure(direct, locator)) return direct.element.id;

  const matches = candidates.filter((candidate) => matchesLocator(candidate, locator));
  return matches.length === 1 ? matches[0].element.id : null;
}

function listElements(root: EditorElement): readonly LocatedElement[] {
  const result: LocatedElement[] = [];
  const visit = (element: EditorElement, childPath: readonly number[], ancestorTags: readonly string[]) => {
    result.push({ element, childPath, ancestorTags });
    element.children.forEach((child, index) => visit(child, [...childPath, index], [...ancestorTags, element.name]));
  };
  visit(root, [], []);
  return result;
}

function matchesLocator(candidate: LocatedElement, locator: ElementLocator): boolean {
  return matchesStructure(candidate, locator)
    && locator.attributeHints.every((hint) => candidate.element.attributes.some((attribute) =>
      attribute.name === hint.name && attribute.value === hint.value,
    ));
}

function matchesStructure(candidate: LocatedElement, locator: ElementLocator): boolean {
  return candidate.element.name === locator.qualifiedTag
    && equalPath(candidate.ancestorTags, locator.ancestorTags);
}

function equalPath(left: readonly (string | number)[], right: readonly (string | number)[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
