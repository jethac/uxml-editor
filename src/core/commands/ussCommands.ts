import type { DocumentSession } from '../documents/DocumentSession';
import {
  type InlineStyleTarget,
  type NewRuleStyleTarget,
  type RuleStyleTarget,
} from '../documents/StyleTarget';
import { resolveElementLocator } from '../documents/ElementLocator';
import { normalizeEditorTransaction, type EditorTransaction } from './EditorTransaction';
import { planInlineDeclarationInsertion, planRuleDeclarationInsertion } from './cssDeclarationInsertion';
import { escapeXmlAttributeValue, readXmlAttributeLexeme } from './xmlFormatting';
import { setAttribute } from './uxmlCommands';
import { UssCommandError } from './ussCommandError';
import { revalidateStyleTarget } from './styleTargetRevalidation';
import {
  assertSafeStylesheetAppend,
  currentRuleTarget,
  readDeclarationLexeme,
  requireUssSourcePort,
} from './ussSourceEditing';

export { UssCommandError } from './ussCommandError';
export type { UssCommandErrorCode } from './ussCommandError';

export function setDeclaration(
  session: DocumentSession,
  target: RuleStyleTarget,
  value: string,
): EditorTransaction {
  const current = currentRuleTarget(session, target);
  requireValue(session, current.target.property, value);
  if (current.declaration === null) {
    const patch = planRuleDeclarationInsertion(
      current.target.path,
      current.source,
      current.rule,
      current.target.property,
      value,
    );
    return transaction('set-declaration', `Set ${current.target.property}`, current.target.path, [patch]);
  }
  const lexeme = readDeclarationLexeme(current.source, current.declaration);
  return transaction('set-declaration', `Set ${current.target.property}`, current.target.path, [{
    start: lexeme.valueStart,
    end: lexeme.valueEnd,
    replacement: value,
  }]);
}

export function removeDeclaration(
  session: DocumentSession,
  target: RuleStyleTarget,
): EditorTransaction {
  const current = currentRuleTarget(session, target);
  if (current.declaration === null) {
    throw new UssCommandError(
      'invalid-target',
      `Cannot remove ${current.target.property} because this target represents a new longhand override.`,
    );
  }
  let terminator = current.declaration.source.end;
  while (/[\t\r\n ]/.test(current.source[terminator] ?? '')) terminator += 1;
  const end = current.source[terminator] === ';'
    ? terminator + 1
    : current.declaration.source.end;
  return transaction('remove-declaration', `Remove ${current.target.property}`, current.target.path, [{
    start: current.declaration.source.start,
    end,
    replacement: '',
  }]);
}

export function insertRule(
  session: DocumentSession,
  target: NewRuleStyleTarget,
  value: string,
): EditorTransaction {
  requireUssSourcePort(session);
  target = revalidateStyleTarget(session, target, 'new-rule');
  requireValue(session, target.property, value);
  if (session.document.originsBySheet[target.sheetIndex] !== target.path) {
    throw new UssCommandError('stale-target', `Stylesheet ${target.path} is no longer mapped to sheet ${target.sheetIndex}.`);
  }
  const localIndices = session.document.localStyleSheetIndices;
  if (localIndices !== undefined && !localIndices.includes(target.sheetIndex)) {
    throw new UssCommandError('invalid-target', `Stylesheet ${target.path} is imported and is not a local rule destination.`);
  }
  const buffer = session.snapshot().files.get(target.path);
  if (buffer === undefined) {
    throw new UssCommandError('stale-target', `Stylesheet ${target.path} is no longer in the document session.`);
  }
  if (target.sourceSnapshot !== buffer.text) {
    throw new UssCommandError('stale-target', `Stylesheet ${target.path} changed after this target was created.`);
  }
  assertSafeStylesheetAppend(target.path, buffer.text);
  const sheet = requireUssSourcePort(session).parseStylesheet(target.path, buffer.text);
  const newline = newlineFor(buffer.newlineStyle, buffer.text);
  const indent = declarationIndent(buffer.text, sheet.rules) ?? '  ';
  const finalNewline = endsWithNewline(buffer.text);
  const separator = buffer.text.length === 0 ? '' : `${newline}${finalNewline ? '' : newline}`;
  const rule = `${target.selector} {${newline}${indent}${target.property}: ${value};${newline}}`;
  const replacement = `${separator}${rule}${finalNewline ? newline : ''}`;
  return transaction('insert-rule', `Add ${target.property} rule`, target.path, [{
    start: buffer.text.length,
    end: buffer.text.length,
    replacement,
  }]);
}

export function setInlineStyle(
  session: DocumentSession,
  target: InlineStyleTarget,
  value: string,
): EditorTransaction {
  requireUssSourcePort(session);
  target = revalidateStyleTarget(session, target, 'inline');
  if (target.path !== session.entryPath || target.state.length !== 0) {
    throw new UssCommandError('invalid-target', 'setInlineStyle requires a base-state inline target.');
  }
  requireValue(session, target.property, value);
  let nodeId;
  try {
    nodeId = resolveElementLocator(session.document.root, target.authoredLocator);
  } catch (error) {
    throw new UssCommandError('invalid-target', 'The inline target locator is malformed.', error);
  }
  if (nodeId === null || nodeId !== target.authoredNodeId) {
    throw new UssCommandError('stale-target', 'The inline style target no longer resolves to the same element.');
  }
  const node = findElement(session.document.root, nodeId);
  const attributes = node?.attributes.filter((attribute) => attribute.name === 'style') ?? [];
  const buffer = session.snapshot().files.get(session.entryPath);
  if (node === null || buffer === undefined) {
    throw new UssCommandError('stale-target', 'The inline style target element is no longer in the entry source.');
  }
  if (target.sourceSnapshot !== buffer.text) {
    throw new UssCommandError('stale-target', 'The UXML entry changed after this inline target was created.');
  }
  if (target.attributeSource === null) {
    if (attributes.length !== 0) {
      throw new UssCommandError('stale-target', 'The target element now has an authored inline style attribute.');
    }
    const planned = setAttribute(session, target.authoredLocator, 'style', `${target.property}: ${value};`);
    return transaction(
      'set-inline-style',
      `Set inline ${target.property}`,
      session.entryPath,
      planned.patchesByFile.get(session.entryPath) ?? [],
    );
  }
  if (
    attributes.length !== 1
    || !sameSpan(attributes[0].source, target.attributeSource)
  ) {
    throw new UssCommandError('stale-target', 'The inline style attribute no longer matches its exact source span.');
  }
  const attribute = readXmlAttributeLexeme(buffer.text, attributes[0].source);
  if (attribute === null || attribute.name !== 'style') {
    throw new UssCommandError('ambiguous-source', 'The inline style attribute has no safe quoted value boundary.');
  }
  const sourcePort = requireUssSourcePort(session);
  const declarations = sourcePort.parseDeclarationList(
    session.entryPath,
    buffer.text,
    attribute.valueStart,
    attribute.valueEnd,
  );
  if (target.declarationIndex === null) {
    let escaped: string;
    try {
      escaped = escapeXmlAttributeValue(value, attribute.quote);
    } catch (error) {
      throw new UssCommandError('invalid-value', `Inline value for ${target.property} is not valid XML 1.0 text.`, error);
    }
    validateInlineOrigin(target, declarations);
    const patch = planInlineDeclarationInsertion(
      session.entryPath,
      buffer.text,
      attribute.valueStart,
      attribute.valueEnd,
      declarations,
      target.property,
      escaped,
    );
    return transaction('set-inline-style', `Set inline ${target.property}`, session.entryPath, [patch]);
  }
  const declaration = declarations.find((candidate) => candidate.declarationIndex === target.declarationIndex);
  if (
    declaration === undefined
    || declaration.property !== target.property
    || declaration.value !== target.value
    || target.declarationSource === null
    || !sameSpan(declaration.source, target.declarationSource)
  ) {
    throw new UssCommandError('stale-target', `Inline declaration ${target.property} no longer matches its parser index.`);
  }
  const declarationLexeme = readDeclarationLexeme(buffer.text, declaration);
  let replacement: string;
  try {
    replacement = escapeXmlAttributeValue(value, attribute.quote);
  } catch (error) {
    throw new UssCommandError('invalid-value', `Inline value for ${target.property} is not valid XML 1.0 text.`, error);
  }
  return transaction('set-inline-style', `Set inline ${target.property}`, session.entryPath, [{
    start: declarationLexeme.valueStart,
    end: declarationLexeme.valueEnd,
    replacement,
  }]);
}

function validateInlineOrigin(
  target: InlineStyleTarget,
  declarations: readonly import('../adapter/types').EditorUssDeclaration[],
): void {
  if (target.originDeclarationIndex === null) return;
  const origin = declarations.find((candidate) => candidate.declarationIndex === target.originDeclarationIndex);
  if (
    origin === undefined
    || target.authoredProperty === null
    || target.originDeclarationSource === null
    || target.originValue === null
    || origin.property !== target.authoredProperty
    || origin.value !== target.originValue
    || !sameSpan(origin.source, target.originDeclarationSource)
  ) {
    throw new UssCommandError('stale-target', 'The authored inline shorthand origin no longer matches its exact declaration.');
  }
}

function transaction(
  operation: string,
  label: string,
  path: string,
  patches: readonly { readonly start: number; readonly end: number; readonly replacement: string }[],
): EditorTransaction {
  const fingerprint = JSON.stringify([operation, path, patches]);
  return normalizeEditorTransaction({
    id: `uss:${operation}:${hash(fingerprint)}`,
    label,
    patchesByFile: new Map([[path, patches]]),
  });
}

function requireValue(session: DocumentSession, property: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UssCommandError('invalid-value', 'A USS declaration value must be a nonempty single value.');
  }
  const source = `${property}: ${value};`;
  const declarations = requireUssSourcePort(session).parseDeclarationList(
    '<uss-value>',
    source,
    0,
    source.length,
  );
  if (
    declarations.length !== 1
    || declarations[0].property !== property
    || declarations[0].value !== value
  ) {
    throw new UssCommandError('invalid-value', `The value for ${property} is not one complete USS declaration value.`);
  }
}

function declarationIndent(
  source: string,
  rules: readonly { readonly declarations: readonly { readonly source: { readonly start: number } }[] }[],
): string | null {
  for (let ruleIndex = rules.length - 1; ruleIndex >= 0; ruleIndex -= 1) {
    const declarations = rules[ruleIndex].declarations;
    for (let declarationIndex = declarations.length - 1; declarationIndex >= 0; declarationIndex -= 1) {
      const start = declarations[declarationIndex].source.start;
      const lineStart = Math.max(source.lastIndexOf('\n', start - 1), source.lastIndexOf('\r', start - 1)) + 1;
      const indent = source.slice(lineStart, start);
      if (/^[\t ]+$/.test(indent)) return indent;
    }
  }
  return null;
}

function newlineFor(style: 'none' | 'lf' | 'crlf' | 'cr' | 'mixed', source: string): string {
  if (style === 'crlf') return '\r\n';
  if (style === 'cr') return '\r';
  if (style === 'mixed') {
    const observed = [...source.matchAll(/\r\n|\r|\n/g)];
    return observed[observed.length - 1]?.[0] ?? '\n';
  }
  return '\n';
}

function endsWithNewline(source: string): boolean {
  return source.endsWith('\n') || source.endsWith('\r');
}

function findElement(root: import('../adapter/types').EditorElement, nodeId: import('../adapter/types').EditorNodeId) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.id === nodeId) return current;
    pending.push(...current.children);
  }
  return null;
}

function sameSpan(
  left: { readonly path: string; readonly start: number; readonly end: number },
  right: { readonly path: string; readonly start: number; readonly end: number },
): boolean {
  return left.path === right.path && left.start === right.start && left.end === right.end;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}
