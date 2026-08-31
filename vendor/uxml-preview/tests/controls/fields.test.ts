/**
 * Controls whose parts are a tree rather than a chain.
 *
 * ScrollView's four elements nest one inside the next, so a chain drew it
 * correctly and hid the assumption. A `BaseField` puts its label *beside* its
 * input, which a chain cannot express: whichever one it nested inside the other
 * dragged every coordinate below it. These cases fix the tree — who is whose
 * sibling, where the file's children land, and which selectors reach a part —
 * because all three are silent when wrong and only visibly wrong in a
 * screenshot.
 *
 * Nothing here asserts a coordinate against Unity. Toggle and TextField are
 * `documented`, not measured, and a test claiming Unity's spacing from this
 * side of the fence would be inventing the ground truth it checks.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import {
  explainProperty,
  loadLayoutEngine,
  parse,
  render,
  resolveStyles,
  PART_ATTRIBUTE,
  PART_OWNER_ATTRIBUTE,
  supportedControlNames,
} from '../../src/index';
import type { MeasureText } from '../../src/index';
import { contentPartOf, resolveControl, type ControlSpec } from '../../src/controls/registry';
import type { ElementNode, UxmlDocument } from '../../src/model/types';

beforeAll(async () => {
  await loadLayoutEngine();
});

/** Deterministic stand-in, so captions measure the same everywhere. */
const measureText: MeasureText = (text, context) => ({
  width: text.length * context.fontSize * 0.5,
  height: context.fontSize,
});

function doc(body: string, uss = ''): UxmlDocument {
  return parse(`<ui:UXML xmlns:ui="UnityEngine.UIElements">${body}</ui:UXML>`, uss);
}

function draw(body: string, uss = ''): { document: UxmlDocument; container: HTMLElement } {
  const parsed = doc(body, uss);
  const container = window.document.createElement('div');
  window.document.body.replaceChildren(container);
  render(parsed, container, { size: { width: 200, height: 100 }, measureText });
  return { document: parsed, container };
}

function named(node: ElementNode, name: string): ElementNode {
  if (node.attributes.some((a) => a.name === 'name' && a.value === name)) return node;
  for (const child of node.children) {
    const hit = tryNamed(child, name);
    if (hit !== null) return hit;
  }
  throw new Error(`no element named ${name}`);
}

function tryNamed(node: ElementNode, name: string): ElementNode | null {
  if (node.attributes.some((a) => a.name === 'name' && a.value === name)) return node;
  for (const child of node.children) {
    const hit = tryNamed(child, name);
    if (hit !== null) return hit;
  }
  return null;
}

function specOf(control: string): ControlSpec {
  return resolveControl(doc(`<ui:${control} />`).root.children[0]!).spec;
}

function part(container: HTMLElement, name: string): HTMLElement {
  const el = container.querySelector(`[${PART_ATTRIBUTE}="${name}"]`);
  if (el === null) throw new Error(`no part named ${name}`);
  return el as HTMLElement;
}

function partStyle(
  d: UxmlDocument,
  owner: string,
  name: string,
  property: string,
): string | undefined {
  return resolveStyles(d)
    .partStyles.get(named(d.root, owner).id)
    ?.get(name)
    ?.get(property)?.value;
}

describe('the painted part tree', () => {
  it('keeps a field label and its input siblings', () => {
    const { container } = draw('<ui:Toggle name="t" label="Sound" />');
    const label = part(container, 'toggle-label');
    const input = part(container, 'toggle-input');
    expect(label.parentElement).toBe(input.parentElement);
    // The shape a chain got wrong, asserted from the other direction too.
    expect(label.contains(input)).toBe(false);
  });

  it('nests a part inside the part it names as its parent', () => {
    const { container } = draw('<ui:Toggle name="t" />');
    expect(part(container, 'toggle-input').contains(part(container, 'unity-checkmark'))).toBe(true);
  });

  /**
   * `content: null`, and the reason it exists. Unity's `BaseField` appends
   * children to itself; the chain's rule of "into the last part" would have put
   * them inside the checkmark, which is a 0×0 box.
   */
  it("puts a field's own children in the field, not in a part", () => {
    const { document: d, container } = draw(
      '<ui:Toggle name="t" label="Sound"><ui:Label name="hint" text="?" /></ui:Toggle>',
    );
    const hint = container.querySelector(`[data-uxml-node="${named(d.root, 'hint').id}"]`)!;
    expect(hint.parentElement?.getAttribute('data-uxml-node')).toBe(
      String(named(d.root, 't').id),
    );
  });

  it("still puts a ScrollView's children in its content container", () => {
    const { document: d, container } = draw(
      '<ui:ScrollView name="s"><ui:Label name="row" text="x" /></ui:ScrollView>',
    );
    const row = container.querySelector(`[data-uxml-node="${named(d.root, 'row').id}"]`)!;
    expect(row.parentElement).toBe(part(container, 'unity-content-container'));
  });

  /**
   * A Foldout is the case where `content` is neither "the control" nor "the
   * last part": its header comes first and its children go in `#unity-content`,
   * which is a sibling of the header rather than inside it.
   */
  it("puts a Foldout's children in its content container, below the header", () => {
    const { document: d, container } = draw(
      '<ui:Foldout name="f" text="Stats"><ui:Label name="row" text="x" /></ui:Foldout>',
    );
    const row = container.querySelector(`[data-uxml-node="${named(d.root, 'row').id}"]`)!;
    const content = part(container, 'unity-content');
    expect(row.parentElement).toBe(content);
    expect(content.contains(part(container, 'foldout-toggle'))).toBe(false);
    expect(part(container, 'foldout-text').textContent).toBe('Stats');
  });

  it("draws a DropdownField's caption and its selected value", () => {
    const { container } = draw('<ui:DropdownField name="d" label="Mode" value="Fast" />');
    expect(part(container, 'dropdown-label').textContent).toBe('Mode');
    expect(part(container, 'dropdown-text').textContent).toBe('Fast');
    expect(part(container, 'dropdown-input').contains(part(container, 'dropdown-arrow'))).toBe(true);
  });

  it("puts a Slider's track in its input column, not beside its label", () => {
    const { container } = draw('<ui:Slider name="s" label="Speed" />');
    const input = part(container, 'slider-input');
    expect(input.contains(part(container, 'slider-drag-container'))).toBe(true);
    expect(input.contains(part(container, 'slider-dragger'))).toBe(true);
    expect(part(container, 'slider-label').textContent).toBe('Speed');
  });

  /**
   * `IntegerField` and `TextField` share a tree and differ only in class names,
   * which is exactly the pair a shared implementation gets wrong in one
   * direction: same tree, and `.unity-integer-field__input` still has to reach
   * the input while `.unity-text-field__input` must not.
   */
  it('gives a numeric field its own class names over the shared text-field tree', () => {
    const d = doc(
      '<ui:IntegerField name="n" />',
      '.unity-integer-field__input { width: 30px; } .unity-text-field__input { width: 90px; }',
    );
    expect(partStyle(d, 'n', 'unity-text-input', 'width')).toBe('30px');
  });

  it('marks parts as parts and points them at their owner, giving them no node id', () => {
    const { document: d, container } = draw('<ui:Toggle name="t" />');
    const input = part(container, 'toggle-input');
    expect(input.getAttribute(PART_OWNER_ATTRIBUTE)).toBe(String(named(d.root, 't').id));
    expect(input.hasAttribute('data-uxml-node')).toBe(false);
  });
});

/**
 * Layout, style and paint all read the part list in order and look up each
 * part's parent in what they have built so far, and all three quietly fall back
 * to the owning control when a name is missing. That is the right behaviour for
 * a screen, and the wrong one for a typo in the table, so the table itself is
 * checked here instead.
 */
describe('the part table every control is built from', () => {
  it('names a parent that exists and is listed before its children', () => {
    for (const name of supportedControlNames()) {
      const spec = specOf(name);
      const seen = new Set<string>();
      for (const p of spec.parts) {
        expect(seen.has(p.name), `${name}: ${p.name} is listed twice`).toBe(false);
        if (p.parent !== undefined) {
          expect(seen.has(p.parent), `${name}: ${p.name} names parent ${p.parent}`).toBe(true);
        }
        seen.add(p.name);
      }
      const content = contentPartOf(spec);
      if (content !== undefined) {
        expect(seen.has(content), `${name}: content part ${content}`).toBe(true);
      }
    }
  });
});

describe('captions a field draws through a part', () => {
  it("paints a Toggle's label attribute, which a fallback box lost", () => {
    const { container } = draw('<ui:Toggle name="t" label="Sound" />');
    expect(part(container, 'toggle-label').textContent).toBe('Sound');
    expect(part(container, 'toggle-label').getBoundingClientRect).toBeDefined();
  });

  it("paints a TextField's value in its input, not its label", () => {
    const { container } = draw('<ui:TextField name="f" label="Name" value="Spring" />');
    expect(part(container, 'text-field-label').textContent).toBe('Name');
    expect(part(container, 'unity-text-input').textContent).toBe('Spring');
  });

  it('decodes entities in a caption, as an element caption does', () => {
    const { container } = draw('<ui:Toggle name="t" label="A &amp; B" />');
    expect(part(container, 'toggle-label').textContent).toBe('A & B');
  });

  it('measures the caption, so the label is not a zero-width box', () => {
    const { container } = draw('<ui:Toggle name="t" label="Sound" />');
    const width = Number.parseFloat(part(container, 'toggle-label').style.width);
    expect(width).toBeCloseTo('Sound'.length * 12 * 0.5, 5);
  });

  it('leaves an absent caption undrawn rather than painting an empty box of text', () => {
    const { container } = draw('<ui:Toggle name="t" />');
    expect(part(container, 'toggle-label').textContent).toBe('');
  });
});

describe('USS reaching a part', () => {
  it('matches the classes Unity puts on it', () => {
    const d = doc('<ui:Toggle name="t" />', '.unity-toggle__input { width: 40px; }');
    expect(partStyle(d, 't', 'toggle-input', 'width')).toBe('40px');
  });

  it('matches a shared BaseField class, which is how both columns get sized', () => {
    const d = doc('<ui:TextField name="f" />', '.unity-base-field__label { width: 60px; }');
    expect(partStyle(d, 'f', 'text-field-label', 'width')).toBe('60px');
  });

  it('matches by id only where Unity actually names the element', () => {
    const d = doc('<ui:Toggle name="t" />', '#unity-checkmark { width: 12px; }');
    expect(partStyle(d, 't', 'unity-checkmark', 'width')).toBe('12px');
  });

  /**
   * The counter-case to the one above: `toggle-label` is this library's key for
   * a part Unity leaves unnamed, so answering `#toggle-label` would invent a
   * selector that works here and nowhere in Unity.
   */
  it('does not answer an id selector for a part Unity leaves unnamed', () => {
    const d = doc('<ui:Toggle name="t" />', '#toggle-label { width: 60px; }');
    expect(partStyle(d, 't', 'toggle-label', 'width')).toBeUndefined();
  });

  it('inherits into every part from the control, not from an earlier sibling', () => {
    const d = doc('<ui:Toggle name="t" />', '#t { color: red; } .unity-toggle__label { color: blue; }');
    expect(partStyle(d, 't', 'toggle-label', 'color')).toBe('blue');
    // A chain would have handed the input the label's blue.
    expect(partStyle(d, 't', 'toggle-input', 'color')).toBe('red');
  });

  it('inherits into a nested part from the part it sits in', () => {
    const d = doc('<ui:Toggle name="t" />', '.unity-toggle__input { color: green; }');
    expect(partStyle(d, 't', 'unity-checkmark', 'color')).toBe('green');
  });

  it('lays a field out as a row, because a column would stack the two columns', () => {
    const d = doc('<ui:Toggle name="t" />');
    expect(
      resolveStyles(d).styles.get(named(d.root, 't').id)?.get('flex-direction')?.value,
    ).toBe('row');
  });
});

describe('what a documented control says about itself', () => {
  it('is no longer reported as a control with no renderer', () => {
    const parsed = doc('<ui:Toggle name="t" label="Sound" />');
    const container = window.document.createElement('div');
    window.document.body.replaceChildren(container);
    const result = render(parsed, container, {
      size: { width: 200, height: 100 },
      measureText,
    });
    expect(result.warnings.filter((w) => w.kind === 'unsupported-control')).toHaveLength(0);
    // Silence is not the claim, though: it says the structure is documented.
    const documented = result.warnings.filter(
      (w) => w.kind === 'version-dependent' && w.message.includes('has been measured'),
    );
    expect(documented).toHaveLength(1);
    expect(documented[0]!.message).toContain('Toggle');
    result.dispose();
  });

  it('separates a documented default from a measured one in provenance', () => {
    const d = doc('<ui:Toggle name="t" />');
    const winner = explainProperty(d, named(d.root, 't'), 'flex-direction').find((c) => c.winner);
    if (winner?.origin.kind !== 'builtin-theme') throw new Error('expected a built-in default');
    expect(winner.origin.selector).toBe('.unity-base-field');
    expect(winner.origin.evidence).toBe('documented');

    const button = doc('<ui:Button name="b" text="OK" />');
    const measured = explainProperty(button, named(button.root, 'b'), 'margin-left').find(
      (c) => c.origin.kind === 'builtin-theme',
    );
    // The measured theme is unchanged by all this: no `evidence`, and the
    // version it was dumped from.
    if (measured?.origin.kind !== 'builtin-theme') throw new Error('expected the measured theme');
    expect(measured.origin.evidence).toBeUndefined();
  });
});
