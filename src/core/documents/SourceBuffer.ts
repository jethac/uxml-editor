import { applyPatches, type SourcePatch } from '../commands/SourcePatch';

export type NewlineStyle = 'none' | 'lf' | 'crlf' | 'cr' | 'mixed';

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
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const styles = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (styles === 0) return 'none';
  if (styles > 1) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'cr';
}
