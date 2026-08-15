import type {
  EditorElement,
  StyleCandidate,
  StyleExplanation,
  StyleExplanationOptions,
  StyleExplanationOrigin,
} from '../adapter/types';
import type { DocumentSession } from './DocumentSession';

export const SHORTHAND_LONGHANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  margin: Object.freeze(['margin-top', 'margin-right', 'margin-bottom', 'margin-left']),
  padding: Object.freeze(['padding-top', 'padding-right', 'padding-bottom', 'padding-left']),
  'border-color': Object.freeze(['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']),
  'border-width': Object.freeze(['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']),
  'border-radius': Object.freeze([
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ]),
});

export interface IssuedStyleCandidate {
  readonly origin: StyleExplanationOrigin;
  readonly order: number;
  readonly winner: boolean;
}

export function collectStyleCandidates(
  session: DocumentSession,
  node: EditorElement,
  property: string,
  options: StyleExplanationOptions | undefined,
  requested: StyleExplanation | null,
): readonly IssuedStyleCandidate[] {
  const all: StyleCandidate[] = [...(requested?.candidates ?? [])];
  for (const expandedProperty of SHORTHAND_LONGHANDS[property] ?? []) {
    const explanation = session.adapter.explain(session.document, node.id, expandedProperty, options);
    all.push(...(explanation?.candidates ?? []));
  }
  const computedKey = requested === null ? null : authoredOriginKey(requested.computed.origin);
  const byOrigin = new Map<string, IssuedStyleCandidate>();
  for (const candidate of all) {
    const key = authoredOriginKey(candidate.origin);
    if (key === null) continue;
    const winner = computedKey === null ? candidate.winner : key === computedKey;
    const previous = byOrigin.get(key);
    if (previous === undefined || candidate.order > previous.order || (winner && !previous.winner)) {
      byOrigin.set(key, { origin: candidate.origin, order: candidate.order, winner });
    }
  }
  if (requested !== null && computedKey !== null && !byOrigin.has(computedKey)) {
    byOrigin.set(computedKey, {
      origin: requested.computed.origin,
      order: Number.MAX_SAFE_INTEGER,
      winner: true,
    });
  }
  return Object.freeze([...byOrigin.values()]
    .sort((left, right) => Number(right.winner) - Number(left.winner) || right.order - left.order));
}

export function authoredRuleOrigin(
  origin: StyleExplanationOrigin,
): Extract<StyleExplanationOrigin, { kind: 'rule' }> | null {
  if (origin.kind === 'rule') return origin;
  return origin.kind === 'inherited' ? authoredRuleOrigin(origin.origin) : null;
}

export function authoredInlineOrigin(
  origin: StyleExplanationOrigin,
): Extract<StyleExplanationOrigin, { kind: 'inline' }> | null {
  if (origin.kind === 'inline') return origin;
  return origin.kind === 'inherited' ? authoredInlineOrigin(origin.origin) : null;
}

export function isAuthoredSourceFor(requested: string, authored: string): boolean {
  return requested === authored || SHORTHAND_LONGHANDS[authored]?.includes(requested) === true;
}

function authoredOriginKey(origin: StyleExplanationOrigin): string | null {
  if (origin.kind === 'inherited') return authoredOriginKey(origin.origin);
  if (origin.kind === 'inline') {
    return JSON.stringify(['inline', origin.nodeId, origin.declarationIndex, origin.source ?? null]);
  }
  if (origin.kind === 'rule') {
    return JSON.stringify([
      'rule',
      origin.sheetPath,
      origin.sheetIndex,
      origin.itemIndex,
      origin.declarationIndex,
      origin.source ?? null,
      [...(origin.states ?? [])].sort(),
    ]);
  }
  return null;
}
