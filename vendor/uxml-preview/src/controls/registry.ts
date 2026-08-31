/**
 * Which controls have a renderer of their own, and what everything else falls
 * back to.
 *
 * The model does not carry this: whether a control has a renderer is a property
 * of this layer, and it changes when controls are added, while the file that was
 * parsed does not. Adding `ScrollView` means editing this table and nothing in
 * src/model or src/parser.
 *
 * `resolveControl` never returns null, and that is the point. An unrecognised
 * tag is drawn as a plain box rather than dropped — losing a whole subtree to
 * one unknown control is a defect, not a scope limit (S1 plan §6). Returning a
 * spec unconditionally makes the fallback the path a caller gets by default:
 * there is no miss to forget to handle.
 */

import type { ElementNode } from '../model/types';

/**
 * An element a control builds for itself, which the file never mentions.
 *
 * Unity's ScrollView is one tag that becomes four elements, and the three it
 * adds are what decide where everything inside lands — a child of a ScrollView
 * is not a child of the ScrollView. Reproducing the box without them puts every
 * descendant in the wrong place, so they are modelled rather than approximated.
 *
 * `name` is Unity's own, and it is the key the layout dump joins on: these are
 * observed in `tests/golden/unity/scrollview-*.json`, not invented.
 */
export interface ControlPart {
  /**
   * Key for this part within its control, and what the painter labels it with.
   * Unity's own name where the element has one.
   */
  name: string;
  /**
   * Unity's element name, when the control gives the part one. Only this is
   * matched by `#id` selectors.
   *
   * Separate from `name` because most parts have no name in Unity at all — they
   * are reached through their classes. Letting `name` answer `#id` would make
   * `#toggle-input` match here and nowhere in Unity, which is a worse answer
   * than no match.
   */
  id?: string;
  /**
   * The part this one sits inside, by name; absent means directly inside the
   * control.
   *
   * A chain was enough while ScrollView was the only composite: its four
   * elements nest one inside the next. Nothing else in Unity is shaped that
   * way. A Toggle's label and its input are *siblings*, so a chain has to pick
   * one to put the other inside, and every coordinate below the loser is then
   * wrong by the winner's size. Parts are a tree because the controls are.
   */
  parent?: string;
  /**
   * USS classes Unity's constructor puts on this part.
   *
   * These are the selectors an author actually writes — a Toggle is styled
   * through `.unity-toggle__input`, not through the element — so a part with no
   * classes is a part author USS cannot reach.
   */
  classes?: readonly string[];
  /**
   * Attribute whose value this part draws as its text.
   *
   * `BaseField` keeps its caption in a `Label` child rather than drawing it
   * itself, which is why `<ui:Toggle label="Sound" />` used to lose the word
   * "Sound" entirely. The part that is that `Label` names the attribute here.
   */
  textFrom?: 'text' | 'label' | 'value';
  /**
   * USS this part always carries, because the control fixes it.
   *
   * Written as USS rather than as CSS or Yoga calls so it goes through the same
   * cascade output, Yoga mapping and CSS mapping as everything else. A second
   * styling path for parts would be a second set of USS bugs.
   */
  style: Readonly<Record<string, string>>;
}

/**
 * How a control's structure was established.
 *
 * `measured` means a Unity layout dump in `tests/golden/unity/` decided it.
 * `documented` means Unity's own published class names and hierarchy decided
 * it and nothing has been measured — the distinction the theme file makes for
 * values, made for structure, so a preview can say which it is showing rather
 * than presenting both with the same confidence.
 */
export type ControlEvidence = 'measured' | 'documented';

export interface ControlSpec {
  /** Renders the `text` attribute as its own content. */
  hasText: boolean;
  /**
   * Elements the control inserts between itself and the file's children.
   * Parents appear before their children, so one pass can build the tree.
   */
  parts: readonly ControlPart[];
  /**
   * Part the file's children go inside, by name — Unity's `contentContainer`.
   * `null` puts them in the control itself, beside its parts, which is what
   * every `BaseField` does. Absent defaults to the last part.
   */
  content?: string | null;
  /**
   * USS classes Unity's own constructor puts on this control, which the theme
   * stylesheet then targets. Not in the `class` attribute and not in the model:
   * the file says `<ui:Button />` and Unity adds the rest.
   */
  classes: readonly string[];
  evidence: ControlEvidence;
}

export interface ResolvedControl {
  spec: ControlSpec;
  /**
   * No renderer of its own; drawn as a plain `VisualElement`. Callers report
   * this once per element so the preview says what it did (CLAUDE.md rule 6).
   */
  fallback: boolean;
}

/**
 * Controls with a renderer of their own.
 *
 * `Label` and `Button` derive from `TextElement` in Unity, which is why they
 * draw text themselves instead of holding a child that does.
 *
 * `evidence` is what replaced "nothing may be added here without a golden case"
 * (S1 plan §5.2). That rule kept the five measured controls honest and, with no
 * Unity to dump from, also kept every other control a fallback box — which is
 * not the safer answer it looks like: an author gets a plain rectangle, no
 * caption, and a warning that says the control is unsupported, when its
 * structure is published and reproducible. A `documented` control draws what
 * Unity documents and says so, once, through `version-dependent`. Promoting one
 * to `measured` still needs a golden case, and that is the only thing that ever
 * makes a control silent.
 */
const CONTROLS: Readonly<Record<string, ControlSpec>> = {
  // VisualElement is the base class and carries no class of its own.
  VisualElement: { hasText: false, classes: [], parts: [], evidence: 'measured' },
  Label: { hasText: true, classes: ['unity-label'], parts: [], evidence: 'measured' },
  Button: { hasText: true, classes: ['unity-button'], parts: [], evidence: 'measured' },
  // Image draws a texture, not text. Its picture reaches this renderer through
  // `background-image` in USS, which `resolveAsset` can turn into something a
  // browser will load; a texture assigned from C# has no path to follow here.
  Image: { hasText: false, classes: ['unity-image'], parts: [], evidence: 'measured' },
  /**
   * Four elements from one tag. The names below are observed in
   * `tests/golden/unity/scrollview-*.json`, not taken from documentation — the
   * middle one, `unity-content-and-vertical-scroll-container`, is not in
   * Unity's manual diagram at all and was found by dumping.
   *
   * The styles are inference, unlike the names: they are how this renderer
   * reproduces the measured geometry, and the three `scrollview-*` golden cases
   * are what decides whether the inference is right.
   */
  ScrollView: {
    hasText: false,
    classes: ['unity-scroll-view'],
    evidence: 'measured',
    content: 'unity-content-container',
    parts: [
      // Fills the ScrollView's content box, and lays the viewport out beside
      // the vertical scrollbar — hence row.
      {
        name: 'unity-content-and-vertical-scroll-container',
        id: 'unity-content-and-vertical-scroll-container',
        classes: ['unity-scroll-view__content-and-vertical-scroll-container'],
        style: { 'flex-grow': '1', 'flex-direction': 'row' },
      },
      // What actually clips. Takes whatever width the scrollbar leaves.
      {
        name: 'unity-content-viewport',
        id: 'unity-content-viewport',
        parent: 'unity-content-and-vertical-scroll-container',
        classes: ['unity-scroll-view__content-viewport'],
        style: { 'flex-grow': '1', overflow: 'hidden' },
      },
      // `flex-shrink: 0` is the whole reason a ScrollView is not one box:
      // this grows to the content's height instead of being squeezed into the
      // viewport's, so children keep their sizes and the viewport crops them.
      // Without it three 60px children in a 100px view come out 33/34/33.
      {
        name: 'unity-content-container',
        id: 'unity-content-container',
        parent: 'unity-content-viewport',
        classes: ['unity-scroll-view__content-container'],
        style: { 'flex-shrink': '0' },
      },
    ],
  },
  /**
   * `BaseField` in two shapes, and the reason parts became a tree.
   *
   * Both are `documented`: the class names are Unity's published
   * `ussClassName` constants and the label-beside-input hierarchy is what
   * Unity's manual describes, but no dump has confirmed a single coordinate.
   * What that buys over the fallback box is the caption — `label` and `value`
   * are drawn by child elements in Unity, so a fallback loses the words
   * altogether — and the `.unity-base-field__label` selectors an author has to
   * write to size the two columns.
   *
   * `content: null` because a `BaseField` appends children to itself, beside
   * its label and input, rather than into either of them.
   */
  Toggle: {
    hasText: false,
    classes: ['unity-toggle', 'unity-base-field'],
    evidence: 'documented',
    content: null,
    parts: [
      {
        name: 'toggle-label',
        classes: ['unity-base-field__label', 'unity-toggle__label'],
        textFrom: 'label',
        style: { 'flex-shrink': '0' },
      },
      {
        name: 'toggle-input',
        classes: ['unity-base-field__input', 'unity-toggle__input'],
        style: { 'flex-grow': '1', 'flex-direction': 'row' },
      },
      // Unity names this one, so `#unity-checkmark` reaches it in both engines.
      {
        name: 'unity-checkmark',
        id: 'unity-checkmark',
        parent: 'toggle-input',
        classes: ['unity-toggle__checkmark'],
        style: {},
      },
    ],
  },
  /**
   * The one documented control whose children do not go on the control: a
   * Foldout holds them in `#unity-content`, so `content` names it and the
   * header is a sibling of that. A fallback box put them above the header and
   * left the caption undrawn.
   *
   * Its header is a Toggle in Unity, which this describes as parts of the
   * Foldout rather than by nesting one control's spec inside another's — a spec
   * that expanded other specs would have two ways to build the same tree, and
   * the geometry to reconcile between them is geometry nothing here has
   * measured.
   */
  Foldout: {
    hasText: false,
    classes: ['unity-foldout'],
    evidence: 'documented',
    content: 'unity-content',
    parts: [
      {
        name: 'foldout-toggle',
        classes: ['unity-foldout__toggle', 'unity-toggle', 'unity-base-field'],
        style: {},
      },
      {
        name: 'unity-checkmark',
        id: 'unity-checkmark',
        parent: 'foldout-toggle',
        classes: ['unity-toggle__checkmark'],
        style: { 'flex-shrink': '0' },
      },
      {
        name: 'foldout-text',
        parent: 'foldout-toggle',
        classes: ['unity-foldout__text', 'unity-toggle__text'],
        textFrom: 'text',
        style: {},
      },
      {
        name: 'unity-content',
        id: 'unity-content',
        classes: ['unity-foldout__content'],
        style: {},
      },
    ],
  },
  /**
   * Drawn for its caption and its selected value, both of which a fallback box
   * loses. The arrow is a part with no style of its own: Unity draws it from a
   * theme background image this has no access to, so it is here to be styled
   * and to hold its place, not to look like Unity's.
   */
  DropdownField: {
    hasText: false,
    classes: ['unity-dropdown-field', 'unity-base-popup-field', 'unity-base-field'],
    evidence: 'documented',
    content: null,
    parts: [
      {
        name: 'dropdown-label',
        classes: [
          'unity-base-field__label',
          'unity-base-popup-field__label',
          'unity-dropdown-field__label',
        ],
        textFrom: 'label',
        style: { 'flex-shrink': '0' },
      },
      {
        name: 'dropdown-input',
        classes: [
          'unity-base-field__input',
          'unity-base-popup-field__input',
          'unity-dropdown-field__input',
        ],
        style: { 'flex-grow': '1', 'flex-direction': 'row' },
      },
      {
        name: 'dropdown-text',
        parent: 'dropdown-input',
        classes: ['unity-base-popup-field__text'],
        textFrom: 'value',
        style: { 'flex-grow': '1' },
      },
      {
        name: 'dropdown-arrow',
        parent: 'dropdown-input',
        classes: ['unity-base-popup-field__arrow'],
        style: { 'flex-shrink': '0' },
      },
    ],
  },
  TextField: {
    hasText: false,
    classes: ['unity-text-field', 'unity-base-text-field', 'unity-base-field'],
    evidence: 'documented',
    content: null,
    parts: [
      {
        name: 'text-field-label',
        classes: [
          'unity-base-field__label',
          'unity-base-text-field__label',
          'unity-text-field__label',
        ],
        textFrom: 'label',
        style: { 'flex-shrink': '0' },
      },
      // The typed text is the `value` attribute, and Unity draws it in here.
      {
        name: 'unity-text-input',
        id: 'unity-text-input',
        classes: [
          'unity-base-field__input',
          'unity-base-text-field__input',
          'unity-text-field__input',
        ],
        textFrom: 'value',
        style: { 'flex-grow': '1' },
      },
    ],
  },
  IntegerField: textField('integer'),
  FloatField: textField('float'),
  Slider: slider('slider'),
  SliderInt: slider('slider-int'),
};

/**
 * A `BaseTextField` that differs from `TextField` only in the middle term of
 * its class names. Written as a function because an author styling an
 * `IntegerField` writes `.unity-integer-field__input`, so the names cannot be
 * shared, while the tree can.
 */
function textField(kind: string): ControlSpec {
  return {
    hasText: false,
    classes: [`unity-${kind}-field`, 'unity-base-text-field', 'unity-base-field'],
    evidence: 'documented',
    content: null,
    parts: [
      {
        name: `${kind}-field-label`,
        classes: [
          'unity-base-field__label',
          'unity-base-text-field__label',
          `unity-${kind}-field__label`,
        ],
        textFrom: 'label',
        style: { 'flex-shrink': '0' },
      },
      {
        name: 'unity-text-input',
        id: 'unity-text-input',
        classes: [
          'unity-base-field__input',
          'unity-base-text-field__input',
          `unity-${kind}-field__input`,
        ],
        textFrom: 'value',
        style: { 'flex-grow': '1' },
      },
    ],
  };
}

/**
 * A `BaseSlider`, drawn as its two columns and the track inside the right one.
 *
 * The dragger is a part with no offset: where along the track it sits is a
 * function of `value`, `low-value` and `high-value` against a track width
 * nothing here has measured, so it is drawn at the track's start rather than at
 * a position invented for it. Its classes are there so author USS can size and
 * colour it.
 */
function slider(kind: string): ControlSpec {
  return {
    hasText: false,
    classes: [
      `unity-${kind}`,
      'unity-base-slider',
      'unity-base-slider--horizontal',
      'unity-base-field',
    ],
    evidence: 'documented',
    content: null,
    parts: [
      {
        name: `${kind}-label`,
        classes: ['unity-base-field__label', 'unity-base-slider__label', `unity-${kind}__label`],
        textFrom: 'label',
        style: { 'flex-shrink': '0' },
      },
      {
        name: `${kind}-input`,
        classes: ['unity-base-field__input', 'unity-base-slider__input', `unity-${kind}__input`],
        style: { 'flex-grow': '1', 'flex-direction': 'row' },
      },
      {
        name: `${kind}-drag-container`,
        parent: `${kind}-input`,
        classes: ['unity-base-slider__drag-container'],
        style: { 'flex-grow': '1', 'justify-content': 'center' },
      },
      {
        name: `${kind}-tracker`,
        parent: `${kind}-drag-container`,
        classes: ['unity-base-slider__tracker', `unity-${kind}__tracker`],
        style: {},
      },
      {
        name: `${kind}-dragger`,
        parent: `${kind}-drag-container`,
        classes: ['unity-base-slider__dragger', `unity-${kind}__dragger`],
        style: { position: 'absolute' },
      },
    ],
  };
}

/**
 * What an unrecognised control is drawn as: a box that lays its children out.
 *
 * `hasText: false` is deliberate. The controls most likely to land here —
 * `ListView`, `MinMaxSlider`, `Vector3Field` — put their label in a child
 * `TextElement` rather than drawing it themselves, so guessing `true` would
 * paint text where Unity paints a child and put every coordinate below it in
 * the wrong place. The way to get those captions drawn is a `documented` entry
 * in the table above, not a truer guess here.
 */
const FALLBACK: ControlSpec = {
  hasText: false,
  classes: [],
  parts: [],
  evidence: 'measured',
};

/** The document container. Not a control, but it is the panel's root box. */
export const ROOT_LOCAL_NAME = 'UXML';

/**
 * Elements that carry instructions rather than pixels.
 *
 * `<Style src="…">` is how a UXML names its stylesheet, and UI Builder writes
 * one into the file the moment you attach a USS — so it is the normal shape of
 * a real document, not an optional flourish. It is not a control: drawing it as
 * a fallback box would add a phantom element to the layout and report it as an
 * unsupported control, which points at the wrong problem entirely.
 */
const NON_VISUAL = new Set(['Style']);

export function isNonVisual(node: ElementNode): boolean {
  return NON_VISUAL.has(node.name.local);
}

/**
 * Purpose:      the spec to draw `node` with, always.
 * Ensures:      never null. `fallback` is true only for elements a caller
 *               should report; the root is excluded because it is the panel
 *               box rather than a control that failed to resolve.
 */
export function resolveControl(node: ElementNode): ResolvedControl {
  if (node.derived?.kind === 'template-container') return { spec: FALLBACK, fallback: false };
  const spec = CONTROLS[node.name.local];
  if (spec !== undefined) return { spec, fallback: false };
  if (isRoot(node)) return { spec: FALLBACK, fallback: false };
  return { spec: FALLBACK, fallback: true };
}

export function isRoot(node: ElementNode): boolean {
  return node.name.local === ROOT_LOCAL_NAME;
}

/**
 * Purpose:      the USS classes Unity would have added to this element.
 * Ensures:      empty for anything with no renderer of its own — a fallback box
 *               must not pick up theme styling meant for a control we do not
 *               actually draw.
 */
export function implicitClassesOf(node: ElementNode): readonly string[] {
  return resolveControl(node).spec.classes;
}

/**
 * Purpose:      the part named `name` of `node`'s control, or undefined.
 * Ensures:      the one place a part name is turned back into its spec, so
 *               layout, cascade and paint agree about a part's parent, classes
 *               and fixed style.
 */
export function partNamed(node: ElementNode, name: string): ControlPart | undefined {
  return resolveControl(node).spec.parts.find((part) => part.name === name);
}

/**
 * Purpose:      the part `node`'s children belong in, or undefined for the
 *               element itself.
 */
export function contentPartOf(spec: ControlSpec): string | undefined {
  if (spec.content === null) return undefined;
  if (spec.content !== undefined) return spec.content;
  return spec.parts.at(-1)?.name;
}

/** Controls with a renderer of their own. Everything else still draws. */
export function supportedControlNames(): string[] {
  return Object.keys(CONTROLS);
}
