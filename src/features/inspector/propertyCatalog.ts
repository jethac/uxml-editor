export type InspectorControlKind = 'length' | 'number' | 'enum' | 'color' | 'asset' | 'text';
export type InspectorStyleSection = 'layout' | 'appearance' | 'typography';

export interface InspectorPropertyDefinition {
  readonly property: string;
  readonly label: string;
  readonly section: InspectorStyleSection;
  readonly kind: InspectorControlKind;
  readonly values?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly keywords?: readonly string[];
}

const LAYOUT_PROPERTIES: readonly InspectorPropertyDefinition[] = [
  length('width', 'Width', 'layout', ['auto']),
  length('height', 'Height', 'layout', ['auto']),
  length('min-width', 'Min width', 'layout', ['auto']),
  length('min-height', 'Min height', 'layout', ['auto']),
  length('max-width', 'Max width', 'layout', ['none']),
  length('max-height', 'Max height', 'layout', ['none']),
  enumeration('position', 'Position', 'layout', ['relative', 'absolute']),
  length('left', 'Left', 'layout', ['auto']),
  length('top', 'Top', 'layout', ['auto']),
  length('right', 'Right', 'layout', ['auto']),
  length('bottom', 'Bottom', 'layout', ['auto']),
  length('margin-left', 'Margin left', 'layout', ['auto']),
  length('margin-top', 'Margin top', 'layout', ['auto']),
  length('margin-right', 'Margin right', 'layout', ['auto']),
  length('margin-bottom', 'Margin bottom', 'layout', ['auto']),
  length('padding-left', 'Padding left', 'layout'),
  length('padding-top', 'Padding top', 'layout'),
  length('padding-right', 'Padding right', 'layout'),
  length('padding-bottom', 'Padding bottom', 'layout'),
  enumeration('flex-direction', 'Flex direction', 'layout', ['row', 'row-reverse', 'column', 'column-reverse']),
  enumeration('justify-content', 'Justify content', 'layout', ['flex-start', 'center', 'flex-end', 'space-between', 'space-around']),
  enumeration('align-items', 'Align items', 'layout', ['auto', 'flex-start', 'center', 'flex-end', 'stretch']),
  number('flex-grow', 'Flex grow', 'layout', 0),
  number('flex-shrink', 'Flex shrink', 'layout', 0),
];

const APPEARANCE_PROPERTIES: readonly InspectorPropertyDefinition[] = [
  color('background-color', 'Background color', 'appearance'),
  { property: 'background-image', label: 'Background image', section: 'appearance', kind: 'asset' },
  number('opacity', 'Opacity', 'appearance', 0, 1),
  enumeration('visibility', 'Visibility', 'appearance', ['visible', 'hidden']),
  length('border-left-width', 'Border left width', 'appearance'),
  length('border-top-width', 'Border top width', 'appearance'),
  length('border-right-width', 'Border right width', 'appearance'),
  length('border-bottom-width', 'Border bottom width', 'appearance'),
  color('border-left-color', 'Border left color', 'appearance'),
  color('border-top-color', 'Border top color', 'appearance'),
  color('border-right-color', 'Border right color', 'appearance'),
  color('border-bottom-color', 'Border bottom color', 'appearance'),
  length('border-top-left-radius', 'Top left radius', 'appearance'),
  length('border-top-right-radius', 'Top right radius', 'appearance'),
  length('border-bottom-left-radius', 'Bottom left radius', 'appearance'),
  length('border-bottom-right-radius', 'Bottom right radius', 'appearance'),
];

const TYPOGRAPHY_PROPERTIES: readonly InspectorPropertyDefinition[] = [
  color('color', 'Color', 'typography'),
  length('font-size', 'Font size', 'typography'),
  { property: '-unity-font', label: 'Font asset', section: 'typography', kind: 'asset' },
  enumeration('-unity-font-style', 'Font style', 'typography', ['normal', 'italic', 'bold', 'bold-and-italic']),
  enumeration('white-space', 'White space', 'typography', ['normal', 'nowrap']),
  enumeration('-unity-text-align', 'Text align', 'typography', [
    'upper-left', 'upper-center', 'upper-right',
    'middle-left', 'middle-center', 'middle-right',
    'lower-left', 'lower-center', 'lower-right',
  ]),
  text('-unity-text-overflow-position', 'Overflow position', 'typography'),
];

export const INSPECTOR_PROPERTIES = Object.freeze([
  ...LAYOUT_PROPERTIES,
  ...APPEARANCE_PROPERTIES,
  ...TYPOGRAPHY_PROPERTIES,
]);

export function propertiesForSection(section: InspectorStyleSection): readonly InspectorPropertyDefinition[] {
  return INSPECTOR_PROPERTIES.filter((definition) => definition.section === section);
}

export function validateInspectorValue(definition: InspectorPropertyDefinition, value: string): string | null {
  if (value.length === 0) return 'A complete value is required.';
  if (definition.kind === 'length') {
    if (definition.keywords?.includes(value)) return null;
    return /^(?:0|-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|%|em|rem))$/.test(value)
      ? null
      : 'Use a complete supported length: px, %, em, rem, or an available keyword.';
  }
  if (definition.kind === 'number') {
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return 'Use a complete number.';
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (definition.minimum !== undefined && parsed < definition.minimum)
      || (definition.maximum !== undefined && parsed > definition.maximum)) {
      return `Use a number${definition.minimum === undefined ? '' : ` at least ${definition.minimum}`}${definition.maximum === undefined ? '' : ` and at most ${definition.maximum}`}.`;
    }
    return null;
  }
  if (definition.kind === 'enum') {
    return definition.values?.includes(value) ? null : 'Choose an available value.';
  }
  if (definition.kind === 'color') {
    return isColor(value) ? null : 'Use a complete hex, rgb, rgba, or supported named color.';
  }
  if (definition.kind === 'asset') {
    return isAsset(value) ? null : 'Use none, url("Assets/..."), or resource("Name").';
  }
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value) ? 'The value contains unsupported control characters.' : null;
}

export function colorSwatchValue(value: string): string {
  return isColor(value) ? value : 'transparent';
}

function length(
  property: string,
  label: string,
  section: InspectorStyleSection,
  keywords: readonly string[] = [],
): InspectorPropertyDefinition {
  return { property, label, section, kind: 'length', keywords: Object.freeze([...keywords]) };
}

function number(
  property: string,
  label: string,
  section: InspectorStyleSection,
  minimum?: number,
  maximum?: number,
): InspectorPropertyDefinition {
  return { property, label, section, kind: 'number', ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) };
}

function enumeration(
  property: string,
  label: string,
  section: InspectorStyleSection,
  values: readonly string[],
): InspectorPropertyDefinition {
  return { property, label, section, kind: 'enum', values: Object.freeze([...values]) };
}

function color(property: string, label: string, section: InspectorStyleSection): InspectorPropertyDefinition {
  return { property, label, section, kind: 'color' };
}

function text(property: string, label: string, section: InspectorStyleSection): InspectorPropertyDefinition {
  return { property, label, section, kind: 'text' };
}

function isColor(value: string): boolean {
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return true;
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(value);
  if (rgb !== null) return rgb.slice(1).every((channel) => Number(channel) <= 255);
  const rgba = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d+(?:\.\d+)?|\.\d+)\s*\)$/.exec(value);
  if (rgba !== null) {
    return rgba.slice(1, 4).every((channel) => Number(channel) <= 255)
      && Number(rgba[4]) >= 0
      && Number(rgba[4]) <= 1;
  }
  return ['transparent', 'black', 'white', 'red', 'green', 'blue', 'gray', 'grey', 'yellow', 'magenta', 'cyan'].includes(value.toLowerCase());
}

function isAsset(value: string): boolean {
  if (value === 'none') return true;
  const match = /^(?:url|resource)\((['"])([^'"\r\n]+)\1\)$/.exec(value);
  if (match === null) return false;
  const path = match[2];
  return path.trim() === path && !path.includes('..') && !/^[a-z]+:\/\//i.test(path);
}
