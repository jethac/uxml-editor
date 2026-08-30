import type { ElementLocator } from '../documents/ElementLocator';
import { ImmutableMap } from '../collections/ImmutableMap';
import type { SourcePatch } from './SourcePatch';

export interface EditorTransaction {
  readonly id: string;
  readonly label: string;
  readonly patchesByFile: ReadonlyMap<string, readonly SourcePatch[]>;
  readonly selectionAfter?: readonly ElementLocator[];
  readonly coalesceKey?: string;
}

export type EditorTransactionErrorCode =
  | 'invalid-transaction'
  | 'invalid-id'
  | 'invalid-label'
  | 'invalid-patches-by-file'
  | 'invalid-file-path'
  | 'invalid-selection'
  | 'invalid-coalesce-key';

export class EditorTransactionError extends Error {
  constructor(readonly code: EditorTransactionErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'EditorTransactionError';
  }
}

export function normalizeEditorTransaction(candidate: EditorTransaction): EditorTransaction {
  try {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new EditorTransactionError('invalid-transaction', 'An editor transaction must be an object.');
    }
    const { id, label, patchesByFile, selectionAfter, coalesceKey } = candidate;
    if (typeof id !== 'string' || id.length === 0) {
      throw new EditorTransactionError('invalid-id', 'An editor transaction requires a nonempty exact id.');
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new EditorTransactionError('invalid-label', 'An editor transaction requires a nonempty exact label.');
    }
    if (!isReadonlyMap(patchesByFile)) {
      throw new EditorTransactionError('invalid-patches-by-file', 'patchesByFile must be a Map-like collection.');
    }
    if (coalesceKey !== undefined && (typeof coalesceKey !== 'string' || coalesceKey.length === 0)) {
      throw new EditorTransactionError('invalid-coalesce-key', 'coalesceKey must be a nonempty string when provided.');
    }

    const copiedPatches = new Map<string, readonly SourcePatch[]>();
    for (const [path, patches] of patchesByFile) {
      if (typeof path !== 'string' || path.length === 0) {
        throw new EditorTransactionError('invalid-file-path', 'Each patched file requires a nonempty exact path.');
      }
      if (!Array.isArray(patches)) {
        throw new EditorTransactionError('invalid-patches-by-file', `Patches for ${path} must be an array.`);
      }
      copiedPatches.set(path, Object.freeze(patches.map((patch) => Object.freeze({
        start: patch.start,
        end: patch.end,
        replacement: patch.replacement,
      }))));
    }

    return Object.freeze({
      id,
      label,
      patchesByFile: new ImmutableMap(copiedPatches),
      ...(selectionAfter === undefined ? {} : { selectionAfter: copySelection(selectionAfter) }),
      ...(coalesceKey === undefined ? {} : { coalesceKey }),
    });
  } catch (error) {
    if (error instanceof EditorTransactionError) throw error;
    throw new EditorTransactionError('invalid-transaction', 'The editor transaction could not be snapshotted.', error);
  }
}

export function copyEditorTransaction(transaction: EditorTransaction): EditorTransaction {
  return normalizeEditorTransaction(transaction);
}

function copySelection(candidate: unknown): readonly ElementLocator[] {
  if (!Array.isArray(candidate)) {
    throw new EditorTransactionError('invalid-selection', 'selectionAfter must be an array when provided.');
  }
  try {
    return Object.freeze(candidate.map((locator) => {
      if (typeof locator !== 'object' || locator === null) throw new TypeError('Invalid locator.');
      return copyLocator(locator as ElementLocator);
    }));
  } catch (error) {
    throw new EditorTransactionError('invalid-selection', 'selectionAfter could not be snapshotted.', error);
  }
}

function copyLocator(locator: ElementLocator): ElementLocator {
  return Object.freeze({
    qualifiedTag: locator.qualifiedTag,
    childPath: Object.freeze([...locator.childPath]),
    ancestorTags: Object.freeze([...locator.ancestorTags]),
    attributeHints: Object.freeze(locator.attributeHints.map((hint) => Object.freeze({ name: hint.name, value: hint.value }))),
    ...(locator.authoredName === undefined ? {} : { authoredName: locator.authoredName }),
  });
}

function isReadonlyMap(candidate: unknown): candidate is ReadonlyMap<unknown, unknown> {
  return typeof candidate === 'object' && candidate !== null && typeof (candidate as ReadonlyMap<unknown, unknown>)[Symbol.iterator] === 'function';
}
