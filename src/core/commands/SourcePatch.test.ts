import { describe, expect, it } from 'vitest';
import {
  applyPatches,
  invertPatches,
  SourcePatchValidationError,
  validatePatchSet,
  type SourcePatch,
} from './SourcePatch';
import { SourceBuffer } from '../documents/SourceBuffer';

describe('SourcePatch', () => {
  it('applies non-overlapping edits from highest source offsets to lowest', () => {
    const patches = [
      { start: 1, end: 2, replacement: 'X' },
      { start: 4, end: 4, replacement: '!' },
    ] as const;

    expect(applyPatches('abcde', patches)).toBe('aXcd!e');
  });

  it('normalizes a copy without mutating the caller patch array or patches', () => {
    const first = { start: 3, end: 4, replacement: 'D' };
    const second = { start: 0, end: 1, replacement: 'A' };
    const patches = [first, second];

    const validation = validatePatchSet('abcd', patches);

    expect(validation).toMatchObject({ ok: true });
    expect(patches).toEqual([first, second]);
    expect(validation.ok && validation.patches).toEqual([second, first]);
    expect(validation.ok && Object.isFrozen(validation.patches)).toBe(true);
    expect(validation.ok && Object.isFrozen(validation.patches[0])).toBe(true);
  });

  it('returns a structured editor-owned result for invalid patches', () => {
    const validation = validatePatchSet('abc', [{ start: 0, end: 4, replacement: 'x' }]);

    expect(validation).toEqual({
      ok: false,
      error: {
        code: 'out-of-range',
        patchIndex: 0,
        message: 'Patch 0 ends at 4, outside source length 3.',
      },
    });
    expect(Object.isFrozen(validation)).toBe(true);
    expect(!validation.ok && Object.isFrozen(validation.error)).toBe(true);
  });

  it.each([
    ['non-integer start', [{ start: 0.5, end: 1, replacement: '' }], 'non-integer'],
    ['negative start', [{ start: -1, end: 0, replacement: '' }], 'negative-offset'],
    ['reversed span', [{ start: 2, end: 1, replacement: '' }], 'reversed-span'],
    ['out-of-range end', [{ start: 0, end: 4, replacement: '' }], 'out-of-range'],
  ])('rejects %s', (_label, patches, code) => {
    const validation = validatePatchSet('abc', patches);

    expect(validation).toMatchObject({ ok: false, error: { code } });
    expect(() => applyPatches('abc', patches)).toThrow(SourcePatchValidationError);
    expect(() => invertPatches('abc', patches)).toThrow(SourcePatchValidationError);
  });

  it('rejects overlapping patches and reports the conflicting caller indices', () => {
    const patches = [
      { start: 0, end: 2, replacement: 'x' },
      { start: 1, end: 3, replacement: 'y' },
    ];

    const validation = validatePatchSet('abc', patches);

    expect(validation).toMatchObject({
      ok: false,
      error: { code: 'overlap', patchIndex: 1, conflictingPatchIndex: 0 },
    });
    expect(() => applyPatches('abc', patches)).toThrow(/overlap/i);
  });

  it('rejects same-start combinations, including same-position insertions', () => {
    for (const patches of [
      [
        { start: 1, end: 1, replacement: 'x' },
        { start: 1, end: 1, replacement: 'y' },
      ],
      [
        { start: 1, end: 2, replacement: 'x' },
        { start: 1, end: 1, replacement: 'y' },
      ],
    ]) {
      const validation = validatePatchSet('abc', patches);
      expect(validation).toMatchObject({ ok: false, error: { code: 'ambiguous-same-start' } });
      expect(() => applyPatches('abc', patches)).toThrow(/same start/i);
    }
  });

  it('allows adjacent disjoint edits and insertion immediately after a replacement', () => {
    const patches = [
      { start: 0, end: 1, replacement: 'A' },
      { start: 1, end: 2, replacement: 'B' },
      { start: 2, end: 2, replacement: '!' },
    ];

    expect(validatePatchSet('abc', patches)).toMatchObject({ ok: true });
    expect(applyPatches('abc', patches)).toBe('AB!c');
  });

  it('allows insertions at source boundaries', () => {
    expect(applyPatches('abc', [{ start: 0, end: 0, replacement: '<' }])).toBe('<abc');
    expect(applyPatches('abc', [{ start: 3, end: 3, replacement: '>' }])).toBe('abc>');
  });

  it('treats offsets as JavaScript UTF-16 code-unit indices and protects surrogate pairs', () => {
    const source = 'A😀B';

    expect(applyPatches(source, [{ start: 1, end: 3, replacement: 'X' }])).toBe('AXB');
    for (const patch of [
      { start: 1, end: 2, replacement: '' },
      { start: 2, end: 3, replacement: '' },
      { start: 2, end: 2, replacement: 'x' },
    ]) {
      expect(validatePatchSet(source, [patch])).toMatchObject({
        ok: false,
        error: { code: 'surrogate-boundary' },
      });
    }
  });

  it('inverts length-changing, adjacent patches against transformed-output offsets', () => {
    const source = 'a\r\n😀 &amp; \"quoted\"\u00a0text';
    const patches = [
      { start: 0, end: 0, replacement: '<ui:Label>' },
      { start: 1, end: 3, replacement: '\n' },
      { start: 3, end: 5, replacement: '!' },
      { start: source.length, end: source.length, replacement: '</ui:Label>' },
    ];

    const transformed = applyPatches(source, patches);
    const inverse = invertPatches(source, patches);

    expect(applyPatches(transformed, inverse)).toBe(source);
    expect(inverse).toEqual([
      { start: 0, end: 10, replacement: '' },
      { start: 11, end: 13, replacement: '\r\n😀' },
      { start: transformed.length - 11, end: transformed.length, replacement: '' },
    ]);
    expect(Object.isFrozen(inverse)).toBe(true);
  });

  it('coalesces inverse patches when adjacent deletions map to one output position', () => {
    const source = 'abcd';
    const patches = [
      { start: 0, end: 1, replacement: '' },
      { start: 1, end: 3, replacement: '' },
    ];

    const inverse = invertPatches(source, patches);

    expect(inverse).toEqual([{ start: 0, end: 0, replacement: 'abc' }]);
    expect(applyPatches(applyPatches(source, patches), inverse)).toBe(source);
  });

  it('preserves exact source value for no-op patches and accepts empty patch sets', () => {
    const source = 'line\r\n😀 &amp; \"quotes\"\u00a0';
    const noOp = [{ start: 0, end: source.length, replacement: source }];

    expect(applyPatches(source, [])).toBe(source);
    expect(applyPatches(source, noOp)).toBe(source);
    expect(invertPatches(source, [])).toEqual([]);
    expect(applyPatches(applyPatches(source, noOp), invertPatches(source, noOp))).toBe(source);
  });

  it('round-trips deterministic exhaustive valid patch combinations over small sources', () => {
    for (const source of ['', 'a', 'ab', 'a\r\nb', '😀']) {
      const boundaries = validBoundaries(source);
      const individual = boundaries.flatMap((start) =>
        boundaries
          .filter((end) => end >= start)
          .flatMap((end) => ['', 'X'].map((replacement) => ({ start, end, replacement }))),
      );

      for (const first of individual) {
        for (const second of individual) {
          const patches = [first, second];
          const validation = validatePatchSet(source, patches);
          if (!validation.ok) continue;

          const transformed = applyPatches(source, patches);
          expect(applyPatches(transformed, invertPatches(source, patches))).toBe(source);
        }
      }
    }
  });
});

describe('SourceBuffer', () => {
  it('keeps an exact immutable path/text buffer and returns a new buffer when patched', () => {
    const original = new SourceBuffer('Assets/UI/Menu.uxml', '<ui:Label />\r\n');
    const next = original.apply([{ start: 4, end: 9, replacement: 'Button' }]);

    expect(next).not.toBe(original);
    expect(next.path).toBe('Assets/UI/Menu.uxml');
    expect(next.text).toBe('<ui:Button />\r\n');
    expect(next.newlineStyle).toBe('crlf');
    expect(original.text).toBe('<ui:Label />\r\n');
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(next)).toBe(true);
  });
});

function validBoundaries(source: string): number[] {
  const boundaries: number[] = [];
  for (let offset = 0; offset <= source.length; offset += 1) {
    const before = source.charCodeAt(offset - 1);
    const after = source.charCodeAt(offset);
    if (!(isHighSurrogate(before) && isLowSurrogate(after))) boundaries.push(offset);
  }
  return boundaries;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
