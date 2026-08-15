import type { ElementLocator } from '../../core/documents/ElementLocator';
import { equalElementLocator, type EditorActiveStateEntry, type EditorSnapshot } from '../../core/store/EditorStoreContracts';
import type { InspectorSelection } from './inspectorModel';

export interface InspectorContextToken {
  readonly session: NonNullable<EditorSnapshot['session']>;
  readonly generation: number;
  readonly locators: readonly ElementLocator[];
  readonly activeStates: readonly EditorActiveStateEntry[];
}

export function captureInspectorContext(
  snapshot: EditorSnapshot,
  selection: readonly InspectorSelection[],
): InspectorContextToken | null {
  if (snapshot.session === null) return null;
  return Object.freeze({
    session: snapshot.session,
    generation: snapshot.sessionGeneration,
    locators: Object.freeze(selection.map((item) => item.locator)),
    activeStates: snapshot.activeStates,
  });
}

export function inspectorContextMatches(snapshot: EditorSnapshot, token: InspectorContextToken): boolean {
  if (
    snapshot.session !== token.session
    || snapshot.sessionGeneration !== token.generation
    || snapshot.session.generation !== token.generation
  ) return false;
  const locators = snapshot.selection.map((nodeId) => snapshot.session?.locatorFor(nodeId) ?? null);
  if (locators.some((locator) => locator === null) || locators.length !== token.locators.length) return false;
  if (!locators.every((locator, index) => equalElementLocator(locator!, token.locators[index]))) return false;
  return equalActiveStates(snapshot.activeStates, token.activeStates);
}

export function inspectorDraftContextKey(snapshot: EditorSnapshot, selection: readonly InspectorSelection[]): string {
  return JSON.stringify({
    generation: snapshot.sessionGeneration,
    locators: selection.map((item) => item.locator),
    activeStates: snapshot.activeStates,
  });
}

function equalActiveStates(left: readonly EditorActiveStateEntry[], right: readonly EditorActiveStateEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) =>
    equalElementLocator(entry.locator, right[index].locator)
    && entry.states.length === right[index].states.length
    && entry.states.every((state, stateIndex) => state === right[index].states[stateIndex])
  );
}
