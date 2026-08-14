import { ImmutableMap } from '../collections/ImmutableMap';
import type {
  EditorDiagnostic,
  EditorElement,
  EditorSourceSpan,
  ParsedPreviewDocument,
  ProjectParseInput,
} from './types';

export function freezeParsedPreviewDocument(document: ParsedPreviewDocument): ParsedPreviewDocument {
  if (Object.isFrozen(document)) {
    if (isDeepFrozenDocument(document)) return document;
    throw new TypeError('A frozen parsed preview document must already be deeply immutable.');
  }

  const mutable = document as Mutable<ParsedPreviewDocument>;
  mutable.source = freezeSource(document.source);
  mutable.root = freezeElement(document.root);
  mutable.diagnostics = Object.freeze(document.diagnostics.map(freezeDiagnostic));
  mutable.originsBySheet = Object.freeze([...document.originsBySheet]);
  return Object.freeze(document);
}

function isDeepFrozenDocument(document: ParsedPreviewDocument): boolean {
  return Object.isFrozen(document.source)
    && document.source.stylesheets instanceof ImmutableMap
    && Object.isFrozen(document.source.stylesheets)
    && isDeepFrozenElement(document.root)
    && Object.isFrozen(document.diagnostics)
    && document.diagnostics.every((diagnostic) => Object.isFrozen(diagnostic)
      && (diagnostic.source === undefined || Object.isFrozen(diagnostic.source)))
    && Object.isFrozen(document.originsBySheet);
}

function isDeepFrozenElement(element: EditorElement): boolean {
  return Object.isFrozen(element)
    && Object.isFrozen(element.source)
    && Object.isFrozen(element.attributes)
    && element.attributes.every((attribute) => Object.isFrozen(attribute) && Object.isFrozen(attribute.source))
    && Object.isFrozen(element.children)
    && element.children.every(isDeepFrozenElement);
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
