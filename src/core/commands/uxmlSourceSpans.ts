import type { EditorElement } from '../adapter/types';
import type { DocumentSession } from '../documents/DocumentSession';
import { UxmlCommandError } from './uxmlCommandError';

export interface ClosingNameSpan {
  readonly start: number;
  readonly end: number;
}

export function requireEntrySource(session: DocumentSession, path: string): string {
  const buffer = session.snapshot().files.get(path);
  if (!buffer || path !== session.entryPath) {
    throw new UxmlCommandError('ambiguous-source', `Element source ${path} is not the session entry source.`);
  }
  return buffer.text;
}

export function outerEnd(source: string, element: EditorElement): number {
  const closeName = exactClosingNameSpan(source, element);
  return closeName === null
    ? Math.max(element.spans.openTag.end, element.spans.inner.end)
    : element.spans.closeTag!.end;
}

export function exactClosingNameSpan(
  source: string,
  element: EditorElement,
): ClosingNameSpan | null {
  const { openTag, inner, closeTag } = element.spans;
  if (closeTag === null) return null;
  const start = closeTag.start + 2;
  const end = start + element.name.length;
  if (
    inner.path !== openTag.path
    || closeTag.path !== openTag.path
    || inner.end !== closeTag.start
    || source.slice(closeTag.start, start) !== '</'
    || source.slice(start, end) !== element.name
    || !/^[\t\r\n ]*>$/.test(source.slice(end, closeTag.end))
  ) {
    throw new UxmlCommandError(
      'ambiguous-source',
      `The recovered closing tag for ${element.name} does not match its source span exactly.`,
    );
  }
  return Object.freeze({ start, end });
}
