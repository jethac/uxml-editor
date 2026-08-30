import { describe, expect, it } from 'vitest';
import { isCustomUssProperty, isKnownUssProperty, unityUssPropertyNames } from './ussProperties';

describe('ussProperties', () => {
  it.each([
    'width',
    'flex-grow',
    '-unity-text-align',
    '-unity-slice-scale',
    'transition-timing-function',
    'all',
  ])('accepts the Unity 6.3 property %s', (property) => {
    expect(isKnownUssProperty(property)).toBe(true);
  });

  it.each([
    '-unity-bogus-property',
    'colour',
    'box-shadow',
    'z-index',
    'Width',
    '',
  ])('rejects %s, which Unity drops', (property) => {
    expect(isKnownUssProperty(property)).toBe(false);
  });

  it('treats every custom property as known, since authors define them', () => {
    expect(isCustomUssProperty('--brand-primary')).toBe(true);
    expect(isKnownUssProperty('--brand-primary')).toBe(true);
  });

  it('exposes a sorted, deduplicated name list', () => {
    const names = unityUssPropertyNames();

    expect(names).toEqual([...new Set(names)].sort());
    expect(names).toContain('-unity-paragraph-spacing');
  });
});
