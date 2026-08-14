import { applyPatches, type SourcePatch } from '../commands/SourcePatch';

export type NewlineStyle = 'none' | 'lf' | 'crlf' | 'mixed';

export class SourceBuffer {
  readonly newlineStyle: NewlineStyle;

  constructor(
    readonly path: string,
    readonly text: string,
  ) {
    this.newlineStyle = observeNewlineStyle(text);
    Object.freeze(this);
  }

  apply(patches: readonly SourcePatch[]): SourceBuffer {
    return new SourceBuffer(this.path, applyPatches(this.text, patches));
  }
}

function observeNewlineStyle(text: string): NewlineStyle {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return 'none';
  if (crlf === 0) return 'lf';
  if (lf === 0) return 'crlf';
  return 'mixed';
}
