import { describe, expect, it } from 'vitest';
import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import type { EditorElement } from '../adapter/types';
import { normalizeEditorTransaction } from '../commands/EditorTransaction';
import { DocumentSession } from './DocumentSession';
import { StyleTargetError, styleTargetsFor } from './StyleTarget';

const ENTRY_PATH = 'Assets/UI/screen.uxml';
const SHEET_PATH = 'Assets/UI/styles/screen.uss';

describe('styleTargetsFor', () => {
  it('orders the winning and losing authored rules before inline and a new local rule', () => {
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" style="opacity: 0.5" />\n</ui:UXML>\n`,
      [SHEET_PATH]: `Button { width: 80px; }\n#save { width: 100px; }\n`,
    });
    const button = nodeByName(session.document.root, 'save');
    const state: string[] = [];

    const targets = styleTargetsFor(session, button, 'width', state);
    state.push('hover');

    expect(targets.map((target) => target.kind)).toEqual(['rule', 'rule', 'inline', 'new-rule']);
    expect(targets.slice(0, 2)).toEqual([
      expect.objectContaining({
        kind: 'rule',
        path: SHEET_PATH,
        sheetIndex: 0,
        itemIndex: 1,
        declarationIndex: 0,
        property: 'width',
        value: '100px',
        winner: true,
        state: [],
      }),
      expect.objectContaining({
        kind: 'rule',
        path: SHEET_PATH,
        sheetIndex: 0,
        itemIndex: 0,
        declarationIndex: 0,
        property: 'width',
        value: '80px',
        winner: false,
        state: [],
      }),
    ]);
    expect(targets[2]).toEqual(expect.objectContaining({
      kind: 'inline',
      path: ENTRY_PATH,
      nodeId: button.id,
      property: 'width',
      state: [],
    }));
    expect(targets[3]).toEqual(expect.objectContaining({
      kind: 'new-rule',
      path: SHEET_PATH,
      sheetIndex: 0,
      selector: '#save',
      property: 'width',
      state: [],
    }));
    expect(targets.map((target) => target.id)).toEqual(styleTargetsFor(session, button, 'width', []).map((target) => target.id));
    expect(Object.isFrozen(targets)).toBe(true);
    expect(targets.every(Object.isFrozen)).toBe(true);
    expect(targets.every((target) => Object.isFrozen(target.state))).toBe(true);
    expect(() => (targets as unknown[]).push({})).toThrow();
  });

  it('snapshots the requested node and every exact session source into each canonical target identity', () => {
    const upperPath = 'Assets/UI/A.uss';
    const lowerPath = 'Assets/UI/z.uss';
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="z.uss" />\n  <Style src="A.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [lowerPath]: '#save { width: 20px; }\n',
      [upperPath]: '#save { width: 10px; }\n',
    });
    const button = nodeByName(session.document.root, 'save');

    const targets = styleTargetsFor(session, button, 'width', []);

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target).toEqual(expect.objectContaining({
        nodeId: button.id,
        locator: expect.objectContaining({ authoredName: 'save' }),
        sessionSources: [
          { path: upperPath, text: '#save { width: 10px; }\n' },
          { path: ENTRY_PATH, text: expect.stringContaining('<ui:Button name="save" />') },
          { path: lowerPath, text: '#save { width: 20px; }\n' },
        ],
      }));
      expect(target.id.startsWith('style-target:v2:')).toBe(true);
      expect(target.id.length).toBeGreaterThan(100);
      expect(Object.isFrozen(target.locator)).toBe(true);
      expect(Object.isFrozen(target.sessionSources)).toBe(true);
      expect(target.sessionSources.every(Object.isFrozen)).toBe(true);
    }
    expect(targets.map((target) => target.id)).toEqual(
      styleTargetsFor(session, button, 'width', []).map((target) => target.id),
    );
  });

  it('uses only the exact requested pseudo-state and canonicalizes caller state order', () => {
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" style="width: 5px" />\n</ui:UXML>\n`,
      [SHEET_PATH]: `#save { width: 80px; }\n#save:hover { width: 90px; }\n#save:active { width: 100px; }\n#save:hover:active { width: 110px; }\n`,
    });
    const button = nodeByName(session.document.root, 'save');

    const targets = styleTargetsFor(session, button, 'width', ['hover', 'active']);

    expect(targets.map((target) => target.kind)).toEqual(['rule', 'new-rule']);
    expect(targets[0]).toEqual(expect.objectContaining({
      kind: 'rule', value: '110px', state: ['active', 'hover'],
    }));
    expect(targets[1]).toEqual(expect.objectContaining({
      kind: 'new-rule', selector: '#save:active:hover', state: ['active', 'hover'],
    }));
  });

  it('rejects pseudo-state targeting without one unique parser-safe authored name', () => {
    for (const entry of [
      `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:VisualElement class="parent"><ui:Button class="child" /></ui:VisualElement>\n</ui:UXML>\n`,
      `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:VisualElement class="parent"><ui:Button name="child" class="child" /></ui:VisualElement>\n  <ui:Button name="child" />\n</ui:UXML>\n`,
    ]) {
      const session = openSession({
        [ENTRY_PATH]: entry,
        [SHEET_PATH]: '.parent:hover .child { width: 90px; }\n',
      });
      const child = nodesByClass(session.document.root, 'child')[0];

      expect(() => styleTargetsFor(session, child, 'width', ['hover'])).toThrowError(expect.objectContaining({
        name: 'StyleTargetError',
        code: 'ambiguous-state',
      } satisfies Partial<StyleTargetError>));
    }
  });

  it('offers local longhand overrides for shorthand origins without replacing sibling longhands', () => {
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [SHEET_PATH]: '#save { margin: 1px 2px; margin-left: 3px; margin: 4px; }\n',
    });
    const button = nodeByName(session.document.root, 'save');

    const longhandRules = styleTargetsFor(session, button, 'margin-left', [])
      .filter((target) => target.kind === 'rule');
    const exactShorthand = styleTargetsFor(session, button, 'margin', [])
      .filter((target) => target.kind === 'rule');
    const inlineSession = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <ui:Button name="save" style="margin: 5px 6px" />\n</ui:UXML>\n`,
    });
    const inline = styleTargetsFor(
      inlineSession,
      nodeByName(inlineSession.document.root, 'save'),
      'margin-right',
      [],
    ).find((target) => target.kind === 'inline');

    expect(longhandRules).toEqual([
      expect.objectContaining({
        declarationIndex: null,
        authoredProperty: 'margin',
        originDeclarationIndex: 2,
        winner: true,
      }),
      expect.objectContaining({
        declarationIndex: 1,
        authoredProperty: 'margin-left',
        originDeclarationIndex: 1,
        winner: false,
      }),
      expect.objectContaining({
        declarationIndex: null,
        authoredProperty: 'margin',
        originDeclarationIndex: 0,
        winner: false,
      }),
    ]);
    expect(inline).toEqual(expect.objectContaining({
      declarationIndex: null,
      authoredProperty: 'margin',
      originDeclarationIndex: 0,
    }));
    expect(exactShorthand).toEqual([
      expect.objectContaining({ declarationIndex: 2, authoredProperty: 'margin', value: '4px' }),
      expect.objectContaining({ declarationIndex: 0, authoredProperty: 'margin', value: '1px 2px' }),
    ]);
  });

  it('orders winning and losing flex shorthand origins and collects exact flex targets', () => {
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [SHEET_PATH]: 'Button { flex: 1 1 0; }\n#save { flex-grow: 2; flex: 3 4 10px; }\n',
    });
    const button = nodeByName(session.document.root, 'save');

    const grow = styleTargetsFor(session, button, 'flex-grow', []).filter((target) => target.kind === 'rule');
    const exact = styleTargetsFor(session, button, 'flex', []).filter((target) => target.kind === 'rule');

    expect(grow).toEqual([
      expect.objectContaining({
        itemIndex: 1,
        declarationIndex: null,
        authoredProperty: 'flex',
        originDeclarationIndex: 1,
        winner: true,
      }),
      expect.objectContaining({
        itemIndex: 1,
        declarationIndex: 0,
        authoredProperty: 'flex-grow',
        winner: false,
      }),
      expect.objectContaining({
        itemIndex: 0,
        declarationIndex: null,
        authoredProperty: 'flex',
        originDeclarationIndex: 0,
        winner: false,
      }),
    ]);
    expect(exact).toEqual([
      expect.objectContaining({ itemIndex: 1, declarationIndex: 1, authoredProperty: 'flex', value: '3 4 10px' }),
      expect.objectContaining({ itemIndex: 0, declarationIndex: 0, authoredProperty: 'flex', value: '1 1 0' }),
    ]);
    expect(grow.map((target) => target.id)).toEqual(
      styleTargetsFor(session, button, 'flex-grow', [])
        .filter((target) => target.kind === 'rule')
        .map((target) => target.id),
    );
  });

  it('points inherited values at the real authored inline origin without inventing builtin or default sources', () => {
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:VisualElement name="parent" style='color: #123456'>\n    <ui:VisualElement name="child" />\n    <ui:Button name="button" />\n  </ui:VisualElement>\n</ui:UXML>\n`,
      [SHEET_PATH]: `#parent { font-size: 18px; }\n.unused { opacity: 0.2; }\n`,
    });
    const parent = nodeByName(session.document.root, 'parent');
    const child = nodeByName(session.document.root, 'child');
    const button = nodeByName(session.document.root, 'button');

    const inherited = styleTargetsFor(session, child, 'color', []);
    const inheritedRule = styleTargetsFor(session, child, 'font-size', []);
    const builtin = styleTargetsFor(session, button, 'margin-left', []);
    const fallback = styleTargetsFor(session, child, 'height', []);
    const inheritedState = styleTargetsFor(session, child, 'color', ['hover']);

    expect(inherited.map((target) => target.kind)).toEqual(['inline', 'inline', 'new-rule']);
    expect(inherited[0]).toEqual(expect.objectContaining({
      kind: 'inline', nodeId: child.id, authoredNodeId: parent.id, declarationIndex: 0,
    }));
    expect(inherited[1]).toEqual(expect.objectContaining({
      kind: 'inline', nodeId: child.id, authoredNodeId: child.id, declarationIndex: null,
    }));
    expect(inheritedRule[0]).toEqual(expect.objectContaining({
      kind: 'rule', path: SHEET_PATH, value: '18px', winner: true,
    }));
    expect(builtin.filter((target) => target.kind === 'rule')).toEqual([]);
    expect(fallback.filter((target) => target.kind === 'rule')).toEqual([]);
    expect(inheritedState.map((target) => target.kind)).toEqual(['new-rule']);
  });

  it('keeps imported rule origins exact while offering new rules only in directly linked sheets', () => {
    const first = 'Assets/UI/A/entry.uss';
    const firstImport = 'Assets/UI/A/shared.uss';
    const second = 'Assets/UI/B/entry.uss';
    const secondImport = 'Assets/UI/B/shared.uss';
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="A/entry.uss" />\n  <Style src="B/entry.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [first]: '@import "shared.uss";\n',
      [firstImport]: '#save { width: 101px; }\n',
      [second]: '@import "shared.uss";\n',
      [secondImport]: '#save { width: 202px; }\n',
    });
    const targets = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', []);

    expect(targets.filter((target) => target.kind === 'rule').map((target) => target.path)).toEqual([
      secondImport,
      firstImport,
    ]);
    expect(targets.filter((target) => target.kind === 'new-rule').map((target) => target.path)).toEqual([
      first,
      second,
    ]);
  });

  it('rejects invalid or duplicate requested states instead of selecting a different selector', () => {
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [SHEET_PATH]: '#save:hover { width: 10px; }\n',
    });
    const button = nodeByName(session.document.root, 'save');

    for (const state of [['hover', 'hover'], ['hover state'], ['made-up']] as const) {
      expect(() => styleTargetsFor(session, button, 'width', state)).toThrowError(expect.objectContaining({
        name: 'StyleTargetError',
        code: 'invalid-state',
      } satisfies Partial<StyleTargetError>));
    }
  });

  it('rejects stale node objects and unsafe property names with owned errors', () => {
    const entry = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`;
    const session = openSession({
      [ENTRY_PATH]: entry,
      [SHEET_PATH]: '#save { width: 10px; }\n',
    });
    const staleButton = nodeByName(session.document.root, 'save');

    expect(() => styleTargetsFor(session, staleButton, 'width; color', [])).toThrowError(expect.objectContaining({
      name: 'StyleTargetError',
      code: 'invalid-property',
    } satisfies Partial<StyleTargetError>));

    const insertion = entry.indexOf('<ui:Button');
    session.commit(normalizeEditorTransaction({
      id: 'test:shift-node-ids',
      label: 'Shift node ids',
      patchesByFile: new Map([[ENTRY_PATH, [{
        start: insertion,
        end: insertion,
        replacement: '<ui:Label name="new" />\n  ',
      }]]]),
    }));

    expect(() => styleTargetsFor(session, staleButton, 'width', [])).toThrowError(expect.objectContaining({
      name: 'StyleTargetError',
      code: 'invalid-node',
    } satisfies Partial<StyleTargetError>));
  });

  it('does not offer an ambiguous new rule selector for duplicate authored names', () => {
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="duplicate" />\n  <ui:Button name="duplicate" />\n</ui:UXML>\n`,
      [SHEET_PATH]: 'Button { height: 10px; }\n',
    });
    const button = nodeByName(session.document.root, 'duplicate');

    const targets = styleTargetsFor(session, button, 'width', []);

    expect(targets.filter((target) => target.kind === 'new-rule')).toEqual([]);
    expect(targets.some((target) => target.kind === 'inline')).toBe(true);
  });
});

function openSession(files: Readonly<Record<string, string>>): DocumentSession {
  return DocumentSession.open(new Map(Object.entries(files)), ENTRY_PATH, new UxmlPreviewAdapter());
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

function nodesByClass(root: EditorElement, className: string): readonly EditorElement[] {
  const result: EditorElement[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.attributes.some((attribute) =>
      attribute.name === 'class' && attribute.value.split(/\s+/).includes(className)
    )) result.push(current);
    pending.push(...current.children);
  }
  return result;
}
