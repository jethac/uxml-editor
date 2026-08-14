export type EditorNodeId = string & {
  readonly __editorNodeId: unique symbol;
};

export interface EditorSourceSpan {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export interface ResolvedText {
  readonly path: string;
  readonly text: string;
}

export interface ProjectParseInput {
  readonly uxmlPath: string;
  readonly uxml: string;
  readonly stylesheets: ReadonlyMap<string, string>;
  readonly resolveImport: (url: string, from: string | null) => ResolvedText | null;
}

export type EditorDiagnosticKind =
  | 'unsupported-control'
  | 'unsupported-property'
  | 'unsupported-selector'
  | 'unsupported-unit'
  | 'version-dependent'
  | 'asset-unresolved'
  | 'import-unresolved'
  | 'malformed';

export interface EditorDiagnostic {
  readonly origin: 'parse' | 'render';
  readonly severity: 'warning';
  readonly kind: EditorDiagnosticKind;
  readonly message: string;
  readonly source?: EditorSourceSpan;
  readonly nodeId?: EditorNodeId;
}

export interface EditorAuthoredAttribute {
  readonly name: string;
  readonly value: string;
  readonly source: EditorSourceSpan;
}

export interface EditorElement {
  readonly id: EditorNodeId;
  readonly name: string;
  readonly source: EditorSourceSpan;
  readonly attributes: readonly EditorAuthoredAttribute[];
  readonly children: readonly EditorElement[];
}

export interface ParsedPreviewDocument {
  readonly source: Readonly<ProjectParseInput>;
  readonly root: EditorElement;
  readonly diagnostics: readonly EditorDiagnostic[];
  readonly originsBySheet: readonly (string | null)[];
}

export interface SerializedProject {
  readonly uxml: string;
  readonly stylesheets: ReadonlyMap<string, string>;
}

export interface PreviewSize {
  readonly width: number;
  readonly height: number;
}

export interface TextMeasurementContext {
  readonly fontSize: number;
  readonly fontStyle: string;
  readonly whiteSpace: string;
}

export interface TextMeasurement {
  readonly width: number;
  readonly height: number;
}

export type MeasurePreviewText = (
  text: string,
  context: TextMeasurementContext,
  availableWidth: number,
) => TextMeasurement;

export interface PreviewRenderOptions {
  readonly resolveAsset?: (path: string, form: 'url' | 'resource') => string | null;
  readonly size: PreviewSize;
  readonly measureText: MeasurePreviewText;
  readonly activeStates?: ReadonlySet<string>;
  readonly states?: Readonly<Record<string, readonly string[]>>;
}

export interface RenderFrameBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PreviewFrame {
  readonly elements: ReadonlyMap<EditorNodeId, HTMLElement>;
  readonly boxes: ReadonlyMap<EditorNodeId, RenderFrameBox>;
  readonly diagnostics: readonly EditorDiagnostic[];
  nodeForElement(element: Element): EditorNodeId | null;
  dispose(): void;
}

export type StyleExplanationOrigin =
  | {
    readonly kind: 'inline';
    readonly nodeId: EditorNodeId;
    readonly declarationIndex: number;
    readonly source?: EditorSourceSpan;
  }
  | {
    readonly kind: 'rule';
    readonly source?: EditorSourceSpan;
    readonly sheetPath: string | null;
    readonly itemIndex: number;
    readonly declarationIndex: number;
    readonly states?: readonly string[];
  }
  | {
    readonly kind: 'inherited';
    readonly from: EditorNodeId;
    readonly origin: StyleExplanationOrigin;
  }
  | {
    readonly kind: 'builtin-theme';
    readonly selector: string;
    readonly property: string;
    readonly unityVersion: string;
  }
  | {
    readonly kind: 'default';
  };

export interface StyleCandidate {
  readonly property: string;
  readonly value: string;
  readonly origin: StyleExplanationOrigin;
  readonly rank: 'author' | 'builtin-theme';
  readonly specificity: readonly [number, number, number];
  readonly order: number;
  readonly winner: boolean;
}

export interface StyleExplanationOptions {
  readonly activeStates?: ReadonlySet<string>;
  readonly states?: Readonly<Record<string, readonly string[]>>;
}

export interface StyleComputedValue {
  readonly value: string | null;
  readonly origin: StyleExplanationOrigin;
}

export interface StyleExplanation {
  readonly nodeId: EditorNodeId;
  readonly property: string;
  readonly computed: StyleComputedValue;
  readonly candidates: readonly StyleCandidate[];
}

export interface UxmlPreviewPort {
  parseProject(input: ProjectParseInput): ParsedPreviewDocument;
  serializeEntry(document: ParsedPreviewDocument): SerializedProject;
  render(
    document: ParsedPreviewDocument,
    container: HTMLElement,
    options: PreviewRenderOptions,
  ): Promise<PreviewFrame>;
  explain(
    document: ParsedPreviewDocument,
    nodeId: EditorNodeId,
    property: string,
    options?: StyleExplanationOptions,
  ): StyleExplanation | null;
}
