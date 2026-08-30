import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import type { EditorElement } from '../adapter/types';
import { DocumentSession } from '../documents/DocumentSession';
import type { ElementLocator } from '../documents/ElementLocator';

export const entryPath = 'Assets/UI/screen.uxml';

export function openSession(uxml: string): DocumentSession {
  return DocumentSession.open(new Map([[entryPath, uxml]]), entryPath, new UxmlPreviewAdapter());
}

export function locatorNamed(session: DocumentSession, qualifiedTag: string): ElementLocator {
  const element = walk(session.document.root).find((candidate) => candidate.name === qualifiedTag);
  if (!element) throw new Error(`Missing fixture element ${qualifiedTag}.`);
  const locator = session.locatorFor(element.id);
  if (!locator) throw new Error(`Missing locator for ${qualifiedTag}.`);
  return locator;
}

export function locatorWithName(session: DocumentSession, authoredName: string): ElementLocator {
  const element = walk(session.document.root).find((candidate) =>
    candidate.attributes.some((attribute) => attribute.name === 'name' && attribute.value === authoredName),
  );
  if (!element) throw new Error(`Missing fixture element named ${authoredName}.`);
  const locator = session.locatorFor(element.id);
  if (!locator) throw new Error(`Missing locator for ${authoredName}.`);
  return locator;
}

function walk(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(walk)];
}
