export const UXML_FRAGMENT_MIME = 'application/x-uxml-editor-fragment+json';
export const UXML_FRAGMENT_VERSION = 1 as const;

export interface ClipboardBlobLike {
  text(): Promise<string>;
}

export interface ClipboardItemLike {
  readonly types: readonly string[];
  getType(type: string): Promise<ClipboardBlobLike>;
}

export interface ClipboardNamespace {
  readonly name: string;
  readonly value: string;
}

export interface ClipboardFragment {
  readonly source: string;
  readonly namespaces: readonly ClipboardNamespace[];
}

export interface ClipboardStylesheet {
  readonly path: string;
  readonly source: string;
}

export interface UxmlClipboardPayload {
  readonly version: typeof UXML_FRAGMENT_VERSION;
  readonly sourcePath: string;
  readonly fragments: readonly ClipboardFragment[];
  readonly stylesheets: readonly ClipboardStylesheet[];
}

export type ClipboardDiagnosticCode =
  | 'AMBIGUOUS_CLIPBOARD_SOURCE'
  | 'INVALID_CLIPBOARD_FRAGMENT'
  | 'AMBIGUOUS_PASTE_TARGET'
  | 'CLIPBOARD_IO_FAILED';

export interface ClipboardDiagnostic {
  readonly code: ClipboardDiagnosticCode;
  readonly message: string;
}

export function createClipboardItem(payload: UxmlClipboardPayload, plain: string): ClipboardItemLike {
  return new MemoryClipboardItem(payload, plain);
}

export async function decodeClipboardItem(
  item: ClipboardItemLike,
): Promise<{ readonly ok: true; readonly payload: UxmlClipboardPayload } | { readonly ok: false; readonly diagnostic: ClipboardDiagnostic }> {
  try {
    if (
      typeof item !== 'object'
      || item === null
      || !Array.isArray(item.types)
      || !item.types.includes(UXML_FRAGMENT_MIME)
      || !item.types.includes('text/plain')
      || typeof item.getType !== 'function'
    ) return invalidPayload('Clipboard data must include structured and plain UXML types.');
    const [structuredBlob, plainBlob] = await Promise.all([
      item.getType(UXML_FRAGMENT_MIME),
      item.getType('text/plain'),
    ]);
    const [structured, plain] = await Promise.all([structuredBlob.text(), plainBlob.text()]);
    const candidate: unknown = JSON.parse(structured);
    if (!validPayload(candidate)) return invalidPayload('Clipboard UXML metadata is malformed or has an unsupported version.');
    if (plain !== candidate.fragments.map((fragment) => fragment.source).join('\n')) {
      return invalidPayload('Plain UXML and structured fragment bytes do not match.');
    }
    return Object.freeze({ ok: true, payload: freezePayload(candidate) });
  } catch (error) {
    return invalidPayload(error instanceof Error && error.message.length > 0
      ? error.message
      : 'Clipboard UXML data could not be read.');
  }
}

class MemoryClipboardItem implements ClipboardItemLike {
  readonly types = Object.freeze([UXML_FRAGMENT_MIME, 'text/plain']);
  private readonly data: ReadonlyMap<string, string>;

  constructor(payload: UxmlClipboardPayload, plain: string) {
    this.data = new Map([
      [UXML_FRAGMENT_MIME, JSON.stringify(payload)],
      ['text/plain', plain],
    ]);
  }

  async getType(type: string): Promise<ClipboardBlobLike> {
    const data = this.data.get(type);
    if (data === undefined) throw new TypeError(`Clipboard type ${type} is unavailable.`);
    return new Blob([data], { type });
  }
}

function validPayload(candidate: unknown): candidate is UxmlClipboardPayload {
  if (!record(candidate) || candidate.version !== UXML_FRAGMENT_VERSION || !nonempty(candidate.sourcePath)) return false;
  if (!Array.isArray(candidate.fragments) || candidate.fragments.length === 0 || !Array.isArray(candidate.stylesheets)) return false;
  if (!candidate.fragments.every((fragment) =>
    record(fragment)
    && nonempty(fragment.source)
    && fragment.source.trim() === fragment.source
    && Array.isArray(fragment.namespaces)
    && fragment.namespaces.every((namespace) =>
      record(namespace)
      && typeof namespace.name === 'string'
      && (namespace.name === 'xmlns' || /^xmlns:[A-Za-z_][A-Za-z0-9_.-]*$/.test(namespace.name))
      && typeof namespace.value === 'string'),
  )) return false;
  return candidate.stylesheets.every((stylesheet) =>
    record(stylesheet) && nonempty(stylesheet.path) && typeof stylesheet.source === 'string',
  );
}

function freezePayload(payload: UxmlClipboardPayload): UxmlClipboardPayload {
  return Object.freeze({
    version: UXML_FRAGMENT_VERSION,
    sourcePath: payload.sourcePath,
    fragments: Object.freeze(payload.fragments.map((fragment) => Object.freeze({
      source: fragment.source,
      namespaces: Object.freeze(fragment.namespaces.map((namespace) => Object.freeze({ ...namespace }))),
    }))),
    stylesheets: Object.freeze(payload.stylesheets.map((stylesheet) => Object.freeze({ ...stylesheet }))),
  });
}

function invalidPayload(message: string): { readonly ok: false; readonly diagnostic: ClipboardDiagnostic } {
  return Object.freeze({
    ok: false,
    diagnostic: Object.freeze({ code: 'INVALID_CLIPBOARD_FRAGMENT', message }),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
