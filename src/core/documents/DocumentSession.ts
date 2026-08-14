import type { EditorNodeId, ParsedPreviewDocument, ProjectParseInput, UxmlPreviewPort } from '../adapter/types';
import { freezeParsedPreviewDocument } from '../adapter/immutableParsedDocument';
import { ImmutableMap } from '../collections/ImmutableMap';
import { CommandHistory } from '../commands/CommandHistory';
import {
  EditorTransactionError,
  normalizeEditorTransaction,
  type EditorTransaction,
} from '../commands/EditorTransaction';
import { invertPatches, validatePatchSet } from '../commands/SourcePatch';
import { createElementLocator, resolveElementLocator, type ElementLocator } from './ElementLocator';
import { SourceBuffer } from './SourceBuffer';

export interface DocumentSnapshot {
  readonly entryPath: string;
  readonly files: ReadonlyMap<string, SourceBuffer>;
}

export interface SelectionResolution {
  readonly locators: readonly ElementLocator[];
  readonly nodeIds: readonly EditorNodeId[];
}

export interface CommitResult {
  readonly forward: EditorTransaction;
  readonly inverse: EditorTransaction;
  readonly before: DocumentSnapshot;
  readonly after: DocumentSnapshot;
  readonly document: ParsedPreviewDocument;
  readonly diagnostics: readonly ParsedPreviewDocument['diagnostics'][number][];
  readonly selection: SelectionResolution;
}

export type DocumentSessionErrorCode =
  | 'invalid-files'
  | 'invalid-entry-path'
  | 'missing-entry'
  | 'invalid-buffer'
  | 'missing-file'
  | 'invalid-patch'
  | 'invalid-transaction'
  | 'invalid-selection'
  | 'parse-failed';

export class DocumentSessionError extends Error {
  constructor(readonly code: DocumentSessionErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DocumentSessionError';
  }
}

export class DocumentSession {
  private files: Map<string, SourceBuffer>;
  private parsed: ParsedPreviewDocument;
  private selectedLocators: readonly ElementLocator[] = Object.freeze([]);
  private resolvedSelection: readonly EditorNodeId[] = Object.freeze([]);
  readonly history: CommandHistory;

  private constructor(
    files: Map<string, SourceBuffer>,
    readonly entryPath: string,
    readonly adapter: UxmlPreviewPort,
    parsed: ParsedPreviewDocument,
  ) {
    this.files = files;
    this.parsed = parsed;
    this.history = new CommandHistory(this);
  }

  static open(
    files: ReadonlyMap<string, string | SourceBuffer>,
    entryPath: string,
    adapter: UxmlPreviewPort,
  ): DocumentSession {
    if (typeof entryPath !== 'string' || entryPath.length === 0) {
      throw new DocumentSessionError('invalid-entry-path', 'DocumentSession.open requires a nonempty entry path.');
    }
    const buffers = snapshotFiles(files);
    if (!buffers.has(entryPath)) {
      throw new DocumentSessionError('missing-entry', `The entry path ${entryPath} is not present in the supplied files.`);
    }
    const parsed = parse(adapter, buffers, entryPath);
    return new DocumentSession(buffers, entryPath, adapter, parsed);
  }

  get document(): ParsedPreviewDocument { return this.parsed; }
  get diagnostics(): readonly ParsedPreviewDocument['diagnostics'][number][] { return Object.freeze([...this.parsed.diagnostics]); }
  get selection(): readonly ElementLocator[] { return Object.freeze([...this.selectedLocators]); }
  get selectedNodeIds(): readonly EditorNodeId[] { return Object.freeze([...this.resolvedSelection]); }

  snapshot(): DocumentSnapshot {
    return Object.freeze({ entryPath: this.entryPath, files: new ImmutableMap(this.files) });
  }

  setSelection(locators: readonly ElementLocator[]): void {
    this.selectedLocators = snapshotLocators(locators);
    this.resolvedSelection = resolveSelection(this.parsed, this.selectedLocators);
  }

  locatorFor(nodeId: EditorNodeId): ElementLocator | null {
    return createElementLocator(this.parsed.root, nodeId);
  }

  commit(input: EditorTransaction): CommitResult {
    let forward: EditorTransaction;
    try {
      forward = normalizeEditorTransaction(input);
    } catch (error) {
      throw asSessionError(error);
    }

    const before = this.snapshot();
    const beforeSelection = this.selectedLocators;
    const candidate = new Map(this.files);
    const inverseByFile = new Map<string, readonly import('../commands/SourcePatch').SourcePatch[]>();
    try {
      const validatedByFile = new Map<string, { readonly buffer: SourceBuffer; readonly patches: readonly import('../commands/SourcePatch').SourcePatch[] }>();
      for (const [path, patches] of forward.patchesByFile) {
        const buffer = candidate.get(path);
        if (!buffer) {
          throw new DocumentSessionError('missing-file', `Transaction ${forward.id} references missing file ${path}.`);
        }
        const validation = validatePatchSet(buffer.text, patches);
        if (!validation.ok) {
          throw new DocumentSessionError('invalid-patch', validation.error.message);
        }
        validatedByFile.set(path, { buffer, patches: validation.patches });
      }
      for (const [path, { buffer, patches }] of validatedByFile) {
        if (patches.length === 0) continue;
        inverseByFile.set(path, invertPatches(buffer.text, patches));
        candidate.set(path, buffer.apply(patches));
      }
      const parsed = parse(this.adapter, candidate, this.entryPath);
      const locators = forward.selectionAfter ?? beforeSelection;
      const selection = snapshotLocators(locators);
      const nodeIds = resolveSelection(parsed, selection);
      const inverse = normalizeEditorTransaction({
        id: forward.id,
        label: `Undo ${forward.label}`,
        patchesByFile: inverseByFile,
        selectionAfter: beforeSelection,
      });

      this.files = candidate;
      this.parsed = parsed;
      this.selectedLocators = selection;
      this.resolvedSelection = nodeIds;
      const after = this.snapshot();
      return Object.freeze({
        forward,
        inverse,
        before,
        after,
        document: parsed,
        diagnostics: Object.freeze([...parsed.diagnostics]),
        selection: Object.freeze({ locators: Object.freeze([...selection]), nodeIds: Object.freeze([...nodeIds]) }),
      });
    } catch (error) {
      if (error instanceof DocumentSessionError) throw error;
      throw new DocumentSessionError('parse-failed', 'The candidate source buffers could not be parsed.', error);
    }
  }

  commitSequence(transactions: readonly EditorTransaction[]): readonly CommitResult[] {
    const checkpoint = {
      files: this.files,
      parsed: this.parsed,
      selectedLocators: this.selectedLocators,
      resolvedSelection: this.resolvedSelection,
    };
    try {
      return Object.freeze(transactions.map((transaction) => this.commit(transaction)));
    } catch (error) {
      this.files = checkpoint.files;
      this.parsed = checkpoint.parsed;
      this.selectedLocators = checkpoint.selectedLocators;
      this.resolvedSelection = checkpoint.resolvedSelection;
      throw error;
    }
  }
}

function snapshotFiles(files: ReadonlyMap<string, string | SourceBuffer>): Map<string, SourceBuffer> {
  if (typeof files !== 'object' || files === null || typeof files[Symbol.iterator] !== 'function') {
    throw new DocumentSessionError('invalid-files', 'DocumentSession.open requires a Map of editor-owned files.');
  }
  const copied = new Map<string, SourceBuffer>();
  try {
    for (const [path, value] of files) {
      if (typeof path !== 'string' || path.length === 0) {
        throw new DocumentSessionError('invalid-buffer', 'Each source buffer requires a nonempty exact path.');
      }
      if (typeof value !== 'string' && !(value instanceof SourceBuffer)) {
        throw new DocumentSessionError('invalid-buffer', `Source ${path} must be text or a SourceBuffer.`);
      }
      const buffer = typeof value === 'string' ? new SourceBuffer(path, value) : value;
      if (buffer.path !== path) {
        throw new DocumentSessionError('invalid-buffer', `SourceBuffer path ${buffer.path} does not match map key ${path}.`);
      }
      copied.set(path, buffer);
    }
  } catch (error) {
    if (error instanceof DocumentSessionError) throw error;
    throw new DocumentSessionError('invalid-files', 'The source file map could not be snapshotted.', error);
  }
  return copied;
}

function parse(adapter: UxmlPreviewPort, files: ReadonlyMap<string, SourceBuffer>, entryPath: string): ParsedPreviewDocument {
  const entry = files.get(entryPath);
  if (!entry) throw new DocumentSessionError('missing-entry', `The entry path ${entryPath} is missing.`);
  const stylesheets = new Map<string, string>();
  for (const [path, buffer] of files) {
    if (path.toLowerCase().endsWith('.uss')) stylesheets.set(path, buffer.text);
  }
  const stylesheetLookup = createStylesheetLookup(stylesheets);
  const input: ProjectParseInput = {
    uxmlPath: entryPath,
    uxml: entry.text,
    stylesheets,
    resolveImport: (url, from) => {
      const path = resolveProjectImportPath(url, from, entryPath);
      return path === null ? null : stylesheetLookup.get(path) ?? null;
    },
  };
  try {
    return freezeParsedPreviewDocument(adapter.parseProject(input));
  } catch (error) {
    throw new DocumentSessionError('parse-failed', 'The candidate source buffers could not be parsed.', error);
  }
}

function createStylesheetLookup(stylesheets: ReadonlyMap<string, string>): ReadonlyMap<string, { readonly path: string; readonly text: string } | null> {
  const lookup = new Map<string, { readonly path: string; readonly text: string } | null>();
  for (const [path, text] of stylesheets) {
    const normalized = normalizeProjectPath(path);
    if (normalized === null) continue;
    if (lookup.has(normalized)) {
      lookup.set(normalized, null);
    } else {
      lookup.set(normalized, Object.freeze({ path: normalized, text }));
    }
  }
  return lookup;
}

function resolveProjectImportPath(url: string, from: string | null, entryPath: string): string | null {
  const entry = normalizeProjectPath(entryPath);
  if (entry === null) return null;
  const importer = from === null
    ? entry
    : isProjectFixedPath(from)
      ? normalizeProjectPath(from)
      : resolveRelativeProjectPath(from, directoryOf(entry));
  if (importer === null) return null;
  return isProjectFixedPath(url)
    ? normalizeProjectPath(url)
    : resolveRelativeProjectPath(url, directoryOf(importer));
}

function resolveRelativeProjectPath(path: string, baseDirectory: string): string | null {
  const normalizedSeparators = path.replace(/\\/g, '/');
  if (hasNonProjectScheme(normalizedSeparators) || normalizedSeparators.startsWith('/')) return null;
  return normalizeProjectPath(baseDirectory.length === 0
    ? normalizedSeparators
    : `${baseDirectory}/${normalizedSeparators}`);
}

function normalizeProjectPath(path: string): string | null {
  let normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('project://')) {
    normalized = normalized.slice('project://'.length);
  } else if (hasNonProjectScheme(normalized)) {
    return null;
  }
  normalized = normalized.replace(/^\/+/, '');
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length === 0 ? null : segments.join('/');
}

function isProjectFixedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('/')
    || normalized.startsWith('project://')
    || normalized === 'Assets'
    || normalized.startsWith('Assets/')
    || normalized === 'Packages'
    || normalized.startsWith('Packages/');
}

function hasNonProjectScheme(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
}

function directoryOf(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? '' : path.slice(0, separator);
}

function snapshotLocators(locators: readonly ElementLocator[]): readonly ElementLocator[] {
  try {
    return Object.freeze(locators.map((locator) => Object.freeze({
      qualifiedTag: locator.qualifiedTag,
      childPath: Object.freeze([...locator.childPath]),
      ancestorTags: Object.freeze([...locator.ancestorTags]),
      attributeHints: Object.freeze(locator.attributeHints.map((hint) => Object.freeze({ name: hint.name, value: hint.value }))),
      ...(locator.authoredName === undefined ? {} : { authoredName: locator.authoredName }),
    })));
  } catch (error) {
    throw new DocumentSessionError('invalid-selection', 'Selection locators could not be snapshotted.', error);
  }
}

function resolveSelection(document: ParsedPreviewDocument, locators: readonly ElementLocator[]): readonly EditorNodeId[] {
  return Object.freeze(locators.flatMap((locator) => {
    const nodeId = resolveElementLocator(document.root, locator);
    return nodeId === null ? [] : [nodeId];
  }));
}

function asSessionError(error: unknown): DocumentSessionError {
  if (error instanceof DocumentSessionError) return error;
  if (error instanceof EditorTransactionError) {
    const code = error.code === 'invalid-selection' ? 'invalid-selection' : 'invalid-transaction';
    return new DocumentSessionError(code, error.message, error);
  }
  return new DocumentSessionError('invalid-transaction', 'The editor transaction could not be normalized.', error);
}
