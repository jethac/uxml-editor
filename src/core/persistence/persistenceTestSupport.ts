import type {
  EditorElement,
  EditorNodeId,
  ParsedPreviewDocument,
  ProjectParseInput,
  UxmlPreviewPort,
} from '../adapter/types';
import { DocumentSession } from '../documents/DocumentSession';

export class PersistenceTestAdapter implements UxmlPreviewPort {
  failWhenSourceIncludes: string | undefined;

  parseProject(input: ProjectParseInput): ParsedPreviewDocument {
    if (this.failWhenSourceIncludes !== undefined && input.uxml.includes(this.failWhenSourceIncludes)) {
      throw new Error('Injected persistence parse failure.');
    }
    const root = parseRoot(input.uxmlPath, input.uxml);
    return { source: { ...input, stylesheets: new Map(input.stylesheets) }, root, diagnostics: [], originsBySheet: [] };
  }

  serializeEntry(): never { throw new Error('Not used by persistence tests.'); }
  render(): Promise<never> { return Promise.reject(new Error('Not used by persistence tests.')); }
  explain(): null { return null; }
}

export function openTestSession(files: ReadonlyMap<string, string>, entryPath = 'Main.uxml', adapter = new PersistenceTestAdapter()): DocumentSession {
  return DocumentSession.open(files, entryPath, adapter);
}

function parseRoot(path: string, text: string): EditorElement {
  const openEnd = text.indexOf('>') + 1;
  if (openEnd === 0) throw new Error('Missing root element.');
  const paired = !text.slice(0, openEnd).trimEnd().endsWith('/>');
  const closeStart = paired ? text.lastIndexOf('</') : openEnd;
  const end = paired && closeStart >= openEnd ? text.indexOf('>', closeStart) + 1 : openEnd;
  return Object.freeze({
    id: 'root' as EditorNodeId,
    name: 'UXML',
    source: Object.freeze({ path, start: 0, end }),
    spans: Object.freeze({
      openTag: Object.freeze({ path, start: 0, end: openEnd }),
      inner: Object.freeze({ path, start: openEnd, end: paired ? closeStart : openEnd }),
      closeTag: paired
        ? Object.freeze({ path, start: closeStart, end })
        : null,
    }),
    attributes: Object.freeze([]),
    children: Object.freeze([]),
  });
}
