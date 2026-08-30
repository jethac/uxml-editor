import type { EditorUssDeclaration, EditorUssRule } from '../adapter/types';
import type { SourcePatch } from './SourcePatch';
import { UssCommandError } from './ussCommandError';

export function planInlineDeclarationInsertion(
  path: string,
  source: string,
  valueStart: number,
  valueEnd: number,
  declarations: readonly EditorUssDeclaration[],
  property: string,
  value: string,
): SourcePatch {
  const last = declarations[declarations.length - 1];
  const tailStart = last === undefined ? valueStart : declarationContentEnd(path, source, last);
  const tailText = source.slice(tailStart, valueEnd);
  const tail = tokenizeTail(path, tailText);
  const declaration = `${property}: ${value};`;

  if (last !== undefined) {
    const semicolonEnd = tail.semicolonOffset === null ? null : tail.semicolonOffset + 1;
    const insertion = tailStart + (semicolonEnd ?? 0);
    const leadingTrivia = tailText.slice(semicolonEnd ?? 0, tail.firstComment ?? tailText.length);
    const layout = multilineLayout(leadingTrivia, source, last.source.start);
    return Object.freeze({
      start: insertion,
      end: insertion,
      replacement: `${semicolonEnd === null ? ';' : ''}${layout ?? ' '}${declaration}`,
    });
  }

  if (tail.firstComment !== null) {
    const leadingTrivia = tailText.slice(0, tail.firstComment);
    const layout = multilineLayout(leadingTrivia, source, valueStart);
    const insertion = valueStart + tail.firstComment;
    return Object.freeze({
      start: insertion,
      end: insertion,
      replacement: `${declaration}${layout ?? ' '}`,
    });
  }

  const newline = firstNewline(tailText);
  if (newline !== null) {
    const lastNewline = Math.max(tailText.lastIndexOf('\n'), tailText.lastIndexOf('\r'));
    const closingIndent = tailText.slice(lastNewline + 1);
    const insertion = valueStart + lastNewline + 1;
    const indent = /^[\t ]*$/.test(closingIndent) ? closingIndent : '  ';
    return Object.freeze({
      start: insertion,
      end: insertion,
      replacement: `${indent}${declaration}${newline}`,
    });
  }

  return Object.freeze({
    start: valueStart + tailText.length,
    end: valueStart + tailText.length,
    replacement: `${tailText.length === 0 ? '' : ' '}${declaration}`,
  });
}

export function planRuleDeclarationInsertion(
  path: string,
  source: string,
  rule: EditorUssRule,
  property: string,
  value: string,
): SourcePatch {
  const close = rule.source.end - 1;
  if (rule.source.path !== path || source[close] !== '}') {
    throw new UssCommandError('ambiguous-source', `Rule ${rule.itemIndex} in ${path} has no exact closing brace.`);
  }
  const last = rule.declarations[rule.declarations.length - 1];
  const tailStart = last?.source.end ?? rule.selectorSource.end;
  tokenizeTail(path, source.slice(tailStart, close));

  const closeLineStart = lineStart(source, close);
  const closingIndent = source.slice(closeLineStart, close);
  const newline = newlineImmediatelyBefore(source, closeLineStart);
  if (newline !== null && /^[\t ]*$/.test(closingIndent)) {
    const indent = last === undefined ? `${closingIndent}  ` : declarationIndent(source, last.source.start) ?? `${closingIndent}  `;
    return Object.freeze({
      start: closeLineStart,
      end: closeLineStart,
      replacement: `${indent}${property}: ${value};${newline}`,
    });
  }

  let insertion = close;
  while (insertion > tailStart && isCssWhitespace(source[insertion - 1])) insertion -= 1;
  return Object.freeze({
    start: insertion,
    end: insertion,
    replacement: ` ${property}: ${value};`,
  });
}

interface TailTokens {
  readonly semicolonOffset: number | null;
  readonly firstComment: number | null;
}

function tokenizeTail(path: string, source: string): TailTokens {
  let cursor = 0;
  let semicolonOffset: number | null = null;
  let firstComment: number | null = null;
  while (isCssWhitespace(source[cursor])) cursor += 1;
  if (source[cursor] === ';') {
    semicolonOffset = cursor;
    cursor += 1;
  }
  while (cursor < source.length) {
    if (isCssWhitespace(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      firstComment ??= cursor;
      const end = source.indexOf('*/', cursor + 2);
      if (end === -1) throw unsafeTail(path, 'The trailing declaration trivia contains an unterminated block comment.');
      cursor = end + 2;
      continue;
    }
    throw unsafeTail(path, 'The trailing declaration region contains nontrivia tokens.');
  }
  return Object.freeze({ semicolonOffset, firstComment });
}

function multilineLayout(
  leadingTrivia: string,
  source: string,
  declarationStart: number,
): string | null {
  const newline = firstNewline(leadingTrivia);
  if (newline === null) return null;
  return `${newline}${declarationIndent(source, declarationStart) ?? indentationAfterLastNewline(leadingTrivia) ?? '  '}`;
}

function declarationIndent(source: string, declarationStart: number): string | null {
  const start = lineStart(source, declarationStart);
  const indent = source.slice(start, declarationStart);
  return /^[\t ]+$/.test(indent) ? indent : null;
}

function declarationContentEnd(path: string, source: string, declaration: EditorUssDeclaration): number {
  const text = source.slice(declaration.source.start, declaration.source.end);
  if (!text.startsWith(declaration.property)) {
    throw new UssCommandError('ambiguous-source', `Declaration ${declaration.property} does not start at its parser span.`);
  }
  let cursor = declaration.property.length;
  while (isCssWhitespace(text[cursor])) cursor += 1;
  if (text[cursor] !== ':') {
    throw new UssCommandError('ambiguous-source', `Declaration ${declaration.property} has no exact value boundary.`);
  }
  cursor += 1;
  while (isCssWhitespace(text[cursor])) cursor += 1;
  if (text.slice(cursor, cursor + declaration.value.length) !== declaration.value) {
    throw new UssCommandError('ambiguous-source', `Declaration ${declaration.property} value does not match its parser span.`);
  }
  return declaration.source.start + cursor + trailingTriviaStart(path, declaration.value);
}

function trailingTriviaStart(path: string, value: string): number {
  let cursor = 0;
  let contentEnd = 0;
  let quote: '"' | "'" | null = null;
  while (cursor < value.length) {
    const character = value[cursor];
    if (quote !== null) {
      if (character === '\\') {
        cursor += Math.min(2, value.length - cursor);
        contentEnd = cursor;
        continue;
      }
      cursor += 1;
      contentEnd = cursor;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      contentEnd = cursor;
      continue;
    }
    if (character === '/' && value[cursor + 1] === '*') {
      const end = value.indexOf('*/', cursor + 2);
      if (end === -1) throw unsafeTail(path, 'The trailing declaration trivia contains an unterminated block comment.');
      cursor = end + 2;
      continue;
    }
    cursor += 1;
    if (!isCssWhitespace(character)) contentEnd = cursor;
  }
  if (quote !== null) {
    throw unsafeTail(path, 'The trailing declaration region ends inside a quoted value.');
  }
  return contentEnd;
}

function indentationAfterLastNewline(source: string): string | null {
  const start = Math.max(source.lastIndexOf('\n'), source.lastIndexOf('\r')) + 1;
  const indent = source.slice(start);
  return /^[\t ]+$/.test(indent) ? indent : null;
}

function firstNewline(source: string): '\r\n' | '\r' | '\n' | null {
  return source.match(/\r\n|\r|\n/)?.[0] as '\r\n' | '\r' | '\n' | undefined ?? null;
}

function newlineImmediatelyBefore(source: string, offset: number): '\r\n' | '\r' | '\n' | null {
  if (offset >= 2 && source.slice(offset - 2, offset) === '\r\n') return '\r\n';
  if (offset >= 1 && source[offset - 1] === '\r') return '\r';
  if (offset >= 1 && source[offset - 1] === '\n') return '\n';
  return null;
}

function lineStart(source: string, offset: number): number {
  return Math.max(source.lastIndexOf('\n', offset - 1), source.lastIndexOf('\r', offset - 1)) + 1;
}

function isCssWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n' || character === '\f';
}

function unsafeTail(path: string, detail: string): UssCommandError {
  return new UssCommandError('unsafe-source', `${detail} The style source ${path} was not changed.`);
}
