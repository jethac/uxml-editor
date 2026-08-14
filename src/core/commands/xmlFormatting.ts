import type { EditorSourceSpan } from '../adapter/types';

export interface XmlAttributeLexeme {
  readonly name: string;
  readonly quote: '"' | "'";
  readonly valueStart: number;
  readonly valueEnd: number;
}

export function readXmlAttributeLexeme(
  source: string,
  span: EditorSourceSpan,
): XmlAttributeLexeme | null {
  if (!validSpan(source, span)) return null;
  const lexeme = source.slice(span.start, span.end);
  const match = /^([^\s=/>]+)\s*=\s*(["'])([\s\S]*)\2$/.exec(lexeme);
  if (!match) return null;
  const quoteOffset = lexeme.indexOf(match[2]);
  return Object.freeze({
    name: match[1],
    quote: match[2] as '"' | "'",
    valueStart: span.start + quoteOffset + 1,
    valueEnd: span.end - 1,
  });
}

export function escapeXmlAttributeValue(value: string, quote: '"' | "'"): string {
  let escaped = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (!isXmlCodePoint(codePoint)) {
      throw new TypeError(`U+${codePoint.toString(16).toUpperCase()} is not valid in XML 1.0.`);
    }
    if (character === '&') escaped += '&amp;';
    else if (character === '<') escaped += '&lt;';
    else if (character === quote) escaped += quote === '"' ? '&quot;' : '&apos;';
    else if (character === '\t') escaped += '&#x9;';
    else if (character === '\n') escaped += '&#xA;';
    else if (character === '\r') escaped += '&#xD;';
    else escaped += character;
  }
  return escaped;
}

export function decodeXmlAttributeValue(value: string): string | null {
  if (typeof DOMParser === 'undefined') return null;
  const quote = value.includes('"') ? "'" : '"';
  if (value.includes(quote)) return null;
  const elementName = 'uxml-editor-value';
  const document = new DOMParser().parseFromString(
    `<${elementName} value=${quote}${value}${quote} />`,
    'application/xml',
  );
  const root = document.documentElement;
  return root.localName === elementName ? root.getAttribute('value') : null;
}

export function isQualifiedXmlName(value: string): boolean {
  const parts = value.split(':');
  return parts.length <= 2 && parts.every(isXmlNcName);
}

export function isXmlElementFragment(
  fragment: string,
  namespaceBindings: ReadonlyMap<string, string>,
): boolean {
  if (fragment.length === 0 || fragment.trim() !== fragment || typeof DOMParser === 'undefined') {
    return false;
  }
  let declarations = '';
  try {
    for (const [prefix, uri] of [...namespaceBindings].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (prefix === 'xml') {
        if (uri !== 'http://www.w3.org/XML/1998/namespace') return false;
        continue;
      }
      if (prefix === 'xmlns' || (prefix.length > 0 && (!isXmlNcName(prefix) || uri.length === 0))) {
        return false;
      }
      const name = prefix.length === 0 ? 'xmlns' : `xmlns:${prefix}`;
      declarations += ` ${name}="${escapeXmlAttributeValue(uri, '"')}"`;
    }
  } catch {
    return false;
  }
  const wrapperName = 'uxml-editor-fragment';
  const document = new DOMParser().parseFromString(
    `<${wrapperName}${declarations}>${fragment}</${wrapperName}>`,
    'application/xml',
  );
  const root = document.documentElement;
  return root.localName === wrapperName
    && root.childNodes.length === 1
    && root.firstChild?.nodeType === 1
    && elementUsesSupportedQNames(root.firstChild as Element);
}

function isXmlNcName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}

function elementUsesSupportedQNames(element: Element): boolean {
  if (!isQualifiedXmlName(element.tagName)) return false;
  for (const attribute of element.attributes) {
    if (!isQualifiedXmlName(attribute.name)) return false;
  }
  return [...element.children].every(elementUsesSupportedQNames);
}

function validSpan(source: string, span: EditorSourceSpan): boolean {
  return Number.isInteger(span.start)
    && Number.isInteger(span.end)
    && span.start >= 0
    && span.end >= span.start
    && span.end <= source.length;
}

function isXmlCodePoint(codePoint: number): boolean {
  return codePoint === 0x9
    || codePoint === 0xa
    || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}
