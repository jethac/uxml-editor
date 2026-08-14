/**
 * SourcePatch offsets are JavaScript UTF-16 code-unit indices, matching pinned
 * upstream spans and String.prototype.slice indices.
 */
export interface SourcePatch {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export type PatchValidationCode =
  | 'invalid-patch'
  | 'invalid-replacement'
  | 'non-integer'
  | 'negative-offset'
  | 'reversed-span'
  | 'out-of-range'
  | 'surrogate-boundary'
  | 'overlap'
  | 'ambiguous-same-start';

export interface PatchValidationIssue {
  readonly code: PatchValidationCode;
  readonly patchIndex: number;
  readonly conflictingPatchIndex?: number;
  readonly message: string;
}

export type PatchValidation =
  | { readonly ok: true; readonly patches: readonly SourcePatch[] }
  | { readonly ok: false; readonly error: PatchValidationIssue };

interface IndexedPatch extends SourcePatch {
  readonly patchIndex: number;
}

interface PatchSnapshot {
  readonly start: unknown;
  readonly end: unknown;
  readonly replacement: unknown;
}

type NormalizedPatchValidation =
  | { readonly ok: true; readonly patches: readonly IndexedPatch[] }
  | { readonly ok: false; readonly error: PatchValidationIssue };

type PatchSnapshotValidation =
  | { readonly ok: true; readonly patch: PatchSnapshot }
  | { readonly ok: false; readonly error: PatchValidationIssue };

export class SourcePatchValidationError extends Error {
  readonly issue: PatchValidationIssue;

  constructor(issue: PatchValidationIssue) {
    super(issue.message);
    this.name = 'SourcePatchValidationError';
    this.issue = issue;
  }
}

export function validatePatchSet(source: string, patches: readonly SourcePatch[]): PatchValidation {
  const normalized = normalizePatchSet(source, patches);
  if (!normalized.ok) return invalid(normalized.error);

  const inverseBoundaryIssue = validateInverseBoundaries(source, normalized.patches);
  if (inverseBoundaryIssue) return invalid(inverseBoundaryIssue);

  return valid(normalized.patches);
}

export function applyPatches(source: string, patches: readonly SourcePatch[]): string {
  return applyNormalizedPatches(source, requireValidPatchSet(source, patches));
}

export function invertPatches(source: string, patches: readonly SourcePatch[]): readonly SourcePatch[] {
  return invertNormalizedPatches(source, requireValidPatchSet(source, patches));
}

function normalizePatchSet(source: string, patches: readonly SourcePatch[]): NormalizedPatchValidation {
  const indexed: IndexedPatch[] = [];

  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const snapshot = snapshotPatch(patches[patchIndex], patchIndex);
    if (!snapshot.ok) return snapshot;
    const patch = snapshot.patch;
    const issue = validatePatch(source, patch, patchIndex);
    if (issue) return invalidNormalized(issue);
    indexed.push(Object.freeze({
      start: patch.start as number,
      end: patch.end as number,
      replacement: patch.replacement as string,
      patchIndex,
    }));
  }

  indexed.sort(comparePatches);
  for (let index = 1; index < indexed.length; index += 1) {
    const previous = indexed[index - 1];
    const current = indexed[index];
    if (current.start === previous.start) {
      return invalidNormalized({
        code: 'ambiguous-same-start',
        patchIndex: current.patchIndex,
        conflictingPatchIndex: previous.patchIndex,
        message: `Patch ${current.patchIndex} has the same start ${current.start} as patch ${previous.patchIndex}.`,
      });
    }
    if (current.start < previous.end) {
      return invalidNormalized({
        code: 'overlap',
        patchIndex: current.patchIndex,
        conflictingPatchIndex: previous.patchIndex,
        message: `Patch ${current.patchIndex} overlaps patch ${previous.patchIndex}.`,
      });
    }
  }

  return Object.freeze({ ok: true as const, patches: Object.freeze(indexed) });
}

function applyNormalizedPatches(source: string, normalized: readonly SourcePatch[]): string {
  const chunks: string[] = [];
  let cursor = source.length;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const patch = normalized[index];
    chunks.push(source.slice(patch.end, cursor), patch.replacement);
    cursor = patch.start;
  }

  chunks.push(source.slice(0, cursor));
  chunks.reverse();
  return chunks.join('');
}

function invertNormalizedPatches(source: string, normalized: readonly SourcePatch[]): readonly SourcePatch[] {
  const inverse: SourcePatch[] = [];
  let offsetDelta = 0;
  let groupStartIndex = 0;

  while (groupStartIndex < normalized.length) {
    let groupEndIndex = groupStartIndex;
    let transformedLength = normalized[groupStartIndex].replacement.length;

    while (
      groupEndIndex + 1 < normalized.length
      && normalized[groupEndIndex + 1].start === normalized[groupEndIndex].end
    ) {
      groupEndIndex += 1;
      transformedLength += normalized[groupEndIndex].replacement.length;
    }

    const first = normalized[groupStartIndex];
    const last = normalized[groupEndIndex];
    const start = first.start + offsetDelta;
    inverse.push(Object.freeze({
      start,
      end: start + transformedLength,
      replacement: source.slice(first.start, last.end),
    }));
    offsetDelta += transformedLength - (last.end - first.start);
    groupStartIndex = groupEndIndex + 1;
  }

  return Object.freeze(inverse);
}

function validateInverseBoundaries(source: string, normalized: readonly IndexedPatch[]): PatchValidationIssue | null {
  let groupStartIndex = 0;

  while (groupStartIndex < normalized.length) {
    let groupEndIndex = groupStartIndex;
    let firstNonempty: IndexedPatch | undefined;
    let lastNonempty: IndexedPatch | undefined;

    do {
      const patch = normalized[groupEndIndex];
      if (patch.replacement.length > 0) {
        firstNonempty ??= patch;
        lastNonempty = patch;
      }
      if (
        groupEndIndex + 1 >= normalized.length
        || normalized[groupEndIndex + 1].start !== patch.end
      ) {
        break;
      }
      groupEndIndex += 1;
    } while (true);

    const first = normalized[groupStartIndex];
    const last = normalized[groupEndIndex];
    const before = source.charCodeAt(first.start - 1);
    const after = source.charCodeAt(last.end);
    const startBoundaryAfter = firstNonempty
      ? firstNonempty.replacement.charCodeAt(0)
      : after;
    const endBoundaryBefore = lastNonempty
      ? lastNonempty.replacement.charCodeAt(lastNonempty.replacement.length - 1)
      : before;

    if (isHighSurrogate(before) && isLowSurrogate(startBoundaryAfter)) {
      const causalPatch = firstNonempty ?? first;
      return issue(
        'surrogate-boundary',
        causalPatch.patchIndex,
        `Patch ${causalPatch.patchIndex} would make its inverse split a UTF-16 surrogate pair.`,
      );
    }
    if (isHighSurrogate(endBoundaryBefore) && isLowSurrogate(after)) {
      const causalPatch = lastNonempty ?? first;
      return issue(
        'surrogate-boundary',
        causalPatch.patchIndex,
        `Patch ${causalPatch.patchIndex} would make its inverse split a UTF-16 surrogate pair.`,
      );
    }

    groupStartIndex = groupEndIndex + 1;
  }

  return null;
}

function requireValidPatchSet(source: string, patches: readonly SourcePatch[]): readonly SourcePatch[] {
  const validation = validatePatchSet(source, patches);
  if (!validation.ok) throw new SourcePatchValidationError(validation.error);
  return validation.patches;
}

function snapshotPatch(candidate: unknown, patchIndex: number): PatchSnapshotValidation {
  if (typeof candidate !== 'object' || candidate === null) {
    return invalidSnapshot(issue('invalid-patch', patchIndex, `Patch ${patchIndex} must be an object.`));
  }

  try {
    const patch = candidate as { start: unknown; end: unknown; replacement: unknown };
    return Object.freeze({
      ok: true as const,
      patch: Object.freeze({ start: patch.start, end: patch.end, replacement: patch.replacement }),
    });
  } catch {
    return invalidSnapshot(issue('invalid-patch', patchIndex, `Patch ${patchIndex} could not be read.`));
  }
}

function validatePatch(source: string, patch: PatchSnapshot, patchIndex: number): PatchValidationIssue | null {
  const { start, end, replacement } = patch;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)) {
    return issue('non-integer', patchIndex, `Patch ${patchIndex} has non-integer offsets.`);
  }
  if (typeof replacement !== 'string') {
    return issue('invalid-replacement', patchIndex, `Patch ${patchIndex} has a non-string replacement.`);
  }
  if (start < 0 || end < 0) {
    return issue('negative-offset', patchIndex, `Patch ${patchIndex} has a negative offset.`);
  }
  if (end < start) {
    return issue('reversed-span', patchIndex, `Patch ${patchIndex} ends before it starts.`);
  }
  if (start > source.length || end > source.length) {
    return issue('out-of-range', patchIndex, `Patch ${patchIndex} ends at ${end}, outside source length ${source.length}.`);
  }
  if (splitsSurrogatePair(source, start) || splitsSurrogatePair(source, end)) {
    return issue('surrogate-boundary', patchIndex, `Patch ${patchIndex} splits a UTF-16 surrogate pair.`);
  }
  return null;
}

function comparePatches(left: IndexedPatch, right: IndexedPatch): number {
  return left.start - right.start || left.end - right.end || left.patchIndex - right.patchIndex;
}

function splitsSurrogatePair(source: string, offset: number): boolean {
  return isHighSurrogate(source.charCodeAt(offset - 1)) && isLowSurrogate(source.charCodeAt(offset));
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function issue(code: PatchValidationCode, patchIndex: number, message: string): PatchValidationIssue {
  return Object.freeze({ code, patchIndex, message });
}

function invalid(error: PatchValidationIssue): PatchValidation {
  return Object.freeze({ ok: false as const, error: Object.freeze(error) });
}

function valid(indexed: readonly IndexedPatch[]): PatchValidation {
  return Object.freeze({
    ok: true as const,
    patches: Object.freeze(indexed.map(({ start, end, replacement }) => Object.freeze({ start, end, replacement }))),
  });
}

function invalidNormalized(error: PatchValidationIssue): NormalizedPatchValidation {
  return Object.freeze({ ok: false as const, error: Object.freeze(error) });
}

function invalidSnapshot(error: PatchValidationIssue): PatchSnapshotValidation {
  return Object.freeze({ ok: false as const, error: Object.freeze(error) });
}
