import { describe, expect, it } from 'vitest';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import type { EditorElement } from '../../core/adapter/types';
import { DocumentSession } from '../../core/documents/DocumentSession';
import { styleTargetsFor, type RuleStyleTarget } from '../../core/documents/StyleTarget';
import { composeStyleEdits } from './inspectorTransactions';

const ENTRY = 'Assets/UI/shared.uxml';
const SHEET = 'Assets/UI/shared.uss';
const UXML = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="shared.uss" />
  <ui:Button name="one" class="shared" />
  <ui:Button name="two" class="shared" />
</ui:UXML>
`;
const USS = '.shared { width: 80px; }\n';

describe('inspector style transaction composition', () => {
  it('deduplicates identical writes through one exact declaration', () => {
    const { session, edits } = sharedRuleEdits();

    const transaction = composeStyleEdits(session, edits.map((edit) => ({ ...edit, value: '100px' })));

    expect(transaction.patchesByFile.get(SHEET)).toHaveLength(1);
    expect(session.snapshot().files.get(SHEET)?.text).toBe(USS);
    expect(session.history.undoDepth).toBe(0);
  });

  it('refuses differing writes through one exact declaration before mutation', () => {
    const { session, edits } = sharedRuleEdits();

    expect(() => composeStyleEdits(session, [
      { ...edits[0], value: '100px' },
      { ...edits[1], value: '120px' },
    ])).toThrow(/different values.*one exact authored declaration/i);
    expect(session.snapshot().files.get(SHEET)?.text).toBe(USS);
    expect(session.history.undoDepth).toBe(0);
  });
});

function sharedRuleEdits() {
  const session = DocumentSession.open(new Map([[ENTRY, UXML], [SHEET, USS]]), ENTRY, new UxmlPreviewAdapter());
  const nodes = ['one', 'two'].map((name) => nodeByName(session.document.root, name));
  const edits = nodes.map((node) => ({
    locator: session.locatorFor(node.id)!,
    target: styleTargetsFor(session, node, 'width', []).find((target): target is RuleStyleTarget => target.kind === 'rule')!,
  }));
  return { session, edits };
}

function nodeByName(root: EditorElement, name: string): EditorElement {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.attributes.some((attribute) => attribute.name === 'name' && attribute.value === name)) return current;
    pending.push(...current.children);
  }
  throw new Error(`Missing node ${name}.`);
}
