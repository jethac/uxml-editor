import type { EditorSourceSpan, EditorStylesheet, EditorUssDeclaration, EditorUssRule } from './types';

interface ParsedStyleSheet {
  readonly items: readonly ParsedSheetItem[];
}

type ParsedSheetItem = {
  readonly kind: 'rule';
  readonly rule: {
    readonly span: { readonly start: number; readonly end: number };
    readonly selectorSpan: { readonly start: number; readonly end: number };
    readonly declarations: readonly {
      readonly property: string;
      readonly value: string;
      readonly span: { readonly start: number; readonly end: number };
    }[];
  };
} | { readonly kind: 'import' | 'unknown' };

export function editorStylesheetFromParsed(path: string, sheet: ParsedStyleSheet | undefined): EditorStylesheet {
  const rules: EditorUssRule[] = [];
  if (sheet !== undefined) {
    sheet.items.forEach((item, itemIndex) => {
      if (item.kind !== 'rule') return;
      rules.push(Object.freeze({
        itemIndex,
        source: span(path, item.rule.span.start, item.rule.span.end),
        selectorSource: span(path, item.rule.selectorSpan.start, item.rule.selectorSpan.end),
        declarations: Object.freeze(item.rule.declarations.map((declaration, declarationIndex) => Object.freeze({
          declarationIndex,
          property: declaration.property,
          value: declaration.value,
          source: span(path, declaration.span.start, declaration.span.end),
        }))),
      }));
    });
  }
  return Object.freeze({ path, rules: Object.freeze(rules) });
}

export function parseEditorDeclarationList(
  path: string,
  declarations: readonly EditorUssDeclaration[],
  start: number,
) {
  const prefixLength = '__inline__ {'.length;
  return Object.freeze(declarations.map((declaration) => Object.freeze({
    declarationIndex: declaration.declarationIndex,
    property: declaration.property,
    value: declaration.value,
    source: span(
      path,
      start + declaration.source.start - prefixLength,
      start + declaration.source.end - prefixLength,
    ),
  })));
}

function span(path: string, start: number, end: number): EditorSourceSpan {
  return Object.freeze({ path, start, end });
}
