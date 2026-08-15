import { describe, expect, it } from 'vitest';
import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import type { EditorElement } from '../adapter/types';
import { DocumentSession } from './DocumentSession';
import { SHORTHAND_LONGHANDS } from './styleCascadeCandidates';
import { styleTargetsFor } from './StyleTarget';

const ENTRY_PATH = 'Assets/UI/screen.uxml';
const SHEET_PATH = 'Assets/UI/styles/screen.uss';

const PINNED_AGGREGATE_SHORTHANDS = {
  margin: {
    value: '1px 2px 3px 4px',
    longhands: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  },
  padding: {
    value: '5px 6px 7px 8px',
    longhands: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  },
  'border-width': {
    value: '1px 2px 3px 4px',
    longhands: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  },
  'border-color': {
    value: 'red green blue black',
    longhands: ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  },
  'border-radius': {
    value: '1px 2px 3px 4px',
    longhands: [
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
    ],
  },
  flex: {
    value: '2 3 10px',
    longhands: ['flex-grow', 'flex-shrink', 'flex-basis'],
  },
} as const;

describe('pinned aggregate shorthand provenance', () => {
  it('characterizes every uxml-preview 0.4.0 aggregate shorthand and longhand relation', () => {
    expect(SHORTHAND_LONGHANDS).toEqual(Object.fromEntries(
      Object.entries(PINNED_AGGREGATE_SHORTHANDS).map(([shorthand, fixture]) => [shorthand, fixture.longhands]),
    ));

    for (const [shorthand, fixture] of Object.entries(PINNED_AGGREGATE_SHORTHANDS)) {
      const session = openSession(`#save { ${shorthand}: ${fixture.value}; }\n`);
      const button = nodeByName(session.document.root, 'save');

      for (const longhand of fixture.longhands) {
        const explanation = session.adapter.explain(session.document, button.id, longhand);
        const authoredCandidate = explanation?.candidates.find(
          (candidate) => candidate.origin.kind === 'rule',
        );
        const target = styleTargetsFor(session, button, longhand, [])
          .find((candidate) => candidate.kind === 'rule');

        expect(authoredCandidate, `${shorthand} -> ${longhand}`).toEqual(expect.objectContaining({
          property: longhand,
          winner: true,
          origin: expect.objectContaining({ kind: 'rule', declarationIndex: 0 }),
        }));
        expect(target, `${shorthand} target for ${longhand}`).toEqual(expect.objectContaining({
          kind: 'rule',
          property: longhand,
          declarationIndex: null,
          authoredProperty: shorthand,
          originDeclarationIndex: 0,
          winner: true,
        }));
      }

      expect(styleTargetsFor(session, button, shorthand, []).filter((target) => target.kind === 'rule'))
        .toEqual([expect.objectContaining({
          property: shorthand,
          declarationIndex: 0,
          authoredProperty: shorthand,
          value: fixture.value,
          winner: true,
        })]);
    }
  });
});

function openSession(sheet: string): DocumentSession {
  return DocumentSession.open(new Map([
    [ENTRY_PATH, `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`],
    [SHEET_PATH, sheet],
  ]), ENTRY_PATH, new UxmlPreviewAdapter());
}

function nodeByName(root: EditorElement, name: string): EditorElement {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name)) {
      return current;
    }
    pending.push(...current.children);
  }
  throw new Error(`Missing node ${name}.`);
}
