import { describe, expect, it } from 'vitest';
import { UxmlPreviewAdapter } from '../adapter/UxmlPreviewAdapter';
import type { EditorElement } from '../adapter/types';
import { DocumentSession } from '../documents/DocumentSession';
import { styleTargetIdFor } from '../documents/styleTargetIdentity';
import {
  styleTargetsFor,
  type InlineStyleTarget,
  type NewRuleStyleTarget,
  type RuleStyleTarget,
} from '../documents/StyleTarget';
import { normalizeEditorTransaction } from './EditorTransaction';
import {
  insertRule,
  removeDeclaration,
  setDeclaration,
  setInlineStyle,
  UssCommandError,
} from './ussCommands';

const ENTRY_PATH = 'Assets/UI/screen.uxml';

describe('USS commands', () => {
  it('patches only the selected declaration value in a relative imported stylesheet', () => {
    const localPath = 'Assets/UI/styles/screen.uss';
    const importedPath = 'Assets/UI/shared/base.uss';
    const entry = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\r\n  <Style src="styles/screen.uss" />\r\n  <ui:Button name="save" />\r\n</ui:UXML>\r\n`;
    const local = '@import "../shared/base.uss";\r\nButton { height: 20px; }\r\n';
    const imported = `/* keep */\r\n#save {\r\n  width : 100px; /* trailing */\r\n  --gap: 2px;\r\n  margin: 1px 2px;\r\n}\r\n`;
    const session = openSession({
      [ENTRY_PATH]: entry,
      [localPath]: local,
      [importedPath]: imported,
    });
    const target = styleTargetsFor(
      session,
      nodeByName(session.document.root, 'save'),
      'width',
      [],
    ).find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;

    const first = setDeclaration(session, target, '240px');
    const second = setDeclaration(session, target, '240px');

    expect(first.id).toBe(second.id);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.patchesByFile)).toBe(true);
    expect(first.patchesByFile.get(importedPath)).toEqual([{
      start: imported.indexOf('100px'),
      end: imported.indexOf('100px') + '100px'.length,
      replacement: '240px',
    }]);

    session.history.execute(first);

    const files = session.snapshot().files;
    expect(files.get(ENTRY_PATH)?.text).toBe(entry);
    expect(files.get(localPath)?.text).toBe(local);
    expect(files.get(importedPath)?.text).toBe(imported.replace('100px', '240px'));
  });

  it('removes only one exact duplicate declaration span and its terminator', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const source = `:nth-child(2) { width: 999px; unsupported: keep; }\r\n#save {\r\n  /* before */\r\n  width: 10px;\r\n  --custom: var(--gap, 2px);\r\n  margin: 1px 2px;\r\n  width : 30px \t; /* after */\r\n}\r\n`;
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\r\n  <Style src="styles/screen.uss" />\r\n  <ui:Button name="save" />\r\n</ui:UXML>\r\n`,
      [sheetPath]: source,
    });
    const widthTargets = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', []);
    expect(widthTargets.filter((candidate) => candidate.kind === 'rule').map((candidate) => candidate.value))
      .not.toContain('999px');
    const target = widthTargets
      .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule' && candidate.value === '30px')!;

    const transaction = removeDeclaration(session, target);
    const owned = 'width : 30px \t;';
    expect(transaction.patchesByFile.get(sheetPath)).toEqual([{
      start: source.indexOf(owned),
      end: source.indexOf(owned) + owned.length,
      replacement: '',
    }]);

    session.history.execute(transaction);
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(source.replace(owned, ''));
  });

  it('appends new rules using local indentation, newline, and final-newline conventions', () => {
    const cases = [
      {
        path: 'Assets/UI/styles/crlf.uss',
        source: `/* header */\r\nButton {\r\n\twidth: 10px;\r\n}\r\n:nth-child(2) { unsupported: keep; }\r\n`,
        expected: `\r\n#save {\r\n\tcolor: rgb(1, 2, 3);\r\n}\r\n`,
      },
      {
        path: 'Assets/UI/styles/lf.uss',
        source: `@media ignored { Button { width: 1px; } }\nButton {\n  height: 20px;\n}`,
        expected: `\n\n#save {\n  color: rgb(1, 2, 3);\n}`,
      },
      {
        path: 'Assets/UI/styles/mixed.uss',
        source: `/* old LF */\nButton {\r\n\twidth: 10px;\r\n}\r\n`,
        expected: `\r\n#save {\r\n\tcolor: rgb(1, 2, 3);\r\n}\r\n`,
      },
    ] as const;

    for (const fixture of cases) {
      const session = openSession({
        [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="${fixture.path}" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
        [fixture.path]: fixture.source,
      });
      const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'color', [])
        .find((candidate): candidate is NewRuleStyleTarget => candidate.kind === 'new-rule')!;

      const transaction = insertRule(session, target, 'rgb(1, 2, 3)');

      expect(transaction.patchesByFile.get(fixture.path)).toEqual([{
        start: fixture.source.length,
        end: fixture.source.length,
        replacement: fixture.expected,
      }]);
      session.history.execute(transaction);
      expect(session.snapshot().files.get(fixture.path)?.text).toBe(fixture.source + fixture.expected);
    }
  });

  it('patches only an existing inline declaration value and preserves XML and USS trivia', () => {
    const source = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <ui:Button name="save" style='color : red; /* keep */ background-image: url(&quot;icon.png&quot;); --gap: 2px' data-note="untouched" />\n</ui:UXML>\n`;
    const session = openSession({ [ENTRY_PATH]: source });
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'color', [])
      .find((candidate): candidate is InlineStyleTarget => candidate.kind === 'inline')!;

    const transaction = setInlineStyle(session, target, 'rgb(1, 2, 3)');

    expect(transaction.patchesByFile.get(ENTRY_PATH)).toEqual([{
      start: source.indexOf('red'),
      end: source.indexOf('red') + 'red'.length,
      replacement: 'rgb(1, 2, 3)',
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(source.replace('red', 'rgb(1, 2, 3)'));

    const entitySession = openSession({ [ENTRY_PATH]: source });
    const entityTarget = styleTargetsFor(
      entitySession,
      nodeByName(entitySession.document.root, 'save'),
      'background-image',
      [],
    ).find((candidate): candidate is InlineStyleTarget => candidate.kind === 'inline')!;
    entitySession.history.execute(setInlineStyle(entitySession, entityTarget, "url('pressed;state.png')"));
    expect(entitySession.snapshot().files.get(ENTRY_PATH)?.text).toBe(
      source.replace('url(&quot;icon.png&quot;)', 'url(&apos;pressed;state.png&apos;)'),
    );
  });

  it('adds inline declarations without replacing the UXML open tag', () => {
    const existing = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <ui:Button name="save" style='opacity: 0.5; /* tail */' data-note="keep" />\n</ui:UXML>\n`;
    const existingSession = openSession({ [ENTRY_PATH]: existing });
    const existingTarget = styleTargetsFor(
      existingSession,
      nodeByName(existingSession.document.root, 'save'),
      'width',
      [],
    ).find((candidate): candidate is InlineStyleTarget => candidate.kind === 'inline')!;

    existingSession.history.execute(setInlineStyle(existingSession, existingTarget, '20px'));
    expect(existingSession.snapshot().files.get(ENTRY_PATH)?.text).toBe(
      existing.replace("opacity: 0.5; /* tail */", "opacity: 0.5; width: 20px; /* tail */"),
    );

    const missing = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <ui:Button name='save' data-note="keep" />\n</ui:UXML>\n`;
    const missingSession = openSession({ [ENTRY_PATH]: missing });
    const missingTarget = styleTargetsFor(
      missingSession,
      nodeByName(missingSession.document.root, 'save'),
      'width',
      [],
    ).find((candidate): candidate is InlineStyleTarget => candidate.kind === 'inline')!;

    const transaction = setInlineStyle(missingSession, missingTarget, '20px');
    missingSession.history.execute(transaction);
    expect(missingSession.snapshot().files.get(ENTRY_PATH)?.text).toBe(
      missing.replace(' data-note="keep"', ' data-note="keep" style="width: 20px;"'),
    );
  });

  it('infers multiline inline indentation and preserves closing attribute trivia', () => {
    const source = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\r\n  <ui:Button name="save" style="\r\n    opacity: 0.5;\r\n  " data-note="keep" />\r\n</ui:UXML>\r\n`;
    const session = openSession({ [ENTRY_PATH]: source });
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
      .find((candidate): candidate is InlineStyleTarget => candidate.kind === 'inline')!;

    session.history.execute(setInlineStyle(session, target, '20px'));

    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(
      source.replace('opacity: 0.5;', 'opacity: 0.5;\r\n    width: 20px;'),
    );
  });

  it('rejects stale source snapshots and forged target identities without mutation', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const source = '#save { width: 10px; height: 20px; }\n';
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [sheetPath]: source,
    });
    const button = nodeByName(session.document.root, 'save');
    const width = styleTargetsFor(session, button, 'width', [])
      .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;
    const height = styleTargetsFor(session, button, 'height', [])
      .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;

    session.history.execute(setDeclaration(session, height, '30px'));
    const afterPriorEdit = session.snapshot().files.get(sheetPath)?.text;

    expect(() => setDeclaration(session, width, '40px')).toThrowError(expect.objectContaining({
      name: 'UssCommandError',
      code: 'stale-target',
    } satisfies Partial<UssCommandError>));
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(afterPriorEdit);

    const current = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
      .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;
    const forged = { ...current, id: 'style-target:forged', state: [...current.state] };
    expect(() => setDeclaration(session, forged, '40px')).toThrowError(expect.objectContaining({
      name: 'UssCommandError',
      code: 'invalid-target',
    } satisfies Partial<UssCommandError>));
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(afterPriorEdit);
  });

  it('rejects every operation when any exact session source changes', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const overlayPath = 'Assets/UI/styles/overlay.uss';
    const entry = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <Style src="styles/overlay.uss" />\n  <ui:Button name="save" style="opacity: 0.5" />\n</ui:UXML>\n`;
    const source = '#save { width: 10px; }\n';
    const overlay = '#save { width: 20px; }\n';
    const session = openSession({
      [ENTRY_PATH]: entry,
      [sheetPath]: source,
      [overlayPath]: overlay,
    });
    const targets = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', []);
    const rule = targets.find((target): target is RuleStyleTarget =>
      target.kind === 'rule' && target.path === sheetPath
    )!;
    const inline = targets.find((target): target is InlineStyleTarget => target.kind === 'inline')!;
    const newRule = targets.find((target): target is NewRuleStyleTarget =>
      target.kind === 'new-rule' && target.path === sheetPath
    )!;

    replaceSource(session, overlayPath, '20px', '30px', 'test:change-cascade');

    expectRejectedWithoutMutation(session, () => setDeclaration(session, rule, '40px'));
    expectRejectedWithoutMutation(session, () => setInlineStyle(session, inline, '40px'));
    expectRejectedWithoutMutation(session, () => insertRule(session, newRule, '40px'));
  });

  it('rejects targets after UXML edits, node deletion or rename, and duplicate-name creation', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const entry = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`;
    const source = '#save { width: 10px; }\n';
    const changes = [
      { from: '</ui:UXML>', to: '  <!-- unrelated -->\n</ui:UXML>', id: 'test:uxml-change' },
      { from: '  <ui:Button name="save" />\n', to: '', id: 'test:delete-node' },
      { from: 'name="save"', to: 'name="renamed"', id: 'test:rename-node' },
      {
        from: '  <ui:Button name="save" />',
        to: '  <ui:Button name="save" />\n  <ui:Button name="save" />',
        id: 'test:duplicate-name',
      },
    ] as const;

    for (const change of changes) {
      const session = openSession({ [ENTRY_PATH]: entry, [sheetPath]: source });
      const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
        .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;
      replaceSource(session, ENTRY_PATH, change.from, change.to, change.id);

      expectRejectedWithoutMutation(session, () => setDeclaration(session, target, '40px'));
    }
  });

  it('rejects a forged target even when its collision-free canonical id is recomputed', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const source = '#save { width: 10px; }\n';
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [sheetPath]: source,
    });
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
      .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;
    const { id: _id, ...identity } = target;
    const forgedIdentity = { ...identity, winner: !target.winner };
    const forged = { ...forgedIdentity, id: styleTargetIdFor(forgedIdentity) };

    expect(forged.id).not.toBe(target.id);
    expectRejectedWithoutMutation(session, () => setDeclaration(session, forged, '40px'));

    const malformedIdentity = {
      ...identity,
      declarationIndex: null,
      declarationSource: target.declarationSource,
      value: null,
    };
    const malformed = { ...malformedIdentity, id: styleTargetIdFor(malformedIdentity) };
    const before = observableSessionState(session);
    expect(() => setDeclaration(session, malformed, '40px')).toThrowError(expect.objectContaining({
      name: 'UssCommandError',
      code: 'invalid-target',
    } satisfies Partial<UssCommandError>));
    expect(observableSessionState(session)).toEqual(before);

    const negativeZeroIdentity = { ...identity, sheetIndex: -0 };
    const negativeZero = { ...negativeZeroIdentity, id: styleTargetIdFor(negativeZeroIdentity) };
    expect(() => setDeclaration(session, negativeZero, '40px')).toThrowError(expect.objectContaining({
      name: 'UssCommandError',
      code: 'invalid-target',
    } satisfies Partial<UssCommandError>));
    expect(observableSessionState(session)).toEqual(before);
  });

  it('uses canonical target identities that remain distinct for a known FNV32 collision fixture', () => {
    expect(oldFnv32('fixture-3pwu')).toBe(oldFnv32('fixture-a5fa'));

    const sheetPath = 'Assets/UI/styles/screen.uss';
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [sheetPath]: '',
    });
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
      .find((candidate): candidate is NewRuleStyleTarget => candidate.kind === 'new-rule')!;
    const { id: _id, ...identity } = target;
    const left = { ...identity, selector: '#fixture-3pwu' };
    const right = { ...identity, selector: '#fixture-a5fa' };

    expect(styleTargetIdFor(left)).not.toBe(styleTargetIdFor(right));
    expect(styleTargetIdFor(left)).toBe(`style-target:v2:${JSON.stringify([
      left.kind,
      left.path,
      left.property,
      left.state,
      left.sourceSnapshot,
      left.nodeId,
      [
        left.locator.authoredName ?? null,
        left.locator.qualifiedTag,
        left.locator.childPath,
        left.locator.ancestorTags,
        left.locator.attributeHints.map((hint) => [hint.name, hint.value]),
      ],
      left.sessionSources.map((sourceEntry) => [sourceEntry.path, sourceEntry.text]),
      left.sheetIndex,
      left.selector,
    ])}`);
  });

  it('inserts a requested longhand into the authored shorthand rule and preserves undo, redo, and replay', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const entry = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`;
    const source = '#save {\n  margin: 1px 2px;\n  color: red;\n}\n';
    const expected = '#save {\n  margin: 1px 2px;\n  color: red;\n  margin-left: 30px;\n}\n';
    const session = openSession({ [ENTRY_PATH]: entry, [sheetPath]: source });
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'margin-left', [])
      .find((candidate): candidate is RuleStyleTarget =>
        candidate.kind === 'rule' && candidate.authoredProperty === 'margin'
      )!;

    expect(target.declarationIndex).toBeNull();
    const transaction = setDeclaration(session, target, '30px');
    expect(transaction.patchesByFile.get(sheetPath)).toEqual([{
      start: source.lastIndexOf('}'),
      end: source.lastIndexOf('}'),
      replacement: '  margin-left: 30px;\n',
    }]);

    session.history.execute(transaction);
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(expected);
    session.history.undo();
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(source);
    session.history.redo();
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(expected);

    const replay = openSession({ [ENTRY_PATH]: entry, [sheetPath]: source });
    replay.history.replay([transaction]);
    expect(replay.snapshot().files.get(sheetPath)?.text).toBe(expected);
  });

  it('replaces an exact shorthand request but rejects removing a longhand override target', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const source = '#save { margin: 1px 2px; color: red; }\n';
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [sheetPath]: source,
    });
    const button = nodeByName(session.document.root, 'save');
    const shorthand = styleTargetsFor(session, button, 'margin', [])
      .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;
    const override = styleTargetsFor(session, button, 'margin-left', [])
      .find((candidate): candidate is RuleStyleTarget =>
        candidate.kind === 'rule' && candidate.authoredProperty === 'margin'
      )!;

    const transaction = setDeclaration(session, shorthand, '3px 4px');
    expect(transaction.patchesByFile.get(sheetPath)).toEqual([{
      start: source.indexOf('1px 2px'),
      end: source.indexOf('1px 2px') + '1px 2px'.length,
      replacement: '3px 4px',
    }]);
    expect(() => removeDeclaration(session, override)).toThrowError(expect.objectContaining({
      name: 'UssCommandError',
      code: 'invalid-target',
    } satisfies Partial<UssCommandError>));
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(source);
    expect(session.history.canUndo).toBe(false);
  });

  it('inserts only the requested flex longhand while preserving the authored flex shorthand', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const source = '#save {\n  flex: 2 3 10px;\n  color: red;\n}\n';
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [sheetPath]: source,
    });
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'flex-basis', [])
      .find((candidate): candidate is RuleStyleTarget =>
        candidate.kind === 'rule' && candidate.authoredProperty === 'flex'
      )!;

    const transaction = setDeclaration(session, target, '25px');

    expect(transaction.patchesByFile.get(sheetPath)).toEqual([{
      start: source.lastIndexOf('}'),
      end: source.lastIndexOf('}'),
      replacement: '  flex-basis: 25px;\n',
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(
      '#save {\n  flex: 2 3 10px;\n  color: red;\n  flex-basis: 25px;\n}\n',
    );
    expect(session.snapshot().files.get(sheetPath)?.text).toContain('flex: 2 3 10px;');
  });

  it('inserts inline longhand overrides before exact trailing comment trivia', () => {
    const fixtures = [
      {
        name: 'single-line immediate comment',
        style: 'margin: 1px 2px;/* tail */',
        expected: 'margin: 1px 2px; margin-left: 30px;/* tail */',
      },
      {
        name: 'LF multiline',
        style: '\n    margin: 1px 2px;\n    /* tail */\n  ',
        expected: '\n    margin: 1px 2px;\n    margin-left: 30px;\n    /* tail */\n  ',
      },
      {
        name: 'CRLF multiline',
        style: '\r\n\tmargin: 1px 2px;\r\n\t/* tail */\r\n  ',
        expected: '\r\n\tmargin: 1px 2px;\r\n\tmargin-left: 30px;\r\n\t/* tail */\r\n  ',
      },
      {
        name: 'no final semicolon',
        style: 'margin: 1px 2px /* tail */',
        expected: 'margin: 1px 2px; margin-left: 30px; /* tail */',
      },
      {
        name: 'comments only',
        style: '/* only */',
        expected: 'margin-left: 30px; /* only */',
      },
      {
        name: 'comments only multiline',
        style: '\r\n    /* only */\r\n  ',
        expected: '\r\n    margin-left: 30px;\r\n    /* only */\r\n  ',
      },
    ] as const;

    for (const fixture of fixtures) {
      const source = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <ui:Button name="save" style="${fixture.style}" data-note="keep" />\n</ui:UXML>\n`;
      const session = openSession({ [ENTRY_PATH]: source });
      const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'margin-left', [])
        .find((candidate): candidate is InlineStyleTarget => candidate.kind === 'inline')!;

      session.history.execute(setInlineStyle(session, target, '30px'));

      expect(session.snapshot().files.get(ENTRY_PATH)?.text, fixture.name).toBe(
        source.replace(fixture.style, fixture.expected),
      );
    }
  });

  it.each([
    {
      name: 'spaces before semicolon with immediate and trailing comments',
      style: 'opacity: 0.5   ;/* immediate */ /* trailing */',
      expected: 'opacity: 0.5   ; width: 20px;/* immediate */ /* trailing */',
      insertionOffset: 'opacity: 0.5   ;'.length,
      replacement: ' width: 20px;',
    },
    {
      name: 'tab and form-feed before semicolon',
      style: 'opacity: 0.5\t\f;\t/* tail */',
      expected: 'opacity: 0.5\t\f; width: 20px;\t/* tail */',
      insertionOffset: 'opacity: 0.5\t\f;'.length,
      replacement: ' width: 20px;',
    },
    {
      name: 'LF before semicolon',
      style: '\n    opacity: 0.5\n    ;\n    /* tail */\n  ',
      expected: '\n    opacity: 0.5\n    ;\n    width: 20px;\n    /* tail */\n  ',
      insertionOffset: '\n    opacity: 0.5\n    ;'.length,
      replacement: '\n    width: 20px;',
    },
    {
      name: 'CRLF before semicolon',
      style: '\r\n\topacity: 0.5\r\n\t;\r\n\t/* tail */\r\n  ',
      expected: '\r\n\topacity: 0.5\r\n\t;\r\n\twidth: 20px;\r\n\t/* tail */\r\n  ',
      insertionOffset: '\r\n\topacity: 0.5\r\n\t;'.length,
      replacement: '\r\n\twidth: 20px;',
    },
    {
      name: 'no semicolon with horizontal whitespace and comment',
      style: 'opacity: 0.5 \t/* tail */',
      expected: 'opacity: 0.5; width: 20px; \t/* tail */',
      insertionOffset: 'opacity: 0.5'.length,
      replacement: '; width: 20px;',
    },
    {
      name: 'no semicolon with multiline trivia',
      style: '\r\n    opacity: 0.5\r\n    /* tail */\r\n  ',
      expected: '\r\n    opacity: 0.5;\r\n    width: 20px;\r\n    /* tail */\r\n  ',
      insertionOffset: '\r\n    opacity: 0.5'.length,
      replacement: ';\r\n    width: 20px;',
    },
  ])('inserts after the exact inline semicolon offset: $name', ({
    style,
    expected,
    insertionOffset,
    replacement,
  }) => {
    const source = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <ui:Button name="save" style="${style}" data-note="keep" />\n</ui:UXML>\n`;
    const session = openSession({ [ENTRY_PATH]: source });
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
      .find((candidate): candidate is InlineStyleTarget => candidate.kind === 'inline')!;
    const transaction = setInlineStyle(session, target, '20px');
    const insertion = source.indexOf(style) + insertionOffset;

    expect(transaction.patchesByFile.get(ENTRY_PATH)).toEqual([{
      start: insertion,
      end: insertion,
      replacement,
    }]);
    session.history.execute(transaction);
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(source.replace(style, expected));
    session.history.undo();
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(source);
    session.history.redo();
    expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(source.replace(style, expected));
  });

  it('rejects malformed inline declaration tails without changing source or history', () => {
    for (const style of [
      'opacity: 0.5; /* unterminated',
      'opacity: 0.5; stray /* tail */',
      'opacity: 0.5 ;; /* duplicate */',
      'opacity: 0.5 \t; stray /* tail */',
    ]) {
      const source = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <ui:Button name="save" style="${style}" />\n</ui:UXML>\n`;
      const session = openSession({ [ENTRY_PATH]: source });
      const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
        .find((candidate): candidate is InlineStyleTarget => candidate.kind === 'inline')!;

      expect(() => setInlineStyle(session, target, '20px')).toThrowError(expect.objectContaining({
        name: 'UssCommandError',
        code: 'unsafe-source',
      } satisfies Partial<UssCommandError>));
      expect(session.snapshot().files.get(ENTRY_PATH)?.text).toBe(source);
      expect(session.history.canUndo).toBe(false);
      expect(session.history.canRedo).toBe(false);
    }
  });

  it('accepts parser-valid quoted semicolons and rejects unsafe stylesheet boundaries', () => {
    const validPath = 'Assets/UI/styles/valid.uss';
    const valid = '#save { background-image: url("old.png"); }\n';
    const validSession = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/valid.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [validPath]: valid,
    });
    const rule = styleTargetsFor(
      validSession,
      nodeByName(validSession.document.root, 'save'),
      'background-image',
      [],
    ).find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;

    validSession.history.execute(setDeclaration(validSession, rule, 'url("pressed;state.png")'));
    expect(validSession.snapshot().files.get(validPath)?.text).toBe(
      valid.replace('url("old.png")', 'url("pressed;state.png")'),
    );

    for (const [name, unsafe] of [
      ['block', '#save { width: 10px;\n'],
      ['comment', '/* unterminated'],
    ] as const) {
      const path = `Assets/UI/styles/${name}.uss`;
      const session = openSession({
        [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="${path}" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
        [path]: unsafe,
      });
      const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'color', [])
        .find((candidate): candidate is NewRuleStyleTarget => candidate.kind === 'new-rule')!;

      expect(() => insertRule(session, target, 'red')).toThrowError(expect.objectContaining({
        name: 'UssCommandError',
        code: 'unsafe-source',
      } satisfies Partial<UssCommandError>));
      expect(session.snapshot().files.get(path)?.text).toBe(unsafe);
    }
  });

  it('undoes, redoes, and replays exact deterministic transactions despite later caller mutation', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const entry = `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`;
    const source = '#save { width: 10px; }\n';
    const session = openSession({ [ENTRY_PATH]: entry, [sheetPath]: source });
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
      .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;
    const callerTarget = {
      ...target,
      state: [...target.state],
      ruleSource: { ...target.ruleSource },
      selectorSource: { ...target.selectorSource },
      declarationSource: { ...target.declarationSource! },
      locator: {
        ...target.locator,
        childPath: [...target.locator.childPath],
        ancestorTags: [...target.locator.ancestorTags],
        attributeHints: target.locator.attributeHints.map((hint) => ({ ...hint })),
      },
      sessionSources: target.sessionSources.map((entry) => ({ ...entry })),
    };
    const transaction = setDeclaration(session, callerTarget, '40px');

    callerTarget.state.push('hover');
    callerTarget.declarationSource.start = 0;
    callerTarget.sourceSnapshot = 'mutated';
    callerTarget.locator.childPath.push(999);
    callerTarget.sessionSources[0].text = 'mutated';

    session.history.execute(transaction);
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(source.replace('10px', '40px'));
    session.history.undo();
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(source);
    session.history.redo();
    expect(session.snapshot().files.get(sheetPath)?.text).toBe(source.replace('10px', '40px'));

    const replay = openSession({ [ENTRY_PATH]: entry, [sheetPath]: source });
    replay.history.replay([transaction]);
    expect(replay.snapshot().files.get(sheetPath)?.text).toBe(source.replace('10px', '40px'));
    expect(replay.history.replayLog).toEqual([transaction]);
    expect(Object.isFrozen(replay.history.replayLog)).toBe(true);
  });

  it('preserves a balanced malformed recovery region when appending a new rule', () => {
    const sheetPath = 'Assets/UI/styles/recovery.uss';
    const source = `#save {\n  broken value;\n  color: red;\n}\n`;
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/recovery.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [sheetPath]: source,
    });
    expect(session.diagnostics.some((diagnostic) => diagnostic.kind === 'malformed')).toBe(true);
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'opacity', [])
      .find((candidate): candidate is NewRuleStyleTarget => candidate.kind === 'new-rule')!;

    session.history.execute(insertRule(session, target, '0.5'));

    expect(session.snapshot().files.get(sheetPath)?.text).toBe(
      `${source}\n#save {\n  opacity: 0.5;\n}\n`,
    );
    expect(session.snapshot().files.get(sheetPath)?.text.startsWith(source)).toBe(true);
  });

  it('snapshots getter-backed target fields exactly once before planning', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const source = '#save { width: 10px; }\n';
    const session = openSession({
      [ENTRY_PATH]: `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`,
      [sheetPath]: source,
    });
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
      .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;
    const reads = new Map<PropertyKey, number>();
    const getterBacked = new Proxy({ ...target }, {
      get(object, property, receiver) {
        const count = (reads.get(property) ?? 0) + 1;
        reads.set(property, count);
        if (count > 1) throw new Error(`Field ${String(property)} was read more than once.`);
        return Reflect.get(object, property, receiver);
      },
    });

    const transaction = setDeclaration(session, getterBacked, '50px');

    expect(transaction.patchesByFile.get(sheetPath)?.[0].replacement).toBe('50px');
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
  });

  it('rejects a partial USS adapter contract with an owned error', () => {
    const sheetPath = 'Assets/UI/styles/screen.uss';
    const adapter = new UxmlPreviewAdapter();
    const session = DocumentSession.open(new Map([
      [ENTRY_PATH, `<ui:UXML xmlns:ui="UnityEngine.UIElements">\n  <Style src="styles/screen.uss" />\n  <ui:Button name="save" />\n</ui:UXML>\n`],
      [sheetPath, '#save { width: 10px; }\n'],
    ]), ENTRY_PATH, adapter);
    const target = styleTargetsFor(session, nodeByName(session.document.root, 'save'), 'width', [])
      .find((candidate): candidate is RuleStyleTarget => candidate.kind === 'rule')!;
    Object.defineProperty(adapter, 'parseDeclarationList', { value: undefined });

    expect(() => setDeclaration(session, target, '20px')).toThrowError(expect.objectContaining({
      name: 'UssCommandError',
      code: 'unsafe-source',
    } satisfies Partial<UssCommandError>));
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

function replaceSource(
  session: DocumentSession,
  path: string,
  from: string,
  replacement: string,
  id: string,
): void {
  const source = session.snapshot().files.get(path)?.text;
  if (source === undefined) throw new Error(`Missing source ${path}.`);
  const start = source.indexOf(from);
  if (start === -1) throw new Error(`Missing fixture text in ${path}.`);
  session.commit(normalizeEditorTransaction({
    id,
    label: id,
    patchesByFile: new Map([[path, [{ start, end: start + from.length, replacement }]]]),
  }));
}

function expectRejectedWithoutMutation(session: DocumentSession, operation: () => unknown): void {
  const before = observableSessionState(session);
  expect(operation).toThrowError(expect.objectContaining({
    name: 'UssCommandError',
    code: 'stale-target',
  } satisfies Partial<UssCommandError>));
  expect(observableSessionState(session)).toEqual(before);
}

function observableSessionState(session: DocumentSession) {
  return {
    files: [...session.snapshot().files].map(([path, buffer]) => [path, buffer.text]),
    canUndo: session.history.canUndo,
    canRedo: session.history.canRedo,
    replayLog: session.history.replayLog,
  };
}

function oldFnv32(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}
