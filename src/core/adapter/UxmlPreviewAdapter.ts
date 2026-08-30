import {
  explainProperty,
  loadLayoutEngine,
  parse,
  render as renderPreview,
  resolveStyles,
  serialize,
  supportedControlNames as previewSupportedControlNames,
} from 'uxml-preview';
import type {
  Candidate,
  ElementNode,
  NodeId,
  SourceRef,
  StyleOrigin,
  UxmlDocument,
  Warning,
  WarningKindMap,
} from 'uxml-preview';
import type {
  EditorDiagnostic,
  EditorDiagnosticKind,
  EditorElement,
  EditorNodeId,
  EditorSourceSpan,
  ParsedPreviewDocument,
  PreviewFrame,
  PreviewRenderOptions,
  SerializedProject,
  StyleCandidate,
  StyleExplanationOptions,
  StyleExplanation,
  StyleExplanationOrigin,
  EditorStylesheet,
  UssSourcePort,
  UxmlPreviewPort,
} from './types';
import { freezeParsedPreviewDocument } from './immutableParsedDocument';
import { editorStylesheetFromParsed, parseEditorDeclarationList } from './UssSourceAdapter';
import { isKnownUssProperty } from '../uss/ussProperties';

const documentModels = new WeakMap<ParsedPreviewDocument, UxmlDocument>();
const documentNodes = new WeakMap<ParsedPreviewDocument, ReadonlyMap<EditorNodeId, ElementNode>>();
let layoutEnginePromise: Promise<void> | undefined;
const EMPTY_UXML = '<ui:UXML xmlns:ui="UnityEngine.UIElements" />';
const INLINE_SELECTOR = '__inline__';

function editorNodeId(nodeId: NodeId): EditorNodeId {
  return String(nodeId) as EditorNodeId;
}

function loadLayoutEngineOnce(): Promise<void> {
  layoutEnginePromise ??= loadLayoutEngine();
  return layoutEnginePromise;
}

function isRootFixedUrl(url: string): boolean {
  return url.startsWith('project://') || url.startsWith('/');
}

function cloneInput(input: import('./types').ProjectParseInput): import('./types').ProjectParseInput {
  return {
    ...input,
    stylesheets: new Map(input.stylesheets),
  };
}

function toEditorElement(
  node: ElementNode,
  uxmlPath: string,
  nodes: Map<EditorNodeId, ElementNode>,
): EditorElement {
  const id = editorNodeId(node.id);
  nodes.set(id, node);
  return Object.freeze({
    id,
    name: node.name.prefix === null ? node.name.local : `${node.name.prefix}:${node.name.local}`,
    source: Object.freeze({ path: uxmlPath, ...node.spans.openTag }),
    spans: Object.freeze({
      openTag: Object.freeze({ path: uxmlPath, ...node.spans.openTag }),
      inner: Object.freeze({ path: uxmlPath, ...node.spans.inner }),
      closeTag: node.spans.closeTag === null
        ? null
        : Object.freeze({ path: uxmlPath, ...node.spans.closeTag }),
    }),
    attributes: Object.freeze(node.attributes.map((attribute) => Object.freeze({
      name: attribute.name,
      value: attribute.value,
      source: Object.freeze({ path: uxmlPath, ...attribute.span }),
    }))),
    children: Object.freeze(node.children.map((child) => toEditorElement(child, uxmlPath, nodes))),
  });
}

function sourceForReference(
  reference: SourceRef,
  input: import('./types').ProjectParseInput,
  originsBySheet: readonly (string | null)[],
): EditorSourceSpan | undefined {
  if (reference.in === 'uxml') {
    return { path: input.uxmlPath, ...reference.span };
  }

  const path = originsBySheet[reference.sheet];
  return path === null || path === undefined ? undefined : { path, ...reference.span };
}

/**
 * Every engine warning kind, named once, so a kind the engine gains has to be
 * classified here rather than reaching the UI as an unknown label.
 */
const DIAGNOSTIC_KINDS: WarningKindMap<EditorDiagnosticKind> = {
  'unsupported-control': 'unsupported-control',
  'unsupported-property': 'unsupported-property',
  'unsupported-selector': 'unsupported-selector',
  'unsupported-unit': 'unsupported-unit',
  'version-dependent': 'version-dependent',
  'asset-unresolved': 'asset-unresolved',
  'import-unresolved': 'import-unresolved',
  malformed: 'malformed',
  'template-src-unresolved': 'template-src-unresolved',
  'template-not-declared': 'template-not-declared',
  'template-cycle': 'template-cycle',
  'template-depth-exceeded': 'template-depth-exceeded',
  'template-slot-unsupported': 'template-slot-unsupported',
  'override-target-missing': 'override-target-missing',
  'override-style-ignored': 'override-style-ignored',
  'duplicate-name-in-tree': 'duplicate-name-in-tree',
  'package-path-not-searched': 'package-path-not-searched',
};

function diagnosticFromWarning(
  warning: Warning,
  origin: EditorDiagnostic['origin'],
  input: import('./types').ProjectParseInput,
  originsBySheet: readonly (string | null)[],
  nodes: ReadonlyMap<EditorNodeId, ElementNode>,
): EditorDiagnostic {
  const nodeId = warning.node === undefined ? undefined : editorNodeId(warning.node);
  const source = warning.at === undefined
    ? undefined
    : sourceForReference(warning.at, input, originsBySheet);
  return {
    origin,
    severity: 'warning',
    kind: DIAGNOSTIC_KINDS[warning.kind],
    message: warning.message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(source === undefined ? {} : { source }),
  };
}

function unknownPropertyDiagnostic(
  property: string,
  source: EditorSourceSpan | undefined,
  nodeId: EditorNodeId | undefined,
): EditorDiagnostic {
  return {
    origin: 'parse',
    severity: 'warning',
    kind: 'unsupported-property',
    message: `${property} is not a USS property; Unity drops the declaration`,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(source === undefined ? {} : { source }),
  };
}

/**
 * Unity's importer drops a declaration whose property it does not recognize, so
 * the preview silently matches Unity while the author sees nothing at all. The
 * preview engine only warns about CSS properties it knows USS lacks, and only
 * once a rule matches an element; this covers every misspelling, in every rule.
 */
function unknownSheetPropertyDiagnostics(
  model: UxmlDocument,
  originsBySheet: readonly (string | null)[],
): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  model.sheets.forEach((sheet, sheetIndex) => {
    const path = originsBySheet[sheetIndex] ?? null;
    for (const item of sheet.items) {
      if (item.kind !== 'rule') continue;
      for (const declaration of item.rule.declarations) {
        if (isKnownUssProperty(declaration.property)) continue;
        diagnostics.push(unknownPropertyDiagnostic(
          declaration.property,
          path === null ? undefined : { path, ...declaration.span },
          undefined,
        ));
      }
    }
  });
  return diagnostics;
}

function unknownInlinePropertyDiagnostics(
  input: import('./types').ProjectParseInput,
  nodes: ReadonlyMap<EditorNodeId, ElementNode>,
): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  for (const [nodeId, node] of nodes) {
    const style = node.attributes.find((attribute) => attribute.name === 'style');
    if (style === undefined) continue;
    const sheet = parse(EMPTY_UXML, `${INLINE_SELECTOR} {${style.value}}`).sheets[0];
    const item = sheet?.items[0];
    if (item?.kind !== 'rule') continue;
    for (const declaration of item.rule.declarations) {
      if (isKnownUssProperty(declaration.property)) continue;
      diagnostics.push(unknownPropertyDiagnostic(
        declaration.property,
        { path: input.uxmlPath, ...style.span },
        nodeId,
      ));
    }
  }
  return diagnostics;
}

function sourceForRuleOrigin(
  origin: Extract<StyleOrigin, { kind: 'rule' }>,
  model: UxmlDocument,
  originsBySheet: readonly (string | null)[],
): EditorSourceSpan | undefined {
  const item = model.sheets[origin.sheet]?.items[origin.item];
  if (item?.kind !== 'rule') {
    return undefined;
  }

  const declaration = item.rule.declarations[origin.declIndex];
  const path = originsBySheet[origin.sheet];
  return declaration === undefined || path === null || path === undefined
    ? undefined
    : { path, ...declaration.span };
}

function sourceForInlineOrigin(
  origin: Extract<StyleOrigin, { kind: 'inline' }>,
  input: import('./types').ProjectParseInput,
  nodes: ReadonlyMap<EditorNodeId, ElementNode>,
): EditorSourceSpan | undefined {
  const node = nodes.get(editorNodeId(origin.node));
  const style = node?.attributes.find((attribute) => attribute.name === 'style');
  return style === undefined ? undefined : { path: input.uxmlPath, ...style.span };
}

function editorStyleOrigin(
  origin: StyleOrigin,
  model: UxmlDocument,
  originsBySheet: readonly (string | null)[],
  input: import('./types').ProjectParseInput,
  nodes: ReadonlyMap<EditorNodeId, ElementNode>,
): StyleExplanationOrigin {
  switch (origin.kind) {
    case 'inline': {
      const source = sourceForInlineOrigin(origin, input, nodes);
      return {
        kind: 'inline',
        nodeId: editorNodeId(origin.node),
        declarationIndex: origin.declIndex,
        ...(source === undefined ? {} : { source }),
      };
    }
    case 'rule': {
      const source = sourceForRuleOrigin(origin, model, originsBySheet);
      return {
        kind: 'rule',
        ...(source === undefined ? {} : { source }),
        sheetPath: originsBySheet[origin.sheet] ?? null,
        sheetIndex: origin.sheet,
        itemIndex: origin.item,
        declarationIndex: origin.declIndex,
        ...(origin.states === undefined ? {} : { states: [...origin.states] }),
      };
    }
    case 'inherited':
      return {
        kind: 'inherited',
        from: editorNodeId(origin.from),
        origin: editorStyleOrigin(origin.origin, model, originsBySheet, input, nodes),
      };
    case 'builtin-theme':
      return {
        kind: 'builtin-theme',
        selector: origin.selector,
        property: origin.property,
        unityVersion: origin.unityVersion,
      };
    case 'default':
      return { kind: 'default' };
  }
}

function editorCandidate(
  candidate: Candidate,
  model: UxmlDocument,
  originsBySheet: readonly (string | null)[],
  input: import('./types').ProjectParseInput,
  nodes: ReadonlyMap<EditorNodeId, ElementNode>,
): StyleCandidate {
  return {
    property: candidate.property,
    value: candidate.value,
    origin: editorStyleOrigin(candidate.origin, model, originsBySheet, input, nodes),
    rank: candidate.rank === 1 ? 'author' : 'builtin-theme',
    specificity: [...candidate.specificity] as [number, number, number],
    order: candidate.order,
    winner: candidate.winner,
  };
}

export class RenderSupersededError extends Error {
  constructor() {
    super('Render request was superseded by a newer request.');
    this.name = 'RenderSupersededError';
  }
}

export class UxmlPreviewAdapter implements UxmlPreviewPort, UssSourcePort {
  private activeFrame: PreviewFrame | undefined;
  private renderGeneration = 0;

  supportedControlNames(): readonly string[] {
    return Object.freeze([...previewSupportedControlNames()]);
  }

  parseStylesheet(path: string, source: string): EditorStylesheet {
    return editorStylesheetFromParsed(path, parse(EMPTY_UXML, source).sheets[0]);
  }

  parseDeclarationList(path: string, source: string, start: number, end: number) {
    const prefix = `${INLINE_SELECTOR} {`;
    const sheet = editorStylesheetFromParsed(
      path,
      parse(EMPTY_UXML, `${prefix}${source.slice(start, end)}}`).sheets[0],
    );
    return parseEditorDeclarationList(path, sheet.rules[0]?.declarations ?? [], start);
  }

  parseProject(input: import('./types').ProjectParseInput): ParsedPreviewDocument {
    const initialSource = cloneInput(input);
    const loadedStylesheets = new Map(initialSource.stylesheets);
    const source = { ...initialSource, stylesheets: loadedStylesheets };
    const resolvedOrigins: string[] = [];
    const model = parse(source.uxml, undefined, {
      resolveImport: (url, from) => {
        const buffer = source.stylesheets.get(url);
        const resolved = buffer !== undefined && (from === null || isRootFixedUrl(url))
          ? { path: url, text: buffer }
          : source.resolveImport(url, from);
        if (resolved !== null) {
          resolvedOrigins.push(resolved.path);
          loadedStylesheets.set(resolved.path, resolved.text);
        }
        return resolved?.text ?? null;
      },
    });
    const originsBySheet = model.sheets.map((_, index) => resolvedOrigins[index] ?? null);
    const nodes = new Map<EditorNodeId, ElementNode>();
    const root = toEditorElement(model.root, source.uxmlPath, nodes);
    const document = freezeParsedPreviewDocument({
      source,
      root,
      originsBySheet,
      localStyleSheetIndices: [...new Set((model.styleRoots ?? []).map((root) => root.sheet))],
      diagnostics: [
        ...model.warnings.map((warning) => diagnosticFromWarning(
          warning,
          'parse',
          source,
          originsBySheet,
          nodes,
        )),
        ...unknownSheetPropertyDiagnostics(model, originsBySheet),
        ...unknownInlinePropertyDiagnostics(source, nodes),
      ],
    });
    documentModels.set(document, model);
    documentNodes.set(document, nodes);
    return document;
  }

  serializeEntry(document: ParsedPreviewDocument): SerializedProject {
    const model = this.modelFor(document);
    const serialized = serialize(model);
    return {
      uxml: serialized.uxml,
      // Imported sheets are separate sources; their original buffers remain authoritative.
      stylesheets: new Map(document.source.stylesheets),
    };
  }

  async render(
    document: ParsedPreviewDocument,
    container: HTMLElement,
    options: PreviewRenderOptions,
  ): Promise<PreviewFrame> {
    const model = this.modelFor(document);
    const nodes = this.nodesFor(document);
    const generation = ++this.renderGeneration;
    await loadLayoutEngineOnce();
    if (generation !== this.renderGeneration) {
      throw new RenderSupersededError();
    }
    this.activeFrame?.dispose();

    const result = renderPreview(model, container, options);
    const elements = new Map<EditorNodeId, HTMLElement>();
    const boxes = new Map<EditorNodeId, { left: number; top: number; width: number; height: number }>();
    const elementNodes = new Map<Element, EditorNodeId>();
    for (const [nodeId, element] of result.elements) {
      const id = editorNodeId(nodeId);
      elements.set(id, element);
      elementNodes.set(element, id);
    }
    for (const [nodeId, box] of result.boxes) {
      boxes.set(editorNodeId(nodeId), { ...box });
    }

    let disposed = false;
    const frame: PreviewFrame = {
      elements,
      boxes,
      diagnostics: result.warnings.map((warning) => diagnosticFromWarning(
        warning,
        'render',
        document.source,
        document.originsBySheet,
        nodes,
      )),
      nodeForElement: (element) => elementNodes.get(element) ?? null,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        result.dispose();
        if (this.activeFrame === frame) {
          this.activeFrame = undefined;
        }
      },
    };
    this.activeFrame = frame;
    return frame;
  }

  explain(
    document: ParsedPreviewDocument,
    nodeId: EditorNodeId,
    property: string,
    options?: StyleExplanationOptions,
  ): StyleExplanation | null {
    const nodes = this.nodesFor(document);
    const node = nodes.get(nodeId);
    if (node === undefined) {
      return null;
    }

    const model = this.modelFor(document);
    const computed = resolveStyles(model, options).styles.get(node.id)?.get(property);
    return {
      nodeId,
      property,
      computed: computed === undefined
        ? { value: null, origin: { kind: 'default' } }
        : {
          value: computed.value,
          origin: editorStyleOrigin(
            computed.origin,
            model,
            document.originsBySheet,
            document.source,
            nodes,
          ),
        },
      candidates: explainProperty(model, node, property, options).map((candidate) => editorCandidate(
        candidate,
        model,
        document.originsBySheet,
        document.source,
        nodes,
      )),
    };
  }

  private modelFor(document: ParsedPreviewDocument): UxmlDocument {
    const model = documentModels.get(document);
    if (model === undefined) {
      throw new TypeError('The parsed document was not created by this adapter.');
    }
    return model;
  }

  private nodesFor(document: ParsedPreviewDocument): ReadonlyMap<EditorNodeId, ElementNode> {
    const nodes = documentNodes.get(document);
    if (nodes === undefined) {
      throw new TypeError('The parsed document was not created by this adapter.');
    }
    return nodes;
  }
}
