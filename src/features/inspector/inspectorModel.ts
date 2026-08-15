import type {
  EditorElement,
  EditorSourceSpan,
  StyleExplanationOrigin,
  UssSourcePort,
} from '../../core/adapter/types';
import type { DocumentSession } from '../../core/documents/DocumentSession';
import type { ElementLocator } from '../../core/documents/ElementLocator';
import { styleTargetsFor, type StyleTarget } from '../../core/documents/StyleTarget';
import type { EditorActiveStateEntry, EditorSnapshot } from '../../core/store/EditorStoreContracts';
import { equalActiveStateLocator } from '../../core/store/EditorStoreContracts';
import type { InspectorPropertyDefinition } from './propertyCatalog';
import type { StyleEditTarget } from './inspectorTransactions';

export interface InspectorSelection {
  readonly node: EditorElement;
  readonly locator: ElementLocator;
}

export interface InspectorOrigin {
  readonly label: string;
  readonly title?: string;
}

export interface InspectorStyleChoice {
  readonly id: string;
  readonly label: string;
  readonly title?: string;
  readonly edits: readonly StyleEditTarget[];
}

export interface InspectorStyleFieldModel {
  readonly definition: InspectorPropertyDefinition;
  readonly value: string;
  readonly mixed: boolean;
  readonly origin: InspectorOrigin;
  readonly choices: readonly InspectorStyleChoice[];
  readonly unavailableReason?: string;
}

interface StyleObservation {
  readonly selection: InspectorSelection;
  readonly value: string;
  readonly origin: InspectorOrigin;
  readonly targets: readonly StyleTarget[];
}

export function inspectorSelection(snapshot: EditorSnapshot): readonly InspectorSelection[] {
  const session = snapshot.session;
  if (session === null) return Object.freeze([]);
  return Object.freeze(snapshot.selection.flatMap((id) => {
    const node = findElement(session.document.root, id);
    const locator = node === null ? null : session.locatorFor(id);
    return node === null || locator === null ? [] : [Object.freeze({ node, locator })];
  }));
}

export function styleFieldModel(
  session: DocumentSession,
  selection: readonly InspectorSelection[],
  activeStates: readonly EditorActiveStateEntry[],
  definition: InspectorPropertyDefinition,
): InspectorStyleFieldModel {
  const observations = selection.map((item) => observeStyle(session, item, activeStates, definition));
  const values = [...new Set(observations.map((item) => item.value))];
  const mixed = values.length > 1;
  const origins = [...new Set(observations.map((item) => item.origin.label))];
  const choices = choicesFor(observations);
  const unavailable = observations.length === 0 || choices.length === 0;
  return Object.freeze({
    definition,
    value: mixed || observations.length === 0 ? '' : observations[0].value,
    mixed,
    origin: origins.length === 1 ? observations[0].origin : { label: 'Multiple origins' },
    choices,
    ...(unavailable ? { unavailableReason: `Computed ${definition.property} provenance is unavailable.` } : {}),
  });
}

export function activeStatesFor(
  activeStates: readonly EditorActiveStateEntry[],
  locator: ElementLocator,
): readonly string[] {
  return activeStates.find((entry) => equalActiveStateLocator(entry.locator, locator))?.states ?? Object.freeze([]);
}

function observeStyle(
  session: DocumentSession,
  selection: InspectorSelection,
  activeStateEntries: readonly EditorActiveStateEntry[],
  definition: InspectorPropertyDefinition,
): StyleObservation {
  const state = activeStatesFor(activeStateEntries, selection.locator);
  const options = state.length === 0 ? undefined : explanationOptions(session.document.root, selection.node, state);
  const explanation = session.adapter.explain(session.document, selection.node.id, definition.property, options);
  let targets: readonly StyleTarget[] = Object.freeze([]);
  try {
    targets = styleTargetsFor(session, selection.node, definition.property, state);
  } catch {
    // A valid computed state may still be read-only when no parser-safe write selector exists.
  }
  return Object.freeze({
    selection,
    value: explanation?.computed.value ?? '',
    origin: explanation === null
      ? { label: 'Unavailable' }
      : describeOrigin(session, explanation.computed.origin),
    targets,
  });
}

function choicesFor(observations: readonly StyleObservation[]): readonly InspectorStyleChoice[] {
  if (observations.length === 0) return Object.freeze([]);
  const choices: InspectorStyleChoice[] = [];
  const seen = new Set<string>();
  for (const requested of observations[0].targets) {
    if (requested.kind === 'inline' && requested.authoredNodeId !== requested.nodeId) continue;
    const key = destinationKey(requested);
    if (seen.has(key)) continue;
    const edits = observations.map((observation) => {
      const target = observation.targets.find((candidate) => sameChoiceDestination(candidate, requested));
      return target === undefined ? null : Object.freeze({ locator: observation.selection.locator, target });
    });
    if (edits.some((edit) => edit === null)) continue;
    seen.add(key);
    const described = describeTarget(requested);
    choices.push(Object.freeze({
      id: key,
      label: described.label,
      ...(described.title === undefined ? {} : { title: described.title }),
      edits: Object.freeze(edits as StyleEditTarget[]),
    }));
  }
  return disambiguateChoiceLabels(choices);
}

function disambiguateChoiceLabels(choices: readonly InspectorStyleChoice[]): readonly InspectorStyleChoice[] {
  const counts = new Map<string, number>();
  for (const choice of choices) counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1);
  return Object.freeze(choices.map((choice, index) => {
    if (counts.get(choice.label) === 1) return choice;
    const target = choice.edits[0]?.target;
    if (target?.kind !== 'rule') return Object.freeze({ ...choice, label: `${choice.label} · target ${index + 1}` });
    const location = sourceLocation(target.sourceSnapshot, target.ruleSource.start);
    const sameLine = choices.filter((candidate) => {
      const candidateTarget = candidate.edits[0]?.target;
      return candidate.label === choice.label
        && candidateTarget?.kind === 'rule'
        && sourceLocation(candidateTarget.sourceSnapshot, candidateTarget.ruleSource.start).line === location.line;
    }).length;
    return Object.freeze({
      ...choice,
      label: `${choice.label} · line ${location.line}${sameLine > 1 ? `:${location.column}` : ''}`,
      title: `${target.path}:${location.line}:${location.column}`,
    });
  }));
}

function sourceLocation(source: string, offset: number): Readonly<{ line: number; column: number }> {
  const before = source.slice(0, offset);
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function sameChoiceDestination(candidate: StyleTarget, requested: StyleTarget): boolean {
  if (candidate.kind !== requested.kind || candidate.path !== requested.path || candidate.property !== requested.property) return false;
  if (candidate.kind === 'rule' && requested.kind === 'rule') {
    return candidate.sheetIndex === requested.sheetIndex
      && candidate.itemIndex === requested.itemIndex
      && candidate.declarationIndex === requested.declarationIndex
      && candidate.originDeclarationIndex === requested.originDeclarationIndex;
  }
  if (candidate.kind === 'inline' && requested.kind === 'inline') {
    return candidate.authoredNodeId === candidate.nodeId;
  }
  return candidate.kind === 'new-rule' && requested.kind === 'new-rule';
}

function destinationKey(target: StyleTarget): string {
  if (target.kind === 'rule') return JSON.stringify(['rule', target.path, target.itemIndex, target.declarationIndex, target.originDeclarationIndex]);
  if (target.kind === 'inline') return 'inline';
  return JSON.stringify(['new-rule', target.path]);
}

function describeTarget(target: StyleTarget): InspectorOrigin {
  if (target.kind === 'inline') return { label: 'Inline style', title: target.path };
  if (target.kind === 'new-rule') {
    return { label: `New rule: ${fileName(target.path)} · ${target.selector}`, title: target.path };
  }
  const selector = target.sourceSnapshot.slice(target.selectorSource.start, target.selectorSource.end).trim();
  return { label: `${fileName(target.path)} · ${selector}`, title: target.path };
}

function describeOrigin(session: DocumentSession, origin: StyleExplanationOrigin): InspectorOrigin {
  if (origin.kind === 'default') return { label: 'Default' };
  if (origin.kind === 'builtin-theme') return { label: `Built-in · ${origin.selector}` };
  if (origin.kind === 'inherited') {
    const nested = describeOrigin(session, origin.origin);
    return { label: `Inherited · ${nested.label}`, ...(nested.title === undefined ? {} : { title: nested.title }) };
  }
  if (origin.kind === 'inline') {
    const path = origin.source?.path ?? session.entryPath;
    const node = findElement(session.document.root, origin.nodeId);
    const authoredName = node?.attributes.find((attribute) => attribute.name === 'name')?.value;
    return {
      label: `${fileName(path)} · inline${authoredName === undefined ? '' : ` on ${authoredName}`}`,
      title: path,
    };
  }
  if (origin.sheetPath === null) return { label: 'Authored rule' };
  const selector = selectorForRule(session, origin.sheetPath, origin.itemIndex, origin.source);
  return {
    label: `${fileName(origin.sheetPath)} · ${selector ?? 'authored rule'}`,
    title: origin.sheetPath,
  };
}

function selectorForRule(
  session: DocumentSession,
  path: string,
  itemIndex: number,
  source: EditorSourceSpan | undefined,
): string | null {
  const port = session.adapter as Partial<UssSourcePort>;
  const text = session.snapshot().files.get(path)?.text;
  if (text === undefined || typeof port.parseStylesheet !== 'function') return source === undefined ? null : 'authored rule';
  try {
    const rule = port.parseStylesheet(path, text).rules.find((candidate) => candidate.itemIndex === itemIndex);
    return rule === undefined ? null : text.slice(rule.selectorSource.start, rule.selectorSource.end).trim();
  } catch {
    return null;
  }
}

function explanationOptions(root: EditorElement, node: EditorElement, states: readonly string[]) {
  const name = node.attributes.find((attribute) => attribute.name === 'name')?.value;
  if (name === undefined || authoredNameCount(root, name) !== 1) return undefined;
  return { states: { [`#${escapeSelectorIdentifier(name)}`]: states } };
}

function authoredNameCount(root: EditorElement, name: string): number {
  return listElements(root).filter((node) => node.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name)).length;
}

function escapeSelectorIdentifier(value: string): string {
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) escaped += '\\fffd ';
    else if ((index === 0 && code >= 48 && code <= 57) || (index === 1 && value[0] === '-' && code >= 48 && code <= 57)) {
      escaped += `\\${code.toString(16)} `;
    } else if (/[A-Za-z0-9_-]/.test(value[index]) || code >= 0x80) escaped += value[index];
    else escaped += `\\${value[index]}`;
  }
  return escaped;
}

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').at(-1) ?? path;
}

function listElements(root: EditorElement): readonly EditorElement[] {
  return [root, ...root.children.flatMap(listElements)];
}

function findElement(root: EditorElement, id: EditorElement['id']): EditorElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findElement(child, id);
    if (found !== null) return found;
  }
  return null;
}
