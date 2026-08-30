import type { EditorNodeId, EditorSourceSpan } from '../adapter/types';
import type { ElementLocator } from './ElementLocator';
import type {
  InlineStyleTarget,
  NewRuleStyleTarget,
  RuleStyleTarget,
  StyleSessionSource,
  StyleTarget,
} from './StyleTarget';

export type StyleTargetIdentity = Omit<RuleStyleTarget, 'id'>
  | Omit<InlineStyleTarget, 'id'>
  | Omit<NewRuleStyleTarget, 'id'>;

export function snapshotStyleTargetIdentity(candidate: unknown): StyleTarget {
  if (typeof candidate !== 'object' || candidate === null) throw new TypeError('Target must be an object.');
  const source = candidate as Record<string, unknown>;
  const kind = source.kind;
  const id = source.id;
  const path = source.path;
  const property = source.property;
  const state = source.state;
  const sourceSnapshot = source.sourceSnapshot;
  const nodeId = source.nodeId;
  const locator = source.locator;
  const sessionSources = source.sessionSources;
  if (
    typeof id !== 'string'
    || typeof path !== 'string'
    || typeof property !== 'string'
    || !Array.isArray(state)
    || typeof sourceSnapshot !== 'string'
    || typeof nodeId !== 'string'
    || !Array.isArray(sessionSources)
  ) throw new TypeError('Target common fields are malformed.');
  const common = {
    path,
    property,
    state: copyTargetState(state),
    sourceSnapshot,
    nodeId: nodeId as EditorNodeId,
    locator: copyLocator(locator),
    sessionSources: copySessionSources(sessionSources),
  };
  if (common.sessionSources.find((entry) => entry.path === path)?.text !== sourceSnapshot) {
    throw new TypeError('Target source snapshot does not match the complete session snapshot.');
  }

  let snapshot: StyleTarget;
  if (kind === 'rule') {
    const sheetIndex = source.sheetIndex;
    const itemIndex = source.itemIndex;
    const declarationIndex = source.declarationIndex;
    const ruleSource = source.ruleSource;
    const selectorSource = source.selectorSource;
    const declarationSource = source.declarationSource;
    const value = source.value;
    const authoredProperty = source.authoredProperty;
    const originDeclarationIndex = source.originDeclarationIndex;
    const originDeclarationSource = source.originDeclarationSource;
    const originValue = source.originValue;
    const winner = source.winner;
    if (
      !isSafeIndex(sheetIndex)
      || !isSafeIndex(itemIndex)
      || (declarationIndex !== null && !isSafeIndex(declarationIndex))
      || (declarationSource !== null && typeof declarationSource !== 'object')
      || (value !== null && typeof value !== 'string')
      || typeof authoredProperty !== 'string'
      || !isSafeIndex(originDeclarationIndex)
      || typeof originValue !== 'string'
      || typeof winner !== 'boolean'
      || (declarationIndex === null
        ? declarationSource !== null || value !== null
        : declarationSource === null || value === null)
    ) throw new TypeError('Rule target fields are malformed.');
    snapshot = freezeRuleTarget({
      kind,
      ...common,
      sheetIndex: sheetIndex as number,
      itemIndex: itemIndex as number,
      declarationIndex: declarationIndex as number | null,
      ruleSource: copySpan(ruleSource),
      selectorSource: copySpan(selectorSource),
      declarationSource: declarationSource === null ? null : copySpan(declarationSource),
      value: value as string | null,
      authoredProperty,
      originDeclarationIndex: originDeclarationIndex as number,
      originDeclarationSource: copySpan(originDeclarationSource),
      originValue,
      winner,
    });
  } else if (kind === 'inline') {
    const authoredNodeId = source.authoredNodeId;
    const authoredLocator = source.authoredLocator;
    const attributeSource = source.attributeSource;
    const declarationIndex = source.declarationIndex;
    const declarationSource = source.declarationSource;
    const value = source.value;
    const authoredProperty = source.authoredProperty;
    const originDeclarationIndex = source.originDeclarationIndex;
    const originDeclarationSource = source.originDeclarationSource;
    const originValue = source.originValue;
    if (
      typeof authoredNodeId !== 'string'
      || (declarationIndex !== null && !isSafeIndex(declarationIndex))
      || (declarationSource !== null && typeof declarationSource !== 'object')
      || (value !== null && typeof value !== 'string')
      || (authoredProperty !== null && typeof authoredProperty !== 'string')
      || (originDeclarationIndex !== null && !isSafeIndex(originDeclarationIndex))
      || (originDeclarationSource !== null && typeof originDeclarationSource !== 'object')
      || (originValue !== null && typeof originValue !== 'string')
      || (declarationIndex === null
        ? declarationSource !== null || value !== null
        : declarationSource === null || value === null)
      || (authoredProperty === null
        ? originDeclarationIndex !== null || originDeclarationSource !== null || originValue !== null
        : originDeclarationIndex === null || originDeclarationSource === null || originValue === null)
    ) throw new TypeError('Inline target fields are malformed.');
    snapshot = freezeInlineTarget({
      kind,
      ...common,
      authoredNodeId: authoredNodeId as EditorNodeId,
      authoredLocator: copyLocator(authoredLocator),
      attributeSource: attributeSource === null ? null : copySpan(attributeSource),
      declarationIndex: declarationIndex as number | null,
      declarationSource: declarationSource === null ? null : copySpan(declarationSource),
      value: value as string | null,
      authoredProperty: authoredProperty as string | null,
      originDeclarationIndex: originDeclarationIndex as number | null,
      originDeclarationSource: originDeclarationSource === null ? null : copySpan(originDeclarationSource),
      originValue: originValue as string | null,
    });
  } else if (kind === 'new-rule') {
    const sheetIndex = source.sheetIndex;
    const selector = source.selector;
    if (!isSafeIndex(sheetIndex) || typeof selector !== 'string') {
      throw new TypeError('New-rule target fields are malformed.');
    }
    snapshot = freezeNewRuleTarget({
      kind,
      ...common,
      sheetIndex: sheetIndex as number,
      selector,
    });
  } else {
    throw new TypeError('Target kind is not recognized.');
  }
  if (id !== snapshot.id) throw new TypeError('Target id does not match its snapshotted fields.');
  return snapshot;
}

export function freezeRuleTarget(target: Omit<RuleStyleTarget, 'id'>): RuleStyleTarget {
  const frozen = {
    ...freezeCommon(target),
    kind: target.kind,
    sheetIndex: target.sheetIndex,
    itemIndex: target.itemIndex,
    declarationIndex: target.declarationIndex,
    ruleSource: freezeSpan(target.ruleSource),
    selectorSource: freezeSpan(target.selectorSource),
    declarationSource: target.declarationSource === null ? null : freezeSpan(target.declarationSource),
    value: target.value,
    authoredProperty: target.authoredProperty,
    originDeclarationIndex: target.originDeclarationIndex,
    originDeclarationSource: freezeSpan(target.originDeclarationSource),
    originValue: target.originValue,
    winner: target.winner,
  } satisfies StyleTargetIdentity;
  return Object.freeze({ ...frozen, id: styleTargetIdFor(frozen) });
}

export function freezeInlineTarget(target: Omit<InlineStyleTarget, 'id'>): InlineStyleTarget {
  const frozen = {
    ...freezeCommon(target),
    kind: target.kind,
    authoredNodeId: target.authoredNodeId,
    authoredLocator: freezeLocator(target.authoredLocator),
    attributeSource: target.attributeSource === null ? null : freezeSpan(target.attributeSource),
    declarationIndex: target.declarationIndex,
    declarationSource: target.declarationSource === null ? null : freezeSpan(target.declarationSource),
    value: target.value,
    authoredProperty: target.authoredProperty,
    originDeclarationIndex: target.originDeclarationIndex,
    originDeclarationSource: target.originDeclarationSource === null ? null : freezeSpan(target.originDeclarationSource),
    originValue: target.originValue,
  } satisfies StyleTargetIdentity;
  return Object.freeze({ ...frozen, id: styleTargetIdFor(frozen) });
}

export function freezeNewRuleTarget(target: Omit<NewRuleStyleTarget, 'id'>): NewRuleStyleTarget {
  const frozen = {
    ...freezeCommon(target),
    kind: target.kind,
    sheetIndex: target.sheetIndex,
    selector: target.selector,
  } satisfies StyleTargetIdentity;
  return Object.freeze({ ...frozen, id: styleTargetIdFor(frozen) });
}

export function styleTargetIdFor(target: StyleTargetIdentity): string {
  const common = [
    target.kind,
    target.path,
    target.property,
    target.state,
    target.sourceSnapshot,
    target.nodeId,
    locatorIdentity(target.locator),
    target.sessionSources.map((entry) => [entry.path, entry.text]),
  ];
  const identity = target.kind === 'rule'
    ? [
      ...common,
      target.sheetIndex,
      target.itemIndex,
      target.declarationIndex,
      spanIdentity(target.ruleSource),
      spanIdentity(target.selectorSource),
      target.declarationSource === null ? null : spanIdentity(target.declarationSource),
      target.value,
      target.authoredProperty,
      target.originDeclarationIndex,
      spanIdentity(target.originDeclarationSource),
      target.originValue,
      target.winner,
    ]
    : target.kind === 'inline'
      ? [
        ...common,
        target.authoredNodeId,
        locatorIdentity(target.authoredLocator),
        target.attributeSource === null ? null : spanIdentity(target.attributeSource),
        target.declarationIndex,
        target.declarationSource === null ? null : spanIdentity(target.declarationSource),
        target.value,
        target.authoredProperty,
        target.originDeclarationIndex,
        target.originDeclarationSource === null ? null : spanIdentity(target.originDeclarationSource),
        target.originValue,
      ]
      : [...common, target.sheetIndex, target.selector];
  return `style-target:v2:${JSON.stringify(identity)}`;
}

function freezeCommon(target: StyleTargetIdentity) {
  return {
    path: target.path,
    property: target.property,
    state: Object.freeze([...target.state]),
    sourceSnapshot: target.sourceSnapshot,
    nodeId: target.nodeId,
    locator: freezeLocator(target.locator),
    sessionSources: freezeSessionSources(target.sessionSources),
  };
}

function freezeSpan(source: EditorSourceSpan): EditorSourceSpan {
  return Object.freeze({ path: source.path, start: source.start, end: source.end });
}

function copyTargetState(state: unknown[]): readonly string[] {
  if (state.some((item) => typeof item !== 'string')) throw new TypeError('Target state entries must be strings.');
  return Object.freeze([...state] as string[]);
}

function copySessionSources(sources: unknown[]): readonly StyleSessionSource[] {
  const result = sources.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new TypeError('Target session source must be an object.');
    }
    const source = candidate as Record<string, unknown>;
    const path = source.path;
    const text = source.text;
    if (typeof path !== 'string' || typeof text !== 'string') {
      throw new TypeError('Target session source fields are malformed.');
    }
    return Object.freeze({ path, text });
  });
  for (let index = 1; index < result.length; index += 1) {
    if (compareExactPath(result[index - 1].path, result[index].path) >= 0) {
      throw new TypeError('Target session sources must have unique exact paths in deterministic order.');
    }
  }
  return Object.freeze(result);
}

function freezeSessionSources(sources: readonly StyleSessionSource[]): readonly StyleSessionSource[] {
  return Object.freeze(sources.map((source) => Object.freeze({ path: source.path, text: source.text })));
}

function copySpan(candidate: unknown): EditorSourceSpan {
  if (typeof candidate !== 'object' || candidate === null) throw new TypeError('Target source span must be an object.');
  const source = candidate as Record<string, unknown>;
  const path = source.path;
  const start = source.start;
  const end = source.end;
  if (typeof path !== 'string' || !isSafeIndex(start) || !isSafeIndex(end) || start > end) {
    throw new TypeError('Target source span fields are malformed.');
  }
  return Object.freeze({ path, start: start as number, end: end as number });
}

function copyLocator(candidate: unknown): ElementLocator {
  if (typeof candidate !== 'object' || candidate === null) throw new TypeError('Target locator must be an object.');
  const source = candidate as Record<string, unknown>;
  const authoredName = source.authoredName;
  const childPath = source.childPath;
  const qualifiedTag = source.qualifiedTag;
  const ancestorTags = source.ancestorTags;
  const attributeHints = source.attributeHints;
  if (
    (authoredName !== undefined && typeof authoredName !== 'string')
    || !Array.isArray(childPath)
    || typeof qualifiedTag !== 'string'
    || !Array.isArray(ancestorTags)
    || !Array.isArray(attributeHints)
  ) throw new TypeError('Target locator fields are malformed.');
  const copiedChildPath = childPath.map((item) => {
    if (!isSafeIndex(item)) throw new TypeError('Target child path is malformed.');
    return item as number;
  });
  const copiedAncestors = ancestorTags.map((item) => {
    if (typeof item !== 'string') throw new TypeError('Target ancestor tags are malformed.');
    return item;
  });
  const copiedHints = attributeHints.map((item) => {
    if (typeof item !== 'object' || item === null) throw new TypeError('Target attribute hint is malformed.');
    const hint = item as Record<string, unknown>;
    const name = hint.name;
    const value = hint.value;
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new TypeError('Target attribute hint fields are malformed.');
    }
    return Object.freeze({ name, value });
  });
  return Object.freeze({
    qualifiedTag,
    childPath: Object.freeze(copiedChildPath),
    ancestorTags: Object.freeze(copiedAncestors),
    attributeHints: Object.freeze(copiedHints),
    ...(authoredName === undefined ? {} : { authoredName }),
  });
}

function freezeLocator(locator: ElementLocator): ElementLocator {
  return Object.freeze({
    qualifiedTag: locator.qualifiedTag,
    childPath: Object.freeze([...locator.childPath]),
    ancestorTags: Object.freeze([...locator.ancestorTags]),
    attributeHints: Object.freeze(locator.attributeHints.map((hint) => Object.freeze({
      name: hint.name,
      value: hint.value,
    }))),
    ...(locator.authoredName === undefined ? {} : { authoredName: locator.authoredName }),
  });
}

function spanIdentity(span: EditorSourceSpan): readonly [string, number, number] {
  return [span.path, span.start, span.end];
}

function locatorIdentity(locator: ElementLocator) {
  return [
    locator.authoredName ?? null,
    locator.qualifiedTag,
    locator.childPath,
    locator.ancestorTags,
    locator.attributeHints.map((hint) => [hint.name, hint.value]),
  ];
}

function compareExactPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
}
