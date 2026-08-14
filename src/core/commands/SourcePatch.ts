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

export class SourcePatchValidationError extends Error {
  readonly issue: PatchValidationIssue;

  constructor(issue: PatchValidationIssue) {
    super(issue.message);
    this.name = 'SourcePatchValidationError';
    this.issue = issue;
  }
}

export function validatePatchSet(source: string, patches: readonly SourcePatch[]): PatchValidation {
  const indexed: IndexedPatch[] = [];

  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const patch = patches[patchIndex];
    const issue = validatePatch(source, patch, patchIndex);
    if (issue) return invalid(issue);
    indexed.push(Object.freeze({ ...patch, patchIndex }));
  }

  indexed.sort(comparePatches);
  for (let index = 1; index < indexed.length; index += 1) {
    const previous = indexed[index - 1];
    const current = indexed[index];
    if (current.start === previous.start) {
      return invalid({
        code: 'ambiguous-same-start',
        patchIndex: current.patchIndex,
        conflictingPatchIndex: previous.patchIndex,
        message: `Patch ${current.patchIndex} has the same start ${current.start} as patch ${previous.patchIndex}.`,
      });
    }
    if (current.start < previous.end) {
      return invalid({
        code: 'overlap',
        patchIndex: current.patchIndex,
        conflictingPatchIndex: previous.patchIndex,
        message: `Patch ${current.patchIndex} overlaps patch ${previous.patchIndex}.`,
      });
    }
  }

  return Object.freeze({
    ok: true as const,
    patches: Object.freeze(indexed.map(({ patchIndex: _patchIndex, ...patch }) => Object.freeze(patch))),
  });
}

export function applyPatches(source: string, patches: readonly SourcePatch[]): string {
  const normalized = requireValidPatchSet(source, patches);
  let result = source;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const patch = normalized[index];
    result = result.slice(0, patch.start) + patch.replacement + result.slice(patch.end);
  }

  return result;
}

export function invertPatches(source: string, patches: readonly SourcePatch[]): readonly SourcePatch[] {
  const normalized = requireValidPatchSet(source, patches);
  const inverse: SourcePatch[] = [];
  let offsetDelta = 0;

  for (const patch of normalized) {
    const start = patch.start + offsetDelta;
    const end = start + patch.replacement.length;
    const replacement = source.slice(patch.start, patch.end);
    const previous = inverse[inverse.length - 1];

    // Adjacent source edits can collapse to one transformed-output boundary.
    if (previous && start <= previous.end) {
      inverse[inverse.length - 1] = Object.freeze({
        start: previous.start,
        end: Math.max(previous.end, end),
        replacement: previous.replacement + replacement,
      });
    } else {
      inverse.push(Object.freeze({ start, end, replacement }));
    }
    offsetDelta += patch.replacement.length - (patch.end - patch.start);
  }

  return Object.freeze(inverse);
}

function requireValidPatchSet(source: string, patches: readonly SourcePatch[]): readonly SourcePatch[] {
  const validation = validatePatchSet(source, patches);
  if (!validation.ok) throw new SourcePatchValidationError(validation.error);
  return validation.patches;
}

function validatePatch(source: string, patch: SourcePatch, patchIndex: number): PatchValidationIssue | null {
  if (!Number.isInteger(patch.start) || !Number.isInteger(patch.end)) {
    return issue('non-integer', patchIndex, `Patch ${patchIndex} has non-integer offsets.`);
  }
  if (patch.start < 0 || patch.end < 0) {
    return issue('negative-offset', patchIndex, `Patch ${patchIndex} has a negative offset.`);
  }
  if (patch.end < patch.start) {
    return issue('reversed-span', patchIndex, `Patch ${patchIndex} ends before it starts.`);
  }
  if (patch.start > source.length || patch.end > source.length) {
    return issue('out-of-range', patchIndex, `Patch ${patchIndex} ends at ${patch.end}, outside source length ${source.length}.`);
  }
  if (splitsSurrogatePair(source, patch.start) || splitsSurrogatePair(source, patch.end)) {
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
