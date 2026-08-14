import {
  explainProperty,
  loadLayoutEngine,
  parse,
  render as renderPreview,
  serialize,
} from 'uxml-preview';
import type {
  Candidate,
  ElementNode,
  NodeId,
  SourceRef,
  StyleOrigin,
  UxmlDocument,
  Warning,
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
  StyleExplanation,
  StyleExplanationOrigin,
  UxmlPreviewPort,
} from './types';

const documentModels = new WeakMap<ParsedPreviewDocument, UxmlDocument>();
const documentNodes = new WeakMap<ParsedPreviewDocument, ReadonlyMap<EditorNodeId, ElementNode>>();
let layoutEnginePromise: Promise<void> | undefined;

function editorNodeId(nodeId: NodeId): EditorNodeId {
  return String(nodeId) as EditorNodeId;
}

function loadLayoutEngineOnce(): Promise<void> {
  layoutEnginePromise ??= loadLayoutEngine();
  return layoutEnginePromise;
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
  return {
    id,
    name: node.name.prefix === null ? node.name.local : `${node.name.prefix}:${node.name.local}`,
    source: { path: uxmlPath, ...node.spans.openTag },
    children: node.children.map((child) => toEditorElement(child, uxmlPath, nodes)),
  };
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

function sourceForNode(
  nodeId: NodeId | undefined,
  input: import('./types').ProjectParseInput,
  nodes: ReadonlyMap<EditorNodeId, ElementNode>,
): EditorSourceSpan | undefined {
  if (nodeId === undefined) {
    return undefined;
  }

  const node = nodes.get(editorNodeId(nodeId));
  return node === undefined ? undefined : { path: input.uxmlPath, ...node.spans.openTag };
}

function diagnosticFromWarning(
  warning: Warning,
  origin: EditorDiagnostic['origin'],
  input: import('./types').ProjectParseInput,
  originsBySheet: readonly (string | null)[],
  nodes: ReadonlyMap<EditorNodeId, ElementNode>,
): EditorDiagnostic {
  const nodeId = warning.node === undefined ? undefined : editorNodeId(warning.node);
  return {
    origin,
    severity: 'warning',
    kind: warning.kind as EditorDiagnosticKind,
    message: warning.message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(warning.at === undefined
      ? { source: sourceForNode(warning.node, input, nodes) }
      : { source: sourceForReference(warning.at, input, originsBySheet) }),
  };
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

function editorStyleOrigin(
  origin: StyleOrigin,
  model: UxmlDocument,
  originsBySheet: readonly (string | null)[],
): StyleExplanationOrigin {
  switch (origin.kind) {
    case 'inline':
      return {
        kind: 'inline',
        nodeId: editorNodeId(origin.node),
        declarationIndex: origin.declIndex,
      };
    case 'rule':
      return {
        kind: 'rule',
        source: sourceForRuleOrigin(origin, model, originsBySheet),
        sheetPath: originsBySheet[origin.sheet] ?? null,
        itemIndex: origin.item,
        declarationIndex: origin.declIndex,
        ...(origin.states === undefined ? {} : { states: [...origin.states] }),
      };
    case 'inherited':
      return {
        kind: 'inherited',
        from: editorNodeId(origin.from),
        origin: editorStyleOrigin(origin.origin, model, originsBySheet),
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
): StyleCandidate {
  return {
    property: candidate.property,
    value: candidate.value,
    origin: editorStyleOrigin(candidate.origin, model, originsBySheet),
    rank: candidate.rank === 1 ? 'author' : 'builtin-theme',
    specificity: [...candidate.specificity] as [number, number, number],
    order: candidate.order,
    winner: candidate.winner,
  };
}

export class UxmlPreviewAdapter implements UxmlPreviewPort {
  private activeFrame: PreviewFrame | undefined;

  parseProject(input: import('./types').ProjectParseInput): ParsedPreviewDocument {
    const source = cloneInput(input);
    const resolvedOrigins: string[] = [];
    const model = parse(source.uxml, undefined, {
      resolveImport: (url, from) => {
        const fromBuffers = source.stylesheets.get(url);
        const resolved = fromBuffers === undefined
          ? source.resolveImport(url, from)
          : { path: url, text: fromBuffers };
        if (resolved !== null) {
          resolvedOrigins.push(resolved.path);
        }
        return resolved?.text ?? null;
      },
    });
    const originsBySheet = model.sheets.map((_, index) => resolvedOrigins[index] ?? null);
    const nodes = new Map<EditorNodeId, ElementNode>();
    const root = toEditorElement(model.root, source.uxmlPath, nodes);
    const document: ParsedPreviewDocument = {
      source,
      root,
      originsBySheet,
      diagnostics: model.warnings.map((warning) => diagnosticFromWarning(
        warning,
        'parse',
        source,
        originsBySheet,
        nodes,
      )),
    };
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
    await loadLayoutEngineOnce();
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
  ): StyleExplanation | null {
    const node = this.nodesFor(document).get(nodeId);
    if (node === undefined) {
      return null;
    }

    const model = this.modelFor(document);
    return {
      nodeId,
      property,
      candidates: explainProperty(model, node, property).map((candidate) => editorCandidate(
        candidate,
        model,
        document.originsBySheet,
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
