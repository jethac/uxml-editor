export type ProjectReferenceDecodeResult =
  | Readonly<{ readonly status: 'decoded'; readonly value: string }>
  | Readonly<{ readonly status: 'malformed'; readonly reason: 'percent-encoding' | 'xml-entity' }>;

export function decodeProjectReference(reference: string): ProjectReferenceDecodeResult {
  const entityDecoded = decodeXmlReference(reference);
  if (entityDecoded === null) return Object.freeze({ status: 'malformed', reason: 'xml-entity' });
  try {
    return Object.freeze({ status: 'decoded', value: decodeURIComponent(entityDecoded) });
  } catch (error) {
    if (error instanceof URIError) return Object.freeze({ status: 'malformed', reason: 'percent-encoding' });
    throw error;
  }
}

function decodeXmlReference(reference: string): string | null {
  let decoded = '';
  let cursor = 0;
  while (cursor < reference.length) {
    const ampersand = reference.indexOf('&', cursor);
    if (ampersand < 0) return decoded + reference.slice(cursor);
    decoded += reference.slice(cursor, ampersand);
    const semicolon = reference.indexOf(';', ampersand + 1);
    if (semicolon < 0) return null;
    const entity = decodeXmlEntity(reference.slice(ampersand + 1, semicolon));
    if (entity === null) return null;
    decoded += entity;
    cursor = semicolon + 1;
  }
  return decoded;
}

function decodeXmlEntity(entity: string): string | null {
  const named = XML_ENTITIES[entity];
  if (named !== undefined) return named;
  let codePoint: number;
  if (/^#x[0-9A-Fa-f]+$/.test(entity)) {
    codePoint = Number.parseInt(entity.slice(2), 16);
  } else if (/^#[0-9]+$/.test(entity)) {
    codePoint = Number.parseInt(entity.slice(1), 10);
  } else {
    return null;
  }
  return isXmlCodePoint(codePoint) ? String.fromCodePoint(codePoint) : null;
}

function isXmlCodePoint(codePoint: number): boolean {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

const XML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
});
