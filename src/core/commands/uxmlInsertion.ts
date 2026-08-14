import type { EditorElement } from '../adapter/types';
import type { SourcePatch } from './SourcePatch';
import { UxmlCommandError } from './uxmlCommandError';
import { exactClosingNameSpan, outerEnd } from './uxmlSourceSpans';
import { parentOf } from './uxmlTree';

export function planDestinationInsertion(
  source: string,
  root: EditorElement,
  parent: EditorElement,
  index: number,
  fragment: string,
  children: readonly EditorElement[] = parent.children,
): SourcePatch {
  if (parent.spans.closeTag === null) {
    return planSelfClosingInsertion(source, root, parent, fragment);
  }
  exactClosingNameSpan(source, parent);
  return planPairedInsertion(source, root, parent, index, fragment, children);
}

export function planWrapperPatches(
  source: string,
  root: EditorElement,
  parent: EditorElement,
  start: number,
  end: number,
  wrapperName: string,
): readonly SourcePatch[] {
  const { newline, parentIndent } = childFormatting(source, root, parent);
  const wrapperIndent = lineIndentAt(source, start);
  const observedUnit = wrapperIndent.startsWith(parentIndent)
    ? wrapperIndent.slice(parentIndent.length)
    : '';
  const unit = observedUnit.length > 0 ? observedUnit : wrapperIndent.includes('\t') ? '\t' : '  ';
  const before = newline.length === 0
    ? `<${wrapperName}>`
    : `<${wrapperName}>${newline}${wrapperIndent}${unit}`;
  const after = newline.length === 0
    ? `</${wrapperName}>`
    : `${newline}${wrapperIndent}</${wrapperName}>`;
  return Object.freeze([
    Object.freeze({ start, end: start, replacement: before }),
    Object.freeze({ start: end, end, replacement: after }),
  ]);
}

export function trailingXmlWhitespace(value: string): string {
  return /[\t\r\n ]*$/.exec(value)?.[0] ?? '';
}

function planSelfClosingInsertion(
  source: string,
  root: EditorElement,
  parent: EditorElement,
  fragment: string,
): SourcePatch {
  const slash = parent.spans.openTag.end - 2;
  if (source.slice(slash, parent.spans.openTag.end) !== '/>') {
    throw new UxmlCommandError('ambiguous-source', `The self-closing delimiter for ${parent.name} is not safe to edit.`);
  }
  const { newline, parentIndent, childIndent } = childFormatting(source, root, parent);
  const inner = newline.length === 0
    ? `${fragment}</${parent.name}>`
    : `${newline}${childIndent}${fragment}${newline}${parentIndent}</${parent.name}>`;
  return Object.freeze({
    start: slash,
    end: parent.spans.openTag.end,
    replacement: `>${inner}`,
  });
}

function planPairedInsertion(
  source: string,
  root: EditorElement,
  parent: EditorElement,
  index: number,
  fragment: string,
  children: readonly EditorElement[],
): SourcePatch {
  const current = children[index];
  if (current !== undefined) {
    const lowerBound = index === 0
      ? parent.spans.inner.start
      : outerEnd(source, children[index - 1]);
    const start = current.spans.openTag.start;
    const separator = trailingXmlWhitespace(source.slice(lowerBound, start));
    return Object.freeze({ start, end: start, replacement: `${fragment}${separator}` });
  }
  const previous = children[index - 1];
  if (previous !== undefined) {
    const lowerBound = index === 1
      ? parent.spans.inner.start
      : outerEnd(source, children[index - 2]);
    const separator = trailingXmlWhitespace(source.slice(lowerBound, previous.spans.openTag.start));
    const start = outerEnd(source, previous);
    return Object.freeze({ start, end: start, replacement: `${separator}${fragment}` });
  }

  const tail = trailingXmlWhitespace(source.slice(parent.spans.inner.start, parent.spans.inner.end));
  const start = parent.spans.inner.end - tail.length;
  const { newline, childIndent } = childFormatting(source, root, parent);
  const prefix = newline.length === 0 ? '' : `${newline}${childIndent}`;
  return Object.freeze({ start, end: start, replacement: `${prefix}${fragment}` });
}

function childFormatting(
  source: string,
  root: EditorElement,
  parent: EditorElement,
): { readonly newline: string; readonly parentIndent: string; readonly childIndent: string } {
  const lineStart = Math.max(
    source.lastIndexOf('\n', parent.spans.openTag.start - 1),
    source.lastIndexOf('\r', parent.spans.openTag.start - 1),
  ) + 1;
  const beforeTag = source.slice(lineStart, parent.spans.openTag.start);
  const parentIndent = /^[\t ]*$/.test(beforeTag) ? beforeTag : '';
  const innerLineBreak = /\r\n|[\r\n]/.exec(
    source.slice(parent.spans.inner.start, parent.spans.inner.end),
  )?.[0] ?? '';
  const lineBreak = lineStart === 0
    ? innerLineBreak
    : source[lineStart - 1] === '\n' && source[lineStart - 2] === '\r'
      ? '\r\n'
      : source[lineStart - 1];
  if (lineBreak.length === 0) {
    return Object.freeze({ newline: '', parentIndent, childIndent: '' });
  }

  const ancestor = parentOf(root, parent);
  const ancestorIndent = ancestor === null ? '' : lineIndentAt(source, ancestor.spans.openTag.start);
  const observedUnit = parentIndent.startsWith(ancestorIndent)
    ? parentIndent.slice(ancestorIndent.length)
    : '';
  const unit = observedUnit.length > 0
    ? observedUnit
    : parentIndent.includes('\t') ? '\t' : '  ';
  return Object.freeze({
    newline: lineBreak,
    parentIndent,
    childIndent: `${parentIndent}${unit}`,
  });
}

function lineIndentAt(source: string, offset: number): string {
  const lineStart = Math.max(source.lastIndexOf('\n', offset - 1), source.lastIndexOf('\r', offset - 1)) + 1;
  const indentation = source.slice(lineStart, offset);
  return /^[\t ]*$/.test(indentation) ? indentation : '';
}
