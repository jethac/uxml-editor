import type { SourcePatch } from './SourcePatch';

type Segment =
  | { readonly kind: 'original'; readonly start: number; readonly end: number }
  | { readonly kind: 'inserted'; readonly text: string };

export class SequentialPatchComposer {
  private readonly segments: Segment[];

  constructor(private readonly original: string) {
    this.segments = original.length === 0
      ? []
      : [{ kind: 'original', start: 0, end: original.length }];
  }

  apply(patches: readonly SourcePatch[]): void {
    const ordered = [...patches].sort((left, right) => right.start - left.start);
    for (const patch of ordered) {
      if (
        !Number.isInteger(patch.start)
        || !Number.isInteger(patch.end)
        || patch.start < 0
        || patch.end < patch.start
        || patch.end > this.length()
      ) throw new TypeError('A sequential patch is outside the current composed source.');
      const startIndex = this.splitAt(patch.start);
      const endIndex = this.splitAt(patch.end);
      this.segments.splice(
        startIndex,
        endIndex - startIndex,
        ...(patch.replacement.length === 0 ? [] : [{ kind: 'inserted' as const, text: patch.replacement }]),
      );
    }
  }

  patches(): readonly SourcePatch[] {
    const result: SourcePatch[] = [];
    let originalCursor = 0;
    let replacement = '';
    for (const segment of this.segments) {
      if (segment.kind === 'inserted') {
        replacement += segment.text;
        continue;
      }
      if (segment.start < originalCursor) throw new TypeError('Composed original segments are not monotonic.');
      if (segment.start > originalCursor || replacement.length > 0) {
        appendChangedPatch(result, this.original, originalCursor, segment.start, replacement);
        replacement = '';
      }
      originalCursor = segment.end;
    }
    if (originalCursor < this.original.length || replacement.length > 0) {
      appendChangedPatch(result, this.original, originalCursor, this.original.length, replacement);
    }
    return Object.freeze(result.map((patch) => Object.freeze(patch)));
  }

  private splitAt(offset: number): number {
    let cursor = 0;
    for (let index = 0; index < this.segments.length; index += 1) {
      const segment = this.segments[index];
      const length = segmentLength(segment);
      if (offset === cursor) return index;
      if (offset < cursor + length) {
        const relative = offset - cursor;
        const [left, right] = splitSegment(segment, relative);
        this.segments.splice(index, 1, left, right);
        return index + 1;
      }
      cursor += length;
    }
    if (offset === cursor) return this.segments.length;
    throw new TypeError('A sequential patch split is outside the current source.');
  }

  private length(): number {
    return this.segments.reduce((total, segment) => total + segmentLength(segment), 0);
  }
}

function segmentLength(segment: Segment): number {
  return segment.kind === 'original' ? segment.end - segment.start : segment.text.length;
}

function splitSegment(segment: Segment, offset: number): readonly [Segment, Segment] {
  if (segment.kind === 'original') {
    return [
      { kind: 'original', start: segment.start, end: segment.start + offset },
      { kind: 'original', start: segment.start + offset, end: segment.end },
    ];
  }
  return [
    { kind: 'inserted', text: segment.text.slice(0, offset) },
    { kind: 'inserted', text: segment.text.slice(offset) },
  ];
}

function appendChangedPatch(
  result: SourcePatch[],
  original: string,
  start: number,
  end: number,
  replacement: string,
): void {
  if (original.slice(start, end) === replacement) return;
  result.push({ start, end, replacement });
}
