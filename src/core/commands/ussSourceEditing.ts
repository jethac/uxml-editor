import type { EditorUssDeclaration, EditorUssRule, UssSourcePort } from '../adapter/types';
import type { DocumentSession } from '../documents/DocumentSession';
import type { RuleStyleTarget } from '../documents/StyleTarget';
import { revalidateStyleTarget } from './styleTargetRevalidation';
import { UssCommandError } from './ussCommandError';

export interface CurrentRuleTarget {
  readonly target: RuleStyleTarget;
  readonly source: string;
  readonly rule: EditorUssRule;
  readonly declaration: EditorUssDeclaration | null;
}

export interface DeclarationLexeme {
  readonly valueStart: number;
  readonly valueEnd: number;
}

export function currentRuleTarget(
  session: DocumentSession,
  target: RuleStyleTarget,
): CurrentRuleTarget {
  requireUssSourcePort(session);
  const snapshot = revalidateStyleTarget(session, target, 'rule');
  const {
    path,
    sheetIndex,
    itemIndex,
    declarationIndex,
    property,
    value,
    authoredProperty,
    originDeclarationIndex,
    originDeclarationSource,
    originValue,
    ruleSource,
    selectorSource,
    declarationSource,
  } = snapshot;
  if (
    typeof path !== 'string'
    || !Number.isInteger(sheetIndex)
    || !Number.isInteger(itemIndex)
    || (declarationIndex !== null && !Number.isInteger(declarationIndex))
    || typeof property !== 'string'
    || (value !== null && typeof value !== 'string')
  ) {
    throw new UssCommandError('invalid-target', 'The rule target identity is malformed.');
  }
  if (session.document.originsBySheet[sheetIndex] !== path) {
    throw new UssCommandError('stale-target', `Stylesheet ${path} is no longer mapped to sheet ${sheetIndex}.`);
  }
  const buffer = session.snapshot().files.get(path);
  if (buffer === undefined) {
    throw new UssCommandError('stale-target', `Stylesheet ${path} is no longer in the document session.`);
  }
  if (snapshot.sourceSnapshot !== buffer.text) {
    throw new UssCommandError('stale-target', `Stylesheet ${path} changed after this target was created.`);
  }
  const parsed = requireUssSourcePort(session).parseStylesheet(path, buffer.text);
  const rule = parsed.rules.find((candidate) => candidate.itemIndex === itemIndex);
  const declaration = declarationIndex === null
    ? null
    : rule?.declarations.find((candidate) => candidate.declarationIndex === declarationIndex);
  const origin = rule?.declarations.find((candidate) => candidate.declarationIndex === originDeclarationIndex);
  if (
    rule === undefined
    || declaration === undefined
    || origin === undefined
    || origin.property !== authoredProperty
    || origin.value !== originValue
    || !sameSpan(origin.source, originDeclarationSource)
    || (declaration !== null && (
      declaration.property !== property
      || declaration.value !== value
      || declarationSource === null
      || !sameSpan(declaration.source, declarationSource)
    ))
    || (declaration === null && (declarationSource !== null || value !== null))
    || !sameSpan(rule.source, ruleSource)
    || !sameSpan(rule.selectorSource, selectorSource)
  ) {
    throw new UssCommandError(
      'stale-target',
      `Declaration ${property} no longer matches its rule, declaration index, or exact source spans in ${path}.`,
    );
  }
  return Object.freeze({ target: snapshot, source: buffer.text, rule, declaration });
}

export function readDeclarationLexeme(
  source: string,
  declaration: EditorUssDeclaration,
): DeclarationLexeme {
  const { start, end } = declaration.source;
  const text = source.slice(start, end);
  if (!text.startsWith(declaration.property)) {
    throw new UssCommandError('ambiguous-source', `Declaration ${declaration.property} does not start at its parser span.`);
  }
  let cursor = declaration.property.length;
  while (isWhitespace(text[cursor])) cursor += 1;
  if (text[cursor] !== ':') {
    throw new UssCommandError('ambiguous-source', `Declaration ${declaration.property} has no safe value boundary.`);
  }
  cursor += 1;
  while (isWhitespace(text[cursor])) cursor += 1;
  const valueEnd = cursor + declaration.value.length;
  if (text.slice(cursor, valueEnd) !== declaration.value || !isOnlyWhitespace(text.slice(valueEnd))) {
    throw new UssCommandError('ambiguous-source', `Declaration ${declaration.property} value does not match its parser span.`);
  }
  return Object.freeze({ valueStart: start + cursor, valueEnd: start + valueEnd });
}

export function requireUssSourcePort(session: DocumentSession): UssSourcePort {
  const candidate = session.adapter as Partial<UssSourcePort>;
  if (
    typeof candidate.parseStylesheet !== 'function'
    || typeof candidate.parseDeclarationList !== 'function'
  ) {
    throw new UssCommandError('unsafe-source', 'The active preview adapter cannot parse an isolated USS source buffer.');
  }
  return candidate as UssSourcePort;
}

export function assertSafeStylesheetAppend(path: string, source: string): void {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let inComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inComment) {
      if (character === '*' && next === '/') {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '*') {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth < 0) {
        throw new UssCommandError('unsafe-source', `Stylesheet ${path} has an unmatched closing brace; a rule cannot be appended safely.`);
      }
    }
  }
  if (depth !== 0 || quote !== null || inComment) {
    throw new UssCommandError(
      'unsafe-source',
      `Stylesheet ${path} ends inside an authored block, comment, or quoted value; a rule cannot be appended safely.`,
    );
  }
}

function sameSpan(
  left: { readonly path: string; readonly start: number; readonly end: number },
  right: { readonly path: string; readonly start: number; readonly end: number },
): boolean {
  return typeof right === 'object'
    && right !== null
    && left.path === right.path
    && left.start === right.start
    && left.end === right.end;
}

function isWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

function isOnlyWhitespace(value: string): boolean {
  for (const character of value) if (!isWhitespace(character)) return false;
  return true;
}
