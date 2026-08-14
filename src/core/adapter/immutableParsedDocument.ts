import { ImmutableMap } from '../collections/ImmutableMap';
import type {
  EditorDiagnostic,
  EditorElement,
  EditorSourceSpan,
  ParsedPreviewDocument,
  ProjectParseInput,
} from './types';

export function freezeParsedPreviewDocument(document: ParsedPreviewDocument): ParsedPreviewDocument {
  if (Object.isFrozen(document)) return document;

  const mutable = document as Mutable<ParsedPreviewDocument>;
  mutable.source = freezeSource(document.source);
  mutable.root = freezeElement(document.root);
  mutable.diagnostics = Object.freeze(document.diagnostics.map(freezeDiagnostic));
  mutable.originsBySheet = Object.freeze([...document.originsBySheet]);
  return Object.freeze(document);
}

function freezeSource(source: Readonly<ProjectParseInput>): Readonly<ProjectParseInput> {
  return Object.freeze({
    uxmlPath: source.uxmlPath,
    uxml: source.uxml,
    stylesheets: new ImmutableMap(source.stylesheets),
    resolveImport: source.resolveImport,
  });
}

function freezeElement(element: EditorElement): EditorElement {
  return Object.freeze({
    id: element.id,
    name: element.name,
    source: freezeSpan(element.source),
    attributes: Object.freeze(element.attributes.map((attribute) => Object.freeze({
      name: attribute.name,
      value: attribute.value,
      source: freezeSpan(attribute.source),
    }))),
    children: Object.freeze(element.children.map(freezeElement)),
  });
}

function freezeDiagnostic(diagnostic: EditorDiagnostic): EditorDiagnostic {
  return Object.freeze({
    origin: diagnostic.origin,
    severity: diagnostic.severity,
    kind: diagnostic.kind,
    message: diagnostic.message,
    ...(diagnostic.source === undefined ? {} : { source: freezeSpan(diagnostic.source) }),
    ...(diagnostic.nodeId === undefined ? {} : { nodeId: diagnostic.nodeId }),
  });
}

function freezeSpan(span: EditorSourceSpan): EditorSourceSpan {
  return Object.freeze({ path: span.path, start: span.start, end: span.end });
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
