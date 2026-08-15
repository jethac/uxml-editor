import type { EditorNodeId, EditorSourceSpan } from '../adapter/types';
import type { ElementLocator } from './ElementLocator';
import type {
  InlineStyleTarget,
  NewRuleStyleTarget,
  RuleStyleTarget,
  StyleTarget,
} from './StyleTarget';

export function snapshotStyleTargetIdentity(candidate: unknown): StyleTarget {
  if (typeof candidate !== 'object' || candidate === null) throw new TypeError('Target must be an object.');
  const source = candidate as Record<string, unknown>;
  const kind = source.kind;
  const id = source.id;
  const path = source.path;
  const property = source.property;
  const state = source.state;
  const sourceSnapshot = source.sourceSnapshot;
  if (
    typeof id !== 'string'
    || typeof path !== 'string'
    || typeof property !== 'string'
    || !Array.isArray(state)
    || typeof sourceSnapshot !== 'string'
  ) throw new TypeError('Target common fields are malformed.');

  let snapshot: StyleTarget;
  if (kind === 'rule') {
    const sheetIndex = source.sheetIndex;
    const itemIndex = source.itemIndex;
    const declarationIndex = source.declarationIndex;
    const ruleSource = source.ruleSource;
    const selectorSource = source.selectorSource;
    const declarationSource = source.declarationSource;
    const value = source.value;
    const winner = source.winner;
    if (
      !Number.isInteger(sheetIndex)
      || !Number.isInteger(itemIndex)
      || !Number.isInteger(declarationIndex)
      || typeof value !== 'string'
      || typeof winner !== 'boolean'
    ) throw new TypeError('Rule target fields are malformed.');
    snapshot = freezeRuleTarget({
      kind,
      path,
      property,
      state: copyTargetState(state),
      sourceSnapshot,
      sheetIndex: sheetIndex as number,
      itemIndex: itemIndex as number,
      declarationIndex: declarationIndex as number,
      ruleSource: copySpan(ruleSource),
      selectorSource: copySpan(selectorSource),
      declarationSource: copySpan(declarationSource),
      value,
      winner,
    });
  } else if (kind === 'inline') {
    const nodeId = source.nodeId;
    const locator = source.locator;
    const attributeSource = source.attributeSource;
    const declarationIndex = source.declarationIndex;
    if (
      typeof nodeId !== 'string'
      || (declarationIndex !== null && !Number.isInteger(declarationIndex))
    ) throw new TypeError('Inline target fields are malformed.');
    snapshot = freezeInlineTarget({
      kind,
      path,
      property,
      state: copyTargetState(state),
      sourceSnapshot,
      nodeId: nodeId as EditorNodeId,
      locator: copyLocator(locator),
      attributeSource: attributeSource === null ? null : copySpan(attributeSource),
      declarationIndex: declarationIndex as number | null,
    });
  } else if (kind === 'new-rule') {
    const sheetIndex = source.sheetIndex;
    const selector = source.selector;
    if (!Number.isInteger(sheetIndex) || typeof selector !== 'string') {
      throw new TypeError('New-rule target fields are malformed.');
    }
    snapshot = freezeNewRuleTarget({
      kind,
      path,
      property,
      state: copyTargetState(state),
      sourceSnapshot,
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
    ...target,
    state: Object.freeze([...target.state]),
    ruleSource: freezeSpan(target.ruleSource),
    selectorSource: freezeSpan(target.selectorSource),
    declarationSource: freezeSpan(target.declarationSource),
  };
  return Object.freeze({ ...frozen, id: targetId(frozen) });
}

export function freezeInlineTarget(target: Omit<InlineStyleTarget, 'id'>): InlineStyleTarget {
  const frozen = {
    ...target,
    state: Object.freeze([...target.state]),
    attributeSource: target.attributeSource === null ? null : freezeSpan(target.attributeSource),
  };
  return Object.freeze({ ...frozen, id: targetId(frozen) });
}

export function freezeNewRuleTarget(target: Omit<NewRuleStyleTarget, 'id'>): NewRuleStyleTarget {
  const frozen = { ...target, state: Object.freeze([...target.state]) };
  return Object.freeze({ ...frozen, id: targetId(frozen) });
}

function freezeSpan(source: EditorSourceSpan): EditorSourceSpan {
  return Object.freeze({ path: source.path, start: source.start, end: source.end });
}

function copyTargetState(state: unknown[]): readonly string[] {
  if (state.some((item) => typeof item !== 'string')) throw new TypeError('Target state entries must be strings.');
  return Object.freeze([...state] as string[]);
}

function copySpan(candidate: unknown): EditorSourceSpan {
  if (typeof candidate !== 'object' || candidate === null) throw new TypeError('Target source span must be an object.');
  const source = candidate as Record<string, unknown>;
  const path = source.path;
  const start = source.start;
  const end = source.end;
  if (typeof path !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)) {
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
    if (!Number.isInteger(item)) throw new TypeError('Target child path is malformed.');
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

type StyleTargetIdentity = Omit<RuleStyleTarget, 'id'>
  | Omit<InlineStyleTarget, 'id'>
  | Omit<NewRuleStyleTarget, 'id'>;

function targetId(target: StyleTargetIdentity): string {
  const common = [target.kind, target.path, target.property, target.state, target.sourceSnapshot];
  const identity = target.kind === 'rule'
    ? [
      ...common,
      target.sheetIndex,
      target.itemIndex,
      target.declarationIndex,
      spanIdentity(target.ruleSource),
      spanIdentity(target.selectorSource),
      spanIdentity(target.declarationSource),
      target.value,
      target.winner,
    ]
    : target.kind === 'inline'
      ? [
        ...common,
        target.nodeId,
        locatorIdentity(target.locator),
        target.attributeSource === null ? null : spanIdentity(target.attributeSource),
        target.declarationIndex,
      ]
      : [...common, target.sheetIndex, target.selector];
  return `style-target:${hash(JSON.stringify(identity))}`;
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

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}
